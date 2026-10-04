// Цепочка фильтров гироскопа и D-term Betaflight 4.3+ на частоте PID-цикла.
//  gyro:  RPM-нотчи → статические нотчи 1,2 → LPF1 (дин. от газа) → LPF2 → дин. нотч
//         (gyro_filter_impl.c; dynNotchPush берёт сигнал после LPF, до дин. нотча)
//  D:     D-нотч → D-LPF1 (дин. от газа) → D-LPF2 → производная × Kd × TPA (pid.c)
// Источники: rpm_filter.c, dyn_notch_filter.c, sdft.c, gyro.c, mixer.c (updateDynLpfCutoffs).

import { BIQUAD, Biquad, Filter, LPF_TYPE, Lowpass, dynLpfCutoff, notchQ, pt1FilterGain } from './primitives';
import type { FilterContext, FilterParams } from './settings';

const RPM_FILTER_DURATION_S = 0.001;
const DYN_NOTCH_SMOOTH_HZ = 4;
const DYN_NOTCH_CALC_TICKS = 12; // 3 оси × 4 шага
const SDFT_SAMPLE_SIZE = 72;
const SDFT_BIN_COUNT = SDFT_SAMPLE_SIZE / 2;
const SDFT_R = 0.9999;
const DYN_LPF_THROTTLE_STEPS = 100;
const DYN_LPF_THROTTLE_UPDATE_DELAY_US = 5000;
export const DTERM_SCALE = 0.000529;

const g = (p: FilterParams, k: string, d = 0): number => (p[k] === undefined ? d : p[k]);

// ---------------- RPM ----------------
class RpmFilter {
  harmonics: number;
  motors: number;
  q: number;
  minHz: number;
  maxHz: number;
  fadeHz: number;
  weights: number[];
  freqLpfK: number;
  motorHz: Float64Array;
  /** коэффициенты нотча [motor*H + h]: b0,b1,b2,a1,a2,weight */
  coef: Float64Array;
  /** состояние DF1 [axis][notch]: x1,x2,y1,y2 */
  st: Float64Array[];
  perIter: number;
  mIdx = 0;
  hIdx = 0;
  looptimeUs: number;
  private bq = new Biquad(true);

  constructor(p: FilterParams, fc: FilterContext, motors: number) {
    this.harmonics = fc.dshotBidir ? g(p, 'rpm_filter_harmonics', 0) : 0;
    this.motors = motors;
    this.q = g(p, 'rpm_filter_q', 500) / 100;
    this.minHz = g(p, 'rpm_filter_min_hz', 100);
    this.looptimeUs = fc.pidLooptimeUs;
    this.maxHz = (0.48 * 1e6) / fc.pidLooptimeUs;
    this.fadeHz = g(p, 'rpm_filter_fade_range_hz', 50);
    this.weights = fc.rpmWeights.map((w) => Math.min(1, Math.max(0, w / 100)));
    this.freqLpfK = pt1FilterGain(g(p, 'rpm_filter_lpf_hz', 150), fc.pidLooptimeUs * 1e-6);
    this.motorHz = new Float64Array(motors);
    const n = Math.max(1, motors * this.harmonics);
    this.coef = new Float64Array(n * 6);
    this.st = [0, 1, 2].map(() => new Float64Array(n * 4));
    const loopsPerUpdate = RPM_FILTER_DURATION_S / (fc.pidLooptimeUs * 1e-6);
    this.perIter = Math.max(1, Math.ceil((motors * this.harmonics) / loopsPerUpdate));
    // начальное состояние: нотчи на minHz·n с нулевым весом (как rpmFilterInit)
    for (let m = 0; m < motors; m++) for (let h = 0; h < this.harmonics; h++) this.setNotch(m, h, this.minHz * (h + 1), 0);
  }

  get enabled(): boolean {
    return this.harmonics > 0 && this.motors > 0;
  }

  private setNotch(m: number, h: number, hz: number, weight: number): void {
    this.bq.update(hz, this.looptimeUs, this.q, BIQUAD.NOTCH, weight);
    const o = (m * this.harmonics + h) * 6;
    const c = this.coef;
    c[o] = this.bq.b0; c[o + 1] = this.bq.b1; c[o + 2] = this.bq.b2; c[o + 3] = this.bq.a1; c[o + 4] = this.bq.a2; c[o + 5] = weight;
  }

