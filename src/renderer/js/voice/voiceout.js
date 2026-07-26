// Воспроизведение TTS-ответов: очередь WAV-буферов → Web Audio API → липсинк.

export class VoiceOut {
  /**
   * @param {object} opts
   * @param {() => import('../avatar/lipsync.js').LipSync | null} opts.getLipsync
   * @param {(text: string) => void} opts.onStatus
   * @param {(text: string) => void} [opts.onUtterance]  — вызывается при старте каждого элемента
   */
  constructor({ getLipsync, onStatus, onUtterance }) {
    this._getLipsync   = getLipsync;
    this._onStatus     = onStatus;
    this._onUtterance  = onUtterance ?? null;
    this._ctx          = null;   // AudioContext — создаётся лениво
    this._queue        = [];     // { wavBytes: Uint8Array, text: string }[]
    this._playing      = false;
    this._current      = null;   // текущий AudioBufferSourceNode
    this._gainNode     = null;   // мастер-гейн
    this._volume       = 0.9;    // текущая громкость (0..1)
    this._mutedVolume  = null;   // сохранённая громкость на время мута; null = не в муте
    this._gen          = 0;      // поколение: stopAll() инкрементит, отменяя decode в полёте
  }

  /** true, пока очередь не пуста или играет источник. */
  get speaking() {
    return this._playing || this._queue.length > 0 || this._current !== null;
  }

  /** Текущая громкость (0..1). */
  get volume() {
    return this._volume;
  }

  /** Установить громкость (0..1); снимает мут, если был. */
  setVolume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    this._mutedVolume = null; // снимаем мут при явном изменении громкости
    if (this._gainNode) this._gainNode.gain.value = this._volume;
  }

  /** Переключить мут. Возвращает новое состояние: true = замьючено. */
  toggleMute() {
    if (this._mutedVolume !== null) {
      // снять мут — вернуть прежнюю громкость
      this._volume = this._mutedVolume;
      this._mutedVolume = null;
      if (this._gainNode) this._gainNode.gain.value = this._volume;
      return false;
    } else {
      // включить мут
      this._mutedVolume = this._volume;
      if (this._gainNode) this._gainNode.gain.value = 0;
      return true;
    }
  }

  /** true, если сейчас замьючено. */
  get muted() {
    return this._mutedVolume !== null;
  }

  /**
   * Добавить WAV-байты (текст субтитра и эмоция — опциональны).
   * Обратно совместимо: enqueue(wavBytes) работает как прежде.
   */
  enqueue(wavBytes, text = '', emotion = 'neutral') {
    this._queue.push({ wavBytes, text, emotion });
    if (!this._playing) this._playNext();
  }

  /** Остановить всё немедленно. */
  stopAll() {
    this._gen++; // отменяем decode/start, который сейчас в полёте
    this._queue = [];
    if (this._current) {
      try { this._current.stop(); } catch { /* уже остановлен */ }
      this._current = null;
    }
    const ls = this._getLipsync();
    if (ls) ls.stop();
    this._playing = false;
    this._onStatus('🔊 —');
  }

  // ------------------------------------------------------------------ private

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new AudioContext(); // без sampleRate — системный
    }
    return this._ctx;
  }

  async _playNext() {
    if (this._queue.length === 0) {
      this._playing = false;
      this._onStatus('🔊 —');
      return;
    }

    this._playing = true;
    this._onStatus('🔊 говорю…');

    const { wavBytes, text, emotion } = this._queue.shift();

    // Уведомляем о начале произношения (субтитры + эмоция лица)
    if (this._onUtterance) this._onUtterance(text, emotion);

    // Запоминаем поколение до await: если за время decode вызвали stopAll(),
    // поколение изменится — тогда не стартуем уже устаревший источник.
    const gen = this._gen;

    let audioBuffer;
    try {
      // Uint8Array может быть срезом SharedArrayBuffer / Buffer Node.js —
      // делаем собственную копию ArrayBuffer через byteOffset/byteLength.
      const ab = wavBytes.buffer.slice(
        wavBytes.byteOffset,
        wavBytes.byteOffset + wavBytes.byteLength,
      );
      const ctx = this._getCtx();
      audioBuffer = await ctx.decodeAudioData(ab);
    } catch (err) {
      console.warn('[voiceout] ошибка декода WAV, пропускаю:', err);
      this._playNext(); // пропустить сломанный элемент
      return;
    }

    // stopAll() во время decode — этот источник устарел, не запускаем.
    if (gen !== this._gen) { this._playNext(); return; }

    const ctx    = this._getCtx();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    // Мастер-гейн для управления громкостью и мутом
    if (!this._gainNode || this._gainNode.context !== ctx) {
      this._gainNode = ctx.createGain();
      this._gainNode.connect(ctx.destination);
    }
    this._gainNode.gain.value = this._mutedVolume !== null ? 0 : this._volume;

    source.connect(this._gainNode);

    const ls = this._getLipsync();
    if (ls) ls.attach(ctx, source);

    this._current = source;

    source.onended = () => {
      const lsEnd = this._getLipsync();
      if (lsEnd) lsEnd.stop();
      this._current = null;
      this._playNext();
    };

    source.start();
  }
}
