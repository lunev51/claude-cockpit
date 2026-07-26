// Липсинк: RMS-амплитуда из AnalyserNode → визема 'aa'.
// Анализатор подключается параллельно (sourceNode → analyser),
// к destination звук подключается снаружи.

const ATTACK_TAU = 0.04;   // быстрая атака, сек
const RELEASE_TAU = 0.12;  // более плавный спад, сек
const NOISE_FLOOR = 0.01;  // RMS ниже — считаем тишиной
const GAIN = 6;            // нормировка RMS речи (~0.05..0.15) к 0..1

export class LipSync {
  constructor(vrm) {
    this.vrm = vrm;
    this.analyser = null;
    this.source = null;
    this.buffer = null;
    this.active = false;
    this.level = 0; // сглаженный уровень 0..1

    // Задел под разбор формант: список висем модели (VRM 1.0 / VRoid)
    this.visemes = ['aa', 'ih', 'ou', 'ee', 'oh'];
  }

  /**
   * Подключает анализатор к источнику звука.
   * sourceNode → analyser (НЕ к destination — оно подключается снаружи).
   */
  attach(audioContext, sourceNode) {
    this.detach();
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    this.buffer = new Uint8Array(this.analyser.fftSize);
    sourceNode.connect(this.analyser);
    this.source = sourceNode;
    this.active = true;
  }

  /** Отключить анализатор от источника */
  detach() {
    if (this.source && this.analyser) {
      try { this.source.disconnect(this.analyser); } catch { /* уже отключён */ }
    }
    this.source = null;
    this.analyser = null;
    this.buffer = null;
    this.active = false;
  }

  /** Остановить липсинк (рот плавно закроется в update) */
  stop() {
    this.detach();
  }

  update(delta) {
    let target = 0;

    if (this.active && this.analyser) {
      // RMS по сигналу во временной области
      this.analyser.getByteTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        const v = (this.buffer[i] - 128) / 128; // -1..1
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this.buffer.length);
      target = rms < NOISE_FLOOR ? 0 : Math.min(1, rms * GAIN);
    }

    // Экспоненциальное сглаживание: быстрая атака, медленный спад
    const tau = target > this.level ? ATTACK_TAU : RELEASE_TAU;
    const k = 1 - Math.exp(-delta / tau);
    this.level += (target - this.level) * k;
    if (this.level < 0.001) this.level = 0;

    // Неактивен и рот уже закрыт — ничего не пишем,
    // чтобы не затирать внешний прямой драйв через setMouth().
    if (!this.active && this.level === 0) return;

    this.applyMouthShape(this.level);
  }

  /**
   * Маппинг «амплитуда → выражения рта».
   * Пока — только громкость в 'aa'. Позже здесь появится разбор формант
   * по полосам частот (getByteFrequencyData): соотношение энергии
   * низких/средних/высоких полос → веса висем aa/ih/ou/ee/oh.
   */
  applyMouthShape(level) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    em.setValue('aa', level);
    // Остальные виземы держим в нуле, чтобы не конфликтовали с будущим маппингом
    // (и с возможным внешним setMouth — он тоже пишет в 'aa').
  }
}