  /** rpmFilterUpdate: сглаживание оборотов + обновление части нотчей за цикл */
  update(motorHzRaw: ArrayLike<number>): void {
    for (let m = 0; m < this.motors; m++) this.motorHz[m] += this.freqLpfK * (motorHzRaw[m] - this.motorHz[m]);
    for (let i = 0; i < this.perIter; i++) {
      const h = this.hIdx, m = this.mIdx;
      const f = Math.min(this.maxHz, Math.max(this.minHz, (h + 1) * this.motorHz[m]));
      const margin = f - this.minHz;
      let w = this.weights[h] ?? 1;
      if (margin < this.fadeHz) w *= margin / this.fadeHz;
      this.setNotch(m, h, f, w);
      this.hIdx = (this.hIdx + 1) % this.harmonics;
      if (this.hIdx === 0) this.mIdx = (this.mIdx + 1) % this.motors;
    }
  }

  apply(axis: number, x: number): number {
    const c = this.coef, s = this.st[axis];
    for (let h = 0; h < this.harmonics; h++) {
      if ((this.weights[h] ?? 1) <= 0) continue;
      for (let m = 0; m < this.motors; m++) {
        const n = m * this.harmonics + h;
        const o = n * 6, so = n * 4;
        const r = c[o] * x + c[o + 1] * s[so] + c[o + 2] * s[so + 1] - c[o + 3] * s[so + 2] - c[o + 4] * s[so + 3];
        s[so + 1] = s[so]; s[so] = x;
        s[so + 3] = s[so + 2]; s[so + 2] = r;
        const w = c[o + 5];
        x = w * r + (1 - w) * x;
      }
    }
    return x;
  }

  /** снимок нотчей для частотной характеристики */
  snapshot(motorHz: number[]): Biquad[] {
    const out: Biquad[] = [];
    for (let h = 0; h < this.harmonics; h++) {
      if ((this.weights[h] ?? 1) <= 0) continue;
      for (let m = 0; m < this.motors; m++) {
        const f = Math.min(this.maxHz, Math.max(this.minHz, (h + 1) * (motorHz[m] ?? motorHz[0])));
        let w = this.weights[h] ?? 1;
        if (f - this.minHz < this.fadeHz) w *= (f - this.minHz) / this.fadeHz;
        const b = new Biquad(true);
        b.update(f, this.looptimeUs, this.q, BIQUAD.NOTCH, w);
        out.push(b);
      }
    }
    return out;
  }
}

// ---------------- динамический нотч (SDFT) ----------------
class DynNotch {
  count: number;
  q: number;
  minHz: number;
  maxHz: number;
  sampleCount: number;
  resolutionHz: number;
  startBin: number;
  endBin: number;
  center: Float64Array[]; // [axis][p]
  notches: Biquad[][];
  looptimeUs: number;
  looprateHz: number;
  // SDFT
  private rPowerN = Math.pow(SDFT_R, SDFT_SAMPLE_SIZE);
  private twRe = new Float64Array(SDFT_BIN_COUNT);
  private twIm = new Float64Array(SDFT_BIN_COUNT);
  private samples = [0, 1, 2].map(() => new Float64Array(SDFT_SAMPLE_SIZE));
  private idx = [0, 0, 0];
  private dRe = [0, 1, 2].map(() => new Float64Array(SDFT_BIN_COUNT));
  private dIm = [0, 1, 2].map(() => new Float64Array(SDFT_BIN_COUNT));
  private acc = [0, 0, 0];
  private sampleIndex = 0;
  private tick = 0;
  private step = 0;
  private axis = 0;
  private sdftData = new Float64Array(SDFT_BIN_COUNT);
  private noise = 0;
  private peaks: { bin: number; value: number }[];

