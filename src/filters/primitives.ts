// Фильтры Betaflight один в один (src/main/common/filter.c, BF 4.3+):
// формулы коэффициентов, порядок операций, взвешенный DF1 для нотчей.
// Плюс частотная характеристика каждого звена (для АЧХ/ФЧХ и задержки).

export const CUTOFF_CORRECTION_PT2 = 1.553773974;
export const CUTOFF_CORRECTION_PT3 = 1.961459177;
export const BIQUAD_Q = 1 / Math.SQRT2;

/** тип lowpass в настройках BF: gyro_lpf1_type / dterm_lpf1_type и т.д. */
export const LPF_TYPE = { PT1: 0, BIQUAD: 1, PT2: 2, PT3: 3 } as const;
export const LPF_TYPE_NAMES = ['PT1', 'BIQUAD', 'PT2', 'PT3'];

export function pt1FilterGain(fCut: number, dT: number): number {
  const omega = 2 * Math.PI * fCut * dT;
  return omega / (omega + 1);
}
export const pt2FilterGain = (fCut: number, dT: number): number => pt1FilterGain(fCut * CUTOFF_CORRECTION_PT2, dT);
export const pt3FilterGain = (fCut: number, dT: number): number => pt1FilterGain(fCut * CUTOFF_CORRECTION_PT3, dT);

/** Q нотча по центру и нижней границе (filterGetNotchQ) */
export function notchQ(centerHz: number, cutoffHz: number): number {
  return (centerHz * cutoffHz) / (centerHz * centerHz - cutoffHz * cutoffHz);
}

export interface Filter {
  apply(x: number): number;
  /** комплексная передаточная функция на частоте f (Гц) при шаге dT */
  response(f: number, dT: number): [number, number];
  reset(): void;
}

/** PT1/PT2/PT3 — каскад одинаковых PT1 с общим k */
export class PtN implements Filter {
  k = 1;
  s = [0, 0, 0];
  constructor(public order: 1 | 2 | 3) {}
  setGain(k: number): void {
    this.k = k;
  }
  apply(x: number): number {
    const k = this.k;
    const s = this.s;
    s[0] += k * (x - s[0]);
    if (this.order === 1) return s[0];
    s[1] += k * (s[0] - s[1]);
    if (this.order === 2) return s[1];
    s[2] += k * (s[1] - s[2]);
    return s[2];
  }
  response(f: number, dT: number): [number, number] {
    // H = k / (1 − (1−k)·e^{−jω})
    const w = 2 * Math.PI * f * dT;
    const a = 1 - this.k;
    const dr = 1 - a * Math.cos(w), di = a * Math.sin(w);
    const den = dr * dr + di * di;
    let hr = (this.k * dr) / den, hi = (-this.k * di) / den;
    const r1 = hr, i1 = hi;
    for (let o = 1; o < this.order; o++) {
      const nr = hr * r1 - hi * i1, ni = hr * i1 + hi * r1;
      hr = nr; hi = ni;
    }
    return [hr, hi];
  }
  reset(): void {
    this.s = [0, 0, 0];
  }
}

export const BIQUAD = { LPF: 0, NOTCH: 1, BPF: 2 } as const;

/** RBJ-биквад как в biquadFilterUpdate(); DF1 с весом (нотчи) или DF2T (lowpass) */
export class Biquad implements Filter {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  weight = 1;
  constructor(public df1 = true) {}

  update(freqHz: number, looptimeUs: number, q: number, type: number, weight = 1): void {
    const omega = 2 * Math.PI * freqHz * looptimeUs * 0.000001;
    const sn = Math.sin(omega);
    const cs = Math.cos(omega);
    const alpha = sn / (2 * q);
    let b0: number, b1: number, b2: number, a1: number;
    if (type === BIQUAD.LPF) {
      b1 = 1 - cs;
      b0 = b1 * 0.5;
      b2 = b0;
      a1 = -2 * cs;
    } else if (type === BIQUAD.NOTCH) {
      b0 = 1;
      b1 = -2 * cs;
      b2 = 1;
      a1 = b1;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a1 = -2 * cs;
    }
    const a2 = 1 - alpha;
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.weight = weight;
  }

  apply(x: number): number {
    if (this.df1) {
      const r = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = r;
      return this.weight * r + (1 - this.weight) * x;
    }
    // DF2 transposed (biquadFilterApply) — для lowpass
    const r = this.b0 * x + this.x1;
    this.x1 = this.b1 * x - this.a1 * r + this.x2;
    this.x2 = this.b2 * x - this.a2 * r;
    return r;
  }

  response(f: number, dT: number): [number, number] {
    const w = 2 * Math.PI * f * dT;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    const den = dr * dr + di * di;
    const hr = (nr * dr + ni * di) / den, hi = (ni * dr - nr * di) / den;
    const wt = this.df1 ? this.weight : 1;
    return [wt * hr + (1 - wt), wt * hi];
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** lowpass любого типа BF с единым интерфейсом обновления среза */
export class Lowpass implements Filter {
  pt: PtN | null = null;
  bq: Biquad | null = null;
  constructor(public type: number, public hz: number, public looptimeUs: number) {
    if (type === LPF_TYPE.BIQUAD) this.bq = new Biquad(false);
    else this.pt = new PtN(type === LPF_TYPE.PT2 ? 2 : type === LPF_TYPE.PT3 ? 3 : 1);
    this.setCutoff(hz);
  }
  setCutoff(hz: number): void {
    this.hz = hz;
    const dT = this.looptimeUs * 1e-6;
    if (this.bq) this.bq.update(hz, this.looptimeUs, BIQUAD_Q, BIQUAD.LPF);
    else if (this.pt) this.pt.setGain(this.type === LPF_TYPE.PT2 ? pt2FilterGain(hz, dT) : this.type === LPF_TYPE.PT3 ? pt3FilterGain(hz, dT) : pt1FilterGain(hz, dT));
  }
  apply(x: number): number {
    return this.bq ? this.bq.apply(x) : this.pt!.apply(x);
  }
  response(f: number, dT: number): [number, number] {
    return this.bq ? this.bq.response(f, dT) : this.pt!.response(f, dT);
  }
  reset(): void {
    this.bq?.reset();
    this.pt?.reset();
  }
}

/** кривая динамического LPF от газа (dynLpfCutoffFreq / dynThrottle) */
export function dynLpfCutoff(throttle: number, min: number, max: number, expo: number): number {
  if (expo > 0) {
    const e = expo / 10;
    const curve = throttle * (1 - throttle) * e + throttle;
    return (max - min) * curve + min;
  }
  const dynThrottle = throttle * (1 - (throttle * throttle) / 3) * 1.5;
  return Math.max(dynThrottle * max, min);
}

export function cmul(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
