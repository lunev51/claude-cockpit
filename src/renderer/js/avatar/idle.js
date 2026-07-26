// Idle-анимации: моргание, дыхание, лёгкое покачивание головы.
// Работаем с НОРМАЛИЗОВАННЫМИ костями и выставляем значения абсолютно
// каждый кадр (не накапливаем), чтобы поза не дрейфовала.

const BLINK_DURATION = 0.16;   // полный цикл моргания, сек
const BREATH_PERIOD = 3.5;     // период дыхания, сек
const BREATH_AMP = 0.012;      // амплитуда вращения груди, рад
const HEAD_AMP = 0.01;         // амплитуда покачивания головы, рад

export class IdleAnimator {
  constructor(vrm) {
    this.vrm = vrm;
    this.time = 0;

    // Кости могут отсутствовать в конкретной модели — всегда проверяем на null
    const humanoid = vrm.humanoid;
    this.chest = humanoid?.getNormalizedBoneNode('chest') ?? null;
    this.upperChest = humanoid?.getNormalizedBoneNode('upperChest') ?? null;
    this.neck = humanoid?.getNormalizedBoneNode('neck') ?? null;
    this.head = humanoid?.getNormalizedBoneNode('head') ?? null;

    // Состояние моргания
    this.blinkTimer = this._nextBlinkInterval();
    this.blinkPhase = -1;     // -1 = не моргаем; иначе 0..BLINK_DURATION
    this.blinkQueue = 0;      // сколько морганий осталось (двойное моргание)
  }

  /** Случайный интервал до следующего моргания: 2–6 секунд */
  _nextBlinkInterval() {
    return 2 + Math.random() * 4;
  }

  update(delta) {
    this.time += delta;
    this._updateBlink(delta);
    this._updateBreath();
    this._updateHeadSway();
  }

  // --- моргание: 0→1→0 треугольником за ~160мс, иногда двойное ---
  _updateBlink(delta) {
    const em = this.vrm.expressionManager;
    if (!em) return;

    if (this.blinkPhase < 0) {
      // Ждём следующего моргания
      this.blinkTimer -= delta;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 0;
        // ~20% — двойное моргание
        this.blinkQueue = Math.random() < 0.2 ? 1 : 0;
      }
      return;
    }

    this.blinkPhase += delta;
    const t = this.blinkPhase / BLINK_DURATION; // 0..1
    if (t >= 1) {
      em.setValue('blink', 0);
      if (this.blinkQueue > 0) {
        // Короткая пауза и моргаем ещё раз
        this.blinkQueue--;
        this.blinkPhase = -1;
        this.blinkTimer = 0.12 + Math.random() * 0.1;
      } else {
        this.blinkPhase = -1;
        this.blinkTimer = this._nextBlinkInterval();
      }
      return;
    }
    // Атака до середины, спад после
    const value = t < 0.5 ? t * 2 : (1 - t) * 2;
    em.setValue('blink', value);
  }

  // --- дыхание: синус на chest/upperChest ---
  _updateBreath() {
    const breath = Math.sin((this.time / BREATH_PERIOD) * Math.PI * 2);
    if (this.chest) this.chest.rotation.x = breath * BREATH_AMP;
    if (this.upperChest) this.upperChest.rotation.x = breath * BREATH_AMP * 0.6;
  }

  // --- покачивание головы: разные периоды по осям, чтобы не было механики ---
  _updateHeadSway() {
    const t = this.time;
    if (this.neck) {
      this.neck.rotation.x = Math.sin(t * 0.43) * HEAD_AMP * 0.5;
      this.neck.rotation.z = Math.sin(t * 0.31 + 1.7) * HEAD_AMP * 0.5;
    }
    if (this.head) {
      // Суперпозиция двух синусов даёт «шумоподобное» движение
      this.head.rotation.x =
        (Math.sin(t * 0.61) + 0.5 * Math.sin(t * 1.13 + 0.9)) * HEAD_AMP * 0.7;
      this.head.rotation.z =
        (Math.sin(t * 0.47 + 2.3) + 0.5 * Math.sin(t * 0.89)) * HEAD_AMP * 0.7;
    }
  }
}