  constructor(p: FilterParams, fc: FilterContext) {
    this.count = g(p, 'dyn_notch_count', 0);
    this.q = g(p, 'dyn_notch_q', 300) / 100;
    this.looptimeUs = fc.pidLooptimeUs;
    this.looprateHz = Math.round(1e6 / fc.pidLooptimeUs);
    this.minHz = g(p, 'dyn_notch_min_hz', 150);
    this.maxHz = Math.max(2 * this.minHz, g(p, 'dyn_notch_max_hz', 600));
    this.maxHz = Math.min(this.maxHz, this.looprateHz / 2);
    this.sampleCount = Math.max(1, Math.floor(this.looprateHz / (2 * this.maxHz)));
    const sdftRate = Math.floor(this.looprateHz / this.sampleCount);
    this.resolutionHz = sdftRate / SDFT_SAMPLE_SIZE;
    this.startBin = Math.max(2, Math.round(this.minHz / this.resolutionHz + 0.5));
    this.endBin = Math.min(SDFT_BIN_COUNT - 1, Math.round(this.maxHz / this.resolutionHz + 0.5));
    const c = (2 * Math.PI) / SDFT_SAMPLE_SIZE;
    for (let i = 0; i < SDFT_BIN_COUNT; i++) {
      this.twRe[i] = SDFT_R * Math.cos(c * i);
      this.twIm[i] = SDFT_R * Math.sin(c * i);
    }
    this.center = [0, 1, 2].map(() => {
      const a = new Float64Array(this.count);
      for (let k = 0; k < this.count; k++) a[k] = ((k + 0.5) * (this.maxHz - this.minHz)) / this.count + this.minHz;
      return a;
    });
    this.notches = [0, 1, 2].map((ax) => Array.from({ length: this.count }, (_, k) => {
      const b = new Biquad(true);
      b.update(this.center[ax][k], this.looptimeUs, this.q, BIQUAD.NOTCH, 1);
      return b;
    }));
    this.peaks = Array.from({ length: this.count }, () => ({ bin: 0, value: 0 }));
  }

  get enabled(): boolean {
    return this.count > 0;
  }

  push(axis: number, x: number): void {
    this.acc[axis] += x;
  }

  filter(axis: number, x: number): number {
    const n = this.notches[axis];
    for (let k = 0; k < n.length; k++) x = n[k].apply(x);
    return x;
  }

  private sdftPush(axis: number, sample: number): void {
    const s = this.samples[axis];
    const delta = sample - this.rPowerN * s[this.idx[axis]];
    s[this.idx[axis]] = sample;
    this.idx[axis] = (this.idx[axis] + 1) % SDFT_SAMPLE_SIZE;
    const re = this.dRe[axis], im = this.dIm[axis];
    for (let i = this.startBin; i <= this.endBin; i++) {
      const ar = re[i] + delta, ai = im[i];
      re[i] = this.twRe[i] * ar - this.twIm[i] * ai;
      im[i] = this.twRe[i] * ai + this.twIm[i] * ar;
    }
  }

  private winSq(axis: number): void {
    const re = this.dRe[axis], im = this.dIm[axis], out = this.sdftData;
    const s = this.startBin, e = this.endBin;
    const sq = (r: number, i: number): number => r * r + i * i;
    // края диапазона — как в sdftWinSq
    let vr = re[s] - 0.5 * (s > 0 ? re[s - 1] + re[s + 1] : re[s + 1]);
    let vi = im[s] - 0.5 * (s > 0 ? im[s - 1] + im[s + 1] : im[s + 1]);
    out[s] = sq(vr, vi);
    for (let i = s + 1; i < e; i++) {
      vr = re[i] - 0.5 * (re[i - 1] + re[i + 1]);
      vi = im[i] - 0.5 * (im[i - 1] + im[i + 1]);
      out[i] = sq(vr, vi);
    }
    vr = e < SDFT_BIN_COUNT - 1 ? re[e] - 0.5 * (re[e - 1] + re[e + 1]) : re[e] - 0.5 * re[e - 1];
    vi = e < SDFT_BIN_COUNT - 1 ? im[e] - 0.5 * (im[e - 1] + im[e + 1]) : im[e] - 0.5 * im[e - 1];
    out[e] = sq(vr, vi);
  }

