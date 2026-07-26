// Эмоции: плавный кроссфейд (~0.4с) между пресетами VRM.
// Не трогает blink и виземы — только эмоциональные expressions.

const FADE_DURATION = 0.4; // длительность кроссфейда, сек

const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'];

export class EmotionController {
  constructor(vrm) {
    this.vrm = vrm;
    // Текущие и целевые веса по каждой эмоции
    this.current = Object.fromEntries(EMOTIONS.map((n) => [n, 0]));
    this.target = Object.fromEntries(EMOTIONS.map((n) => [n, 0]));
  }

  /**
   * Включить эмоцию с кроссфейдом; предыдущие плавно гаснут.
   * @param {string} name — happy/angry/sad/relaxed/surprised/neutral
   * @param {number} weight — целевой вес 0..1
   */
  set(name, weight = 1) {
    if (!(name in this.target)) {
      console.warn(`[emotions] неизвестная эмоция: ${name}`);
      return;
    }
    for (const n of EMOTIONS) {
      this.target[n] = n === name ? Math.min(Math.max(weight, 0), 1) : 0;
    }
  }

  update(delta) {
    const em = this.vrm.expressionManager;
    if (!em) return;

    // Линейный кроссфейд: одинаковая скорость на подъём и спад
    const step = delta / FADE_DURATION;
    for (const n of EMOTIONS) {
      const cur = this.current[n];
      const tgt = this.target[n];
      if (cur === tgt) continue;
      const next = cur < tgt ? Math.min(cur + step, tgt) : Math.max(cur - step, tgt);
      this.current[n] = next;
      em.setValue(n, next);
    }
  }
}
