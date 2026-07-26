// ES-модуль. Непрерывное прослушивание микрофона с энергетическим VAD:
// выделяет сегменты речи и отдаёт их как WAV-буферы (16 кГц, mono, PCM16).

import { encodeWav } from './recorder.js';

export class WakeListener {
  #stream  = null;
  #ctx     = null;
  #source  = null;
  #worklet = null;
  #running = false;
  #paused  = false;

  // --- VAD-параметры (RMS, миллисекунды) ---
  #vadThreshold;
  #silenceMs;
  #maxSegmentMs;
  #minSegmentMs;
  #preRollMs;

  // --- состояние конечного автомата ---
  #state        = 'idle';  // 'idle' | 'recording'
  #voiceRun     = 0;       // подряд идущих окон с RMS > threshold
  #segChunks    = [];      // накопленные Float32-чанки активного сегмента
  #segSamples   = 0;       // суммарное число сэмплов сегмента
  #silenceMsAcc = 0;       // накопленная тишина (мс) внутри сегмента
  #preRoll      = [];      // кольцевой буфер preRoll-чанков
  #preRollSamp  = 0;       // сэмплов в кольцевом буфере
  #lastVoice    = false;   // последнее решение VAD (для onVoiceState)

  static SAMPLE_RATE = 16000;

  /**
   * @param {object} opts
   * @param {(wav: ArrayBuffer) => void} opts.onSegment
   * @param {(state: 'idle'|'voice') => void} [opts.onVoiceState]
   * @param {number} [opts.vadThreshold]
   * @param {number} [opts.silenceMs]
   * @param {number} [opts.maxSegmentMs]
   * @param {number} [opts.minSegmentMs]
   * @param {number} [opts.preRollMs]
   */
  constructor({
    onSegment,
    onVoiceState,
    vadThreshold = 0.012,
    silenceMs    = 800,
    maxSegmentMs = 6000,
    minSegmentMs = 400,
    preRollMs    = 300,
  } = {}) {
    this._onSegment    = onSegment;
    this._onVoiceState = onVoiceState ?? null;
    this.#vadThreshold = vadThreshold;
    this.#silenceMs    = silenceMs;
    this.#maxSegmentMs = maxSegmentMs;
    this.#minSegmentMs = minSegmentMs;
    this.#preRollMs    = preRollMs;
  }

  get running() {
    return this.#running;
  }

  /** Запустить захват. Бросает при отказе микрофона — вызывающий обработает. */
  async start() {
    if (this.#running) return;

    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    this.#ctx = new AudioContext({ sampleRate: WakeListener.SAMPLE_RATE });

    // Worklet регистрируется в КАЖДЫЙ новый контекст (закрытие убивает процессор).
    await this.#ctx.audioWorklet.addModule('./js/voice/pcm-worklet.js');

    this.#source  = this.#ctx.createMediaStreamSource(this.#stream);
    this.#worklet = new AudioWorkletNode(this.#ctx, 'pcm-capture');

    this.#worklet.port.onmessage = (e) => this.#onChunk(e.data);

    this.#source.connect(this.#worklet);
    this.#worklet.connect(this.#ctx.destination);

    this.#reset();
    this.#running = true;
  }

  /** Остановить захват, освободить ресурсы, сбросить состояние. */
  async stop() {
    if (!this.#running) return;
    this.#running = false;

    try { this.#worklet.disconnect(); } catch (_) {}
    try { this.#source.disconnect();  } catch (_) {}

    if (this.#stream) {
      for (const track of this.#stream.getTracks()) track.stop();
      this.#stream = null;
    }
    if (this.#ctx) {
      try { await this.#ctx.close(); } catch (_) {}
      this.#ctx = null;
    }
    this.#worklet = null;
    this.#source  = null;
    this.#reset();
  }

  /** Пауза: входящие чанки игнорируются, состояние сбрасывается в idle. */
  setPaused(v) {
    const on = !!v;
    if (on === this.#paused) return;
    this.#paused = on;
    if (on) this.#reset();
  }

  // ------------------------------------------------------------------ private

  #reset() {
    this.#state        = 'idle';
    this.#voiceRun     = 0;
    this.#segChunks    = [];
    this.#segSamples   = 0;
    this.#silenceMsAcc = 0;
    this.#preRoll      = [];
    this.#preRollSamp  = 0;
    if (this.#lastVoice) {
      this.#lastVoice = false;
      this._onVoiceState?.('idle');
    }
  }

  #onChunk(chunk) {
    if (!this.#running || this.#paused) return;

    const sr      = WakeListener.SAMPLE_RATE;
    const samples = chunk.length;
    const ms      = (samples / sr) * 1000;

    // RMS по окну (чанк worklet'а ≈ 128 сэмплов ≈ 8 мс — достаточно мелкое окно).
    let sum = 0;
    for (let i = 0; i < samples; i++) sum += chunk[i] * chunk[i];
    const rms   = Math.sqrt(sum / samples);
    const voice = rms > this.#vadThreshold;

    if (this.#state === 'idle') {
      // Кольцевой preRoll-буфер.
      this.#preRoll.push(chunk);
      this.#preRollSamp += samples;
      const maxPre = (this.#preRollMs / 1000) * sr;
      while (this.#preRollSamp > maxPre && this.#preRoll.length > 0) {
        this.#preRollSamp -= this.#preRoll[0].length;
        this.#preRoll.shift();
      }

      if (voice) {
        this.#voiceRun++;
        if (this.#voiceRun >= 3) {
          // Старт сегмента: включаем preRoll.
          this.#state        = 'recording';
          this.#segChunks    = this.#preRoll.slice();
          this.#segSamples   = this.#preRollSamp;
          this.#silenceMsAcc = 0;
          this.#preRoll      = [];
          this.#preRollSamp  = 0;
          this.#setVoice(true);
        }
      } else {
        this.#voiceRun = 0;
      }
      return;
    }

    // state === 'recording'
    this.#segChunks.push(chunk);
    this.#segSamples += samples;

    if (voice) {
      this.#silenceMsAcc = 0;
    } else {
      this.#silenceMsAcc += ms;
    }

    const segMs = (this.#segSamples / sr) * 1000;
    if (this.#silenceMsAcc >= this.#silenceMs || segMs >= this.#maxSegmentMs) {
      this.#finishSegment();
    }
  }

  #finishSegment() {
    const sr     = WakeListener.SAMPLE_RATE;
    const chunks = this.#segChunks;
    const total  = this.#segSamples;

    this.#state = 'idle';
    this.#voiceRun = 0;
    this.#segChunks = [];
    this.#segSamples = 0;
    this.#silenceMsAcc = 0;
    // Хвост завершённого сегмента — преролл следующего: иначе начало
    // новой фразы (первые чанки) срезается, пока копится voiceRun.
    this.#preRoll = chunks.slice(-4);
    this.#preRollSamp = this.#preRoll.reduce((a, c) => a + c.length, 0);
    this.#setVoice(false);

    const segMs = (total / sr) * 1000;
    if (segMs >= this.#minSegmentMs && total > 0) {
      try {
        const wav = encodeWav(chunks, total, sr);
        this._onSegment?.(wav);
      } catch (err) {
        console.warn('[wake] encodeWav error:', err);
      }
    }
  }

  #setVoice(on) {
    if (on === this.#lastVoice) return;
    this.#lastVoice = on;
    this._onVoiceState?.(on ? 'voice' : 'idle');
  }
}