  /** dynNotchUpdate: вызывается каждый PID-цикл после фильтрации всех осей */
  update(): void {
    if (this.sampleIndex === this.sampleCount) {
      this.sampleIndex = 0;
      for (let a = 0; a < 3; a++) {
        this.sdftPush(a, this.acc[a] / this.sampleCount);
        this.acc[a] = 0;
      }
      this.tick = DYN_NOTCH_CALC_TICKS;
    }
    this.sampleIndex++;
    if (this.tick > 0) {
      this.process();
      this.tick--;
    }
  }

  private process(): void {
    const d = this.sdftData;
    const ax = this.axis;
    switch (this.step) {
      case 0: {
        this.winSq(ax);
        this.noise = 0;
        for (let b = this.startBin; b <= this.endBin; b++) this.noise += d[b];
        break;
      }
      case 1: {
        const P = this.peaks;
        for (const pk of P) { pk.bin = 0; pk.value = 0; }
        for (let b = this.startBin + 1; b < this.endBin; b++) {
          if (d[b] > d[b - 1] && d[b] > d[b + 1]) {
            for (let p = 0; p < this.count; p++) {
              if (d[b] > P[p].value) {
                for (let k = this.count - 1; k > p; k--) { P[k].bin = P[k - 1].bin; P[k].value = P[k - 1].value; }
                P[p].bin = b;
                P[p].value = d[b];
                break;
              }
            }
            b++;
          }
        }
        for (let p = this.count - 1; p > 0; p--) {
          for (let k = 0; k < p; k++) {
            if (P[k].bin > P[k + 1].bin && P[k + 1].bin !== 0) {
              const tb = P[k].bin, tv = P[k].value;
              P[k].bin = P[k + 1].bin; P[k].value = P[k + 1].value;
              P[k + 1].bin = tb; P[k + 1].value = tv;
            }
          }
        }
        break;
      }
      case 2: {
        let pc = 0;
        for (const pk of this.peaks) {
          if (pk.bin !== 0) {
            this.noise -= 0.75 * d[pk.bin - 1] + d[pk.bin] + 0.75 * d[pk.bin + 1];
            pc++;
          }
        }
        this.noise /= this.endBin - this.startBin - pc + 1;
        this.noise *= 2;
        for (let p = 0; p < this.count; p++) {
          const pk = this.peaks[p];
          if (pk.bin !== 0 && pk.value > this.noise) {
            let mean = pk.bin;
            const y0 = d[pk.bin - 1], y1 = d[pk.bin], y2 = d[pk.bin + 1];
            const den = 2 * (y0 - 2 * y1 + y2);
            if (den !== 0) mean += (y0 - y2) / den;
            const cf = Math.min(this.maxHz, Math.max(this.minHz, mean * this.resolutionHz));
            const mult = Math.min(10, Math.max(1, pk.value / this.noise));
            const gain = pt1FilterGain(DYN_NOTCH_SMOOTH_HZ * mult, DYN_NOTCH_CALC_TICKS / this.looprateHz);
            this.center[ax][p] += gain * (cf - this.center[ax][p]);
          }
        }
        break;
      }
      case 3: {
        for (let p = 0; p < this.count; p++) {
          const pk = this.peaks[p];
          if (pk.bin !== 0 && pk.value > this.noise) this.notches[ax][p].update(this.center[ax][p], this.looptimeUs, this.q, BIQUAD.NOTCH, 1);
        }
        this.axis = (this.axis + 1) % 3;
        break;
      }
    }
    this.step = (this.step + 1) % 4;
  }

  snapshot(centers: number[]): Biquad[] {
    return centers.map((c) => {
      const b = new Biquad(true);
      b.update(c, this.looptimeUs, this.q, BIQUAD.NOTCH, 1);
      return b;
    });
  }
}

// ---------------- lowpass с динамикой от газа ----------------
interface LpfSpec {
  type: number;
  staticHz: number;
  dynMin: number;
  dynMax: number;
  dynExpo: number;
}

function lpfSpec(p: FilterParams, prefix: 'gyro_lpf1' | 'dterm_lpf1'): LpfSpec {
  return {
    type: g(p, `${prefix}_type`, 0),
    staticHz: g(p, `${prefix}_static_hz`, 0),
    dynMin: g(p, `${prefix}_dyn_min_hz`, 0),
    dynMax: g(p, `${prefix}_dyn_max_hz`, 0),
    dynExpo: g(p, `${prefix}_dyn_expo`, 0),
  };
}

