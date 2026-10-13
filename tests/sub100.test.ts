// Окно «ниже 100 Гц» (разметка админа чата Blackbox 2.0 на скриншотах PIDtoolbox) — синтетика СПМ.
import { describe, expect, it } from 'vitest';
import { sub100Of } from '../src/analysis/noise';
import { runAdvisor } from '../src/advisor/advisor';

/** СПМ с наклоном (хвост стиков) + добавки, дБ → (°/с)²/Гц */
function psd(extra: (f: number) => number): any {
  const df = 0.5, n = 4096;
  const p = new Float64Array(n / 2 + 1);
  for (let i = 1; i < p.length; i++) {
    const f = i * df;
    p[i] = 10 ** ((-10 - 18 * Math.log10(f / 10) + extra(f)) / 10);
  }
  return { fs: 2000, n, df, psd: p, segments: 10 };
}

describe('ниже 100 Гц', () => {
  it('чистый спектр: ни пика, ни подъёма', () => {
    const s = sub100Of(psd(() => 0));
    expect(s.peakProm).toBeLessThan(2);
    expect(s.bandDb).toBeLessThan(-10);
  });

  it('узкий пик 23 Гц (болтается антенна) — зона loose', () => {
    const s = sub100Of(psd((f) => 22 * Math.exp(-(((f - 23) / 1.5) ** 2))));
    expect(s.peakHz).toBeGreaterThan(21);
    expect(s.peakHz).toBeLessThan(25);
    expect(s.peakProm).toBeGreaterThan(8);
    expect(s.zone).toBe('loose');
  });

  it('пик 38 Гц — электрика; широкий горб 50–90 Гц — подъём полосы', () => {
    expect(sub100Of(psd((f) => 24 * Math.exp(-(((f - 38) / 1.5) ** 2)))).zone).toBe('electric');
    const b = sub100Of(psd((f) => (f > 45 && f < 95 ? 18 : 0)));
    expect(b.bandDb).toBeGreaterThan(-10);
  });

  it('советчик: узкий пик — механика, широкий подъём — главный множитель ниже', () => {
    const base = { fwCode: 2_026_006_001, logHz: 2000, hasUnfilt: true, filters: null, pid: null, simplified: null, dKind: 'd_max' as const, motors: { satPct: 0, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 6 } };
    const nz = (sub: any) => ({ unfilt: [6, 5, 4], filt: [0.5, 0.5, 0.5], dterm: [2, 2, null], peaks: [], sub100: [sub, null] });
    const narrow = runAdvisor({ ...base, noise: nz({ peakHz: 23, peakDb: -2, peakProm: 15, zone: 'loose', bandDb: -25 }) });
    const a = narrow.advice.find((x) => x.id === 'R-NOISE-SUB100-01')!;
    expect(a.kind).toBe('mechanic');
    expect(a.inputs.zone).toBe('loose');
    const quiet = runAdvisor({ ...base, noise: nz({ peakHz: 60, peakDb: -25, peakProm: 3, zone: 'pid', bandDb: -28 }) });
    expect(quiet.advice.some((x) => x.id.startsWith('R-NOISE-SUB100'))).toBe(false);
  });
});
