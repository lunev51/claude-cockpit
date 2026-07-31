// ES-модуль. Захват микрофона через AudioWorklet → Float32-чанки → WAV.

export class VoiceRecorder {
  #stream    = null;
  #ctx       = null;
  #source    = null;
  #worklet   = null;
  #chunks    = [];
  #recording = false;

  get recording() {
    return this.#recording;
  }

  async start() {
    if (this.#recording) return;

    this.#chunks = [];

    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    // ОТЛИЧИЕ ОТ ЭТАЛОНА Companion (I3, ревью финальной волны фазы 9 кокпита):
    // getUserMedia выше уже открыл поток микрофона. Если что-то НИЖЕ (создание
    // AudioContext, загрузка воркутлета) бросит — например, устройство
    // отключили/переключили ПРЯМО в этот момент (выключенная Bluetooth-
    // гарнитура) — #stream остаётся присвоенным полю, но НЕДОСТИЖИМЫМ снаружи:
    // start() выбросит раньше, чем #recording станет true, а stop() (единственный
    // код, умеющий закрывать #stream) молча не сработает, т.к. проверяет ИМЕННО
    // #recording. Микрофон Windows горел бы до перезапуска окна при потухшем
    // индикаторе кокпита. try/catch — единственная функциональная правка этой
    // копии (байт-в-байт сверка с оригиналом Companion сделала своё дело при
    // портировании Task 3 — остальной код 1-в-1): на любой сбой останавливаем
    // уже открытые треки, закрываем контекст (если успел создаться), обнуляем
    // поля и пробрасываем исходную ошибку — вызывающий код (recorder.start() в
    // app.js) видит тот же reject, что и раньше, просто без утечки.
    try {
      this.#ctx = new AudioContext({ sampleRate: 16000 });

      // Worklet-модуль загружается в КАЖДЫЙ новый контекст:
      // stop() закрывает контекст, и регистрация процессора умирает вместе с ним.
      await this.#ctx.audioWorklet.addModule('./js/voice/pcm-worklet.js');

      this.#source  = this.#ctx.createMediaStreamSource(this.#stream);
      this.#worklet = new AudioWorkletNode(this.#ctx, 'pcm-capture');

      this.#worklet.port.onmessage = (e) => {
        if (this.#recording) this.#chunks.push(e.data);
      };

      this.#source.connect(this.#worklet);
      this.#worklet.connect(this.#ctx.destination);
    } catch (err) {
      for (const track of this.#stream.getTracks()) track.stop();
      this.#stream = null;
      if (this.#ctx) {
        try { await this.#ctx.close(); } catch (_) {}
        this.#ctx = null;
      }
      throw err;
    }

    this.#recording = true;
  }

  async stop() {
    if (!this.#recording) return null;
    this.#recording = false;

    // Отключаем граф
    try { this.#worklet.disconnect(); } catch (_) {}
    try { this.#source.disconnect();  } catch (_) {}

    // Останавливаем треки
    if (this.#stream) {
      for (const track of this.#stream.getTracks()) track.stop();
      this.#stream = null;
    }

    // Закрываем контекст
    if (this.#ctx) {
      try { await this.#ctx.close(); } catch (_) {}
      this.#ctx = null;
    }

    const chunks = this.#chunks;
    this.#chunks = [];

    // Считаем суммарную длину в секундах (sampleRate = 16000)
    const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalSamples < 16000 * 0.3) return null; // < 0.3 с — игнор

    return encodeWav(chunks, totalSamples, 16000);
  }
}

// ---------------------------------------------------------------------------
// Кодирование WAV: RIFF / PCM 16-bit mono
// ---------------------------------------------------------------------------
export function encodeWav(chunks, totalSamples, sampleRate) {
  const bytesPerSample = 2; // Int16
  const numChannels    = 1;
  const dataLen        = totalSamples * bytesPerSample;
  const headerLen      = 44;
  const buffer         = new ArrayBuffer(headerLen + dataLen);
  const view           = new DataView(buffer);

  function writeStr(off, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }

  // RIFF chunk
  writeStr(0,  'RIFF');
  view.setUint32(4,  36 + dataLen, true);   // ChunkSize
  writeStr(8,  'WAVE');

  // fmt  sub-chunk
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);             // Subchunk1Size (PCM)
  view.setUint16(20, 1,  true);             // AudioFormat = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true);              // BlockAlign
  view.setUint16(34, 16, true);             // BitsPerSample

  // data sub-chunk
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  // Записываем PCM-данные (Float32 → Int16LE)
  let offset = headerLen;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}