const lpfEnabled = (s: LpfSpec, nyq: number): boolean => s.staticHz > 0 && s.staticHz < nyq;
const lpfDynamic = (s: LpfSpec): boolean => s.dynMin > 0 && s.type >= LPF_TYPE.PT1 && s.type <= LPF_TYPE.PT3;

function staticNotch(hz: number, cutoff: number, looptimeUs: number, nyq: number): Biquad | null {
  if (!(hz > 0 && cutoff > 0 && cutoff < hz && hz < nyq)) return null;
  const b = new Biquad(false);
  b.update(hz, looptimeUs, notchQ(hz, cutoff), BIQUAD.NOTCH, 1);
  return b;
}

/** Описание операционной точки для частотной характеристики */
export interface OperatingPoint {
  throttle: number;
  motorHz: number[];
  dynNotch: number[][]; // [axis][p]
}

export class FilterChain {
  readonly p: FilterParams;
  readonly fc: FilterContext;
  readonly pidHz: number;
  rpm: RpmFilter;
  notch1: Biquad[] = [];
  notch2: Biquad[] = [];
  lpf1: Lowpass[] = [];
  lpf2: Lowpass[] = [];
  dyn: DynNotch;
  lpf1Spec: LpfSpec;
  dLpf1Spec: LpfSpec;
  dNotch: Biquad[] = [];
  dLpf1: Lowpass[] = [];
  dLpf2: Lowpass[] = [];
  private lastDynUs = -1e12;
  private lastQThr = -1;
  private dPrev = [0, 0, 0];
  private timeUs = 0;
  /** текущий срез динамических LPF (для графика) */
  lpf1Hz = 0;
  dLpf1Hz = 0;

  constructor(p: FilterParams, fc: FilterContext, motors: number) {
    this.p = p;
    this.fc = fc;
    this.pidHz = 1e6 / fc.pidLooptimeUs;
    const nyq = this.pidHz / 2;
    const lt = fc.pidLooptimeUs;
    this.rpm = new RpmFilter(p, fc, motors);
    this.dyn = new DynNotch(p, fc);
    this.lpf1Spec = lpfSpec(p, 'gyro_lpf1');
    this.dLpf1Spec = lpfSpec(p, 'dterm_lpf1');
    for (let a = 0; a < 3; a++) {
      const n1 = staticNotch(g(p, 'gyro_notch1_hz'), g(p, 'gyro_notch1_cutoff'), lt, nyq);
      const n2 = staticNotch(g(p, 'gyro_notch2_hz'), g(p, 'gyro_notch2_cutoff'), lt, nyq);
      if (n1) this.notch1.push(n1);
      if (n2) this.notch2.push(n2);
      if (lpfEnabled(this.lpf1Spec, nyq)) this.lpf1.push(new Lowpass(this.lpf1Spec.type, this.lpf1Spec.staticHz, lt));
      const l2 = g(p, 'gyro_lpf2_static_hz');
      if (l2 > 0 && l2 < nyq) this.lpf2.push(new Lowpass(g(p, 'gyro_lpf2_type'), l2, lt));
      const dn = staticNotch(g(p, 'dterm_notch_hz'), g(p, 'dterm_notch_cutoff'), lt, nyq);
      if (dn) this.dNotch.push(dn);
      if (lpfEnabled(this.dLpf1Spec, nyq)) this.dLpf1.push(new Lowpass(this.dLpf1Spec.type, this.dLpf1Spec.staticHz, lt));
      const d2 = g(p, 'dterm_lpf2_static_hz');
      if (d2 > 0 && d2 < nyq) this.dLpf2.push(new Lowpass(g(p, 'dterm_lpf2_type'), d2, lt));
    }
    this.lpf1Hz = this.lpf1.length ? this.lpf1Spec.staticHz : 0;
    this.dLpf1Hz = this.dLpf1.length ? this.dLpf1Spec.staticHz : 0;
  }

  /** updateDynLpfCutoffs: не чаще раза в 5 мс и только при смене газа на 1 % */
  private updateDynLpf(throttle: number): void {
    if (this.timeUs - this.lastDynUs < DYN_LPF_THROTTLE_UPDATE_DELAY_US) return;
    const q = Math.round(throttle * DYN_LPF_THROTTLE_STEPS);
    if (q === this.lastQThr) return;
    const thr = q / DYN_LPF_THROTTLE_STEPS;
    if (this.lpf1.length && lpfDynamic(this.lpf1Spec)) {
      const s = this.lpf1Spec;
      this.lpf1Hz = dynLpfCutoff(thr, s.dynMin, s.dynMax, s.dynExpo);
      for (const f of this.lpf1) f.setCutoff(this.lpf1Hz);
    }
    if (this.dLpf1.length && lpfDynamic(this.dLpf1Spec)) {
      const s = this.dLpf1Spec;
      this.dLpf1Hz = dynLpfCutoff(thr, s.dynMin, s.dynMax, s.dynExpo);
      for (const f of this.dLpf1) f.setCutoff(this.dLpf1Hz);
    }
    this.lastQThr = q;
    this.lastDynUs = this.timeUs;
  }

  /**
   * Один PID-цикл. gyroIn — нефильтрованное гиро трёх осей, °/с; motorHzRaw — частота
   * моторов из eRPM; throttle 0..1. Пишет отфильтрованное гиро в outG и D-term в outD.
   */
  step(gyroIn: ArrayLike<number>, motorHzRaw: ArrayLike<number>, throttle: number, outG: Float64Array, outD: Float64Array | null): void {
    this.updateDynLpf(throttle);
    if (this.rpm.enabled) this.rpm.update(motorHzRaw);
    const dynOn = this.dyn.enabled;
    for (let a = 0; a < 3; a++) {
      let x = gyroIn[a];
      if (this.rpm.enabled) x = this.rpm.apply(a, x);
      if (this.notch1.length) x = this.notch1[a].apply(x);
      if (this.notch2.length) x = this.notch2[a].apply(x);
      if (this.lpf1.length) x = this.lpf1[a].apply(x);
      if (this.lpf2.length) x = this.lpf2[a].apply(x);
      if (dynOn) {
        this.dyn.push(a, x);
        x = this.dyn.filter(a, x);
      }
      outG[a] = x;
      if (outD) {
        let y = x;
        if (this.dNotch.length) y = this.dNotch[a].apply(y);
        if (this.dLpf1.length) y = this.dLpf1[a].apply(y);
        if (this.dLpf2.length) y = this.dLpf2[a].apply(y);
        outD[a] = -(y - this.dPrev[a]) * this.pidHz;
        this.dPrev[a] = y;
      }
    }
    if (dynOn) this.dyn.update();
    this.timeUs += this.fc.pidLooptimeUs;
  }

  /** звенья цепочки в операционной точке — для АЧХ/ФЧХ */
  sections(op: OperatingPoint, axis = 0): { gyro: { name: string; f: Filter }[]; dterm: { name: string; f: Filter }[] } {
    const gyro: { name: string; f: Filter }[] = [];
    const lt = this.fc.pidLooptimeUs;
    if (this.rpm.enabled) for (const b of this.rpm.snapshot(op.motorHz)) gyro.push({ name: 'rpm', f: b });
    if (this.notch1.length) gyro.push({ name: 'notch1', f: this.notch1[axis] });
    if (this.notch2.length) gyro.push({ name: 'notch2', f: this.notch2[axis] });
    if (this.lpf1.length) {
      const s = this.lpf1Spec;
      const hz = lpfDynamic(s) ? dynLpfCutoff(Math.round(op.throttle * 100) / 100, s.dynMin, s.dynMax, s.dynExpo) : s.staticHz;
      gyro.push({ name: 'lpf1', f: new Lowpass(s.type, hz, lt) });
    }
    if (this.lpf2.length) gyro.push({ name: 'lpf2', f: this.lpf2[axis] });
    if (this.dyn.enabled) for (const b of this.dyn.snapshot(op.dynNotch[axis] ?? [])) gyro.push({ name: 'dyn', f: b });
    const dterm: { name: string; f: Filter }[] = [];
    if (this.dNotch.length) dterm.push({ name: 'dnotch', f: this.dNotch[axis] });
    if (this.dLpf1.length) {
      const s = this.dLpf1Spec;
      const hz = lpfDynamic(s) ? dynLpfCutoff(Math.round(op.throttle * 100) / 100, s.dynMin, s.dynMax, s.dynExpo) : s.staticHz;
      dterm.push({ name: 'dlpf1', f: new Lowpass(s.type, hz, lt) });
    }
    if (this.dLpf2.length) dterm.push({ name: 'dlpf2', f: this.dLpf2[axis] });
    return { gyro, dterm };
  }

  /** текущие центры динамических нотчей */
  dynCenters(axis: number): number[] {
    return this.dyn.enabled ? Array.from(this.dyn.center[axis]) : [];
  }

  /** сводка цепочки человеческим языком (для UI) */
  describe(): { gyro: string[]; dterm: string[] } {
    const gyro: string[] = [];
    const p = this.p;
    if (this.rpm.enabled) gyro.push(`RPM-фильтр: ${this.rpm.harmonics} гарм. × ${this.rpm.motors} мот., Q ${this.rpm.q.toFixed(2)}, от ${this.rpm.minHz} Гц, затухание ${this.rpm.fadeHz} Гц`);
    else gyro.push(this.fc.dshotBidir ? 'RPM-фильтр выключен' : 'RPM-фильтр недоступен (нет bidirectional DShot)');
    if (this.notch1.length) gyro.push(`Статический нотч 1: ${g(p, 'gyro_notch1_hz')} Гц (от ${g(p, 'gyro_notch1_cutoff')})`);
    if (this.notch2.length) gyro.push(`Статический нотч 2: ${g(p, 'gyro_notch2_hz')} Гц (от ${g(p, 'gyro_notch2_cutoff')})`);
    const t = (n: number): string => ['PT1', 'BIQUAD', 'PT2', 'PT3'][n] ?? '?';
    if (this.lpf1.length) gyro.push(lpfDynamic(this.lpf1Spec) ? `LPF1 ${t(this.lpf1Spec.type)} динамический ${this.lpf1Spec.dynMin}–${this.lpf1Spec.dynMax} Гц (экспо ${this.lpf1Spec.dynExpo})` : `LPF1 ${t(this.lpf1Spec.type)} ${this.lpf1Spec.staticHz} Гц`);
    else gyro.push('LPF1 выключен');
    if (this.lpf2.length) gyro.push(`LPF2 ${t(g(p, 'gyro_lpf2_type'))} ${g(p, 'gyro_lpf2_static_hz')} Гц`);
    else gyro.push('LPF2 выключен');
    if (this.dyn.enabled) gyro.push(`Динамический нотч: ${this.dyn.count} шт., Q ${this.dyn.q.toFixed(2)}, ${this.dyn.minHz}–${this.dyn.maxHz} Гц`);
    else gyro.push('Динамический нотч выключен');
    const dterm: string[] = [];
    if (this.dNotch.length) dterm.push(`D-нотч ${g(p, 'dterm_notch_hz')} Гц`);
    if (this.dLpf1.length) dterm.push(lpfDynamic(this.dLpf1Spec) ? `D-LPF1 ${t(this.dLpf1Spec.type)} динамический ${this.dLpf1Spec.dynMin}–${this.dLpf1Spec.dynMax} Гц` : `D-LPF1 ${t(this.dLpf1Spec.type)} ${this.dLpf1Spec.staticHz} Гц`);
    else dterm.push('D-LPF1 выключен');
    if (this.dLpf2.length) dterm.push(`D-LPF2 ${t(g(p, 'dterm_lpf2_type'))} ${g(p, 'dterm_lpf2_static_hz')} Гц`);
    else dterm.push('D-LPF2 выключен');
    return { gyro, dterm };
  }
}

/** TPA (BF 4.4+): множитель D на газе выше точки излома; tpa_low не моделируем */
export function tpaFactor(throttle: number, fc: FilterContext): number {
  const bp = (fc.tpaBreakpoint - 1000) / 1000;
  const mult = fc.tpaRate / 100 / Math.max(1e-6, 1 - bp);
  const t = Math.min(1, Math.max(0, throttle));
  return 1 - mult * Math.max(t - bp, 0);
}
