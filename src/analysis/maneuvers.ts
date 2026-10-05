// Манёвры в логе для протокола тестового полёта (A2): висение, флипы/роллы по осям, панчи,
// сбросы газа. Считаются только в чистом полёте (маска). Пороги — analysis.json → protocol.

import cfg from '../config/analysis.json';
import { col } from '../decoder/decoder';
import type { LogContext } from './context';

export interface ManeuverCount {
  /** секунд висения (куски ≥ minRunS) */
  hoverS: number;
  hoverLongestS: number;
  /** флипы/роллы: [ролл, питч] */
  flips: [number, number];
  punches: number;
  chops: number;
}

export function countManeuvers(c: LogContext, mask: Uint8Array): ManeuverCount {
  const P = cfg.protocol;
  const { n, fs, thrPct } = c;
  const sp = [0, 1, 2].map((a) => col(c.log, `setpoint[${a}]`));
  const gy = [0, 1].map((a) => col(c.log, `gyroADC[${a}]`));

  // висение: стики почти в центре, газ «висячий»
  let hoverS = 0, longest = 0, run = 0;
  const minRun = Math.round(P.hover.minRunS * fs);
  const close = (): void => {
    if (run >= minRun) {
      hoverS += run / fs;
      longest = Math.max(longest, run / fs);
    }
    run = 0;
  };
  for (let i = 0; i < n; i++) {
    const ok = mask[i] && thrPct[i] >= P.hover.thrMinPct && thrPct[i] <= P.hover.thrMaxPct && sp.every((s) => !s || Math.abs(s[i]) < P.hover.stickDps);
    if (ok) run++;
    else close();
  }
  close();

  // флипы: непрерывное вращение быстрее rateDps, угол ≥ minDeg
  const flips: [number, number] = [0, 0];
  const gap = Math.round(P.flip.gapS * fs);
  gy.forEach((g, a) => {
    if (!g) return;
    let ang = 0, last = -1, start = -1;
    const end = (): void => {
      if (start >= 0 && Math.abs(ang) >= P.flip.minDeg) flips[a]++;
      ang = 0;
      start = -1;
    };
    for (let i = 0; i < n; i++) {
      const fast = mask[i] && Math.abs(g[i]) > P.flip.rateDps && (start < 0 || Math.sign(g[i]) === Math.sign(ang));
      if (fast) {
        if (start < 0) start = i;
        ang += g[i] / fs;
        last = i;
      } else if (start >= 0 && i - last > gap) end();
    }
    end();
  });

  // панчи и сбросы газа: быстрый проход газа через диапазон; начало — в полёте
  const sweep = (from: number, to: number, maxS: number, up: boolean): number => {
    let cnt = 0, lastIn = -1, armed = true;
    const max = Math.round(maxS * fs);
    for (let i = 0; i < n; i++) {
      const t = thrPct[i];
      const atStart = up ? t < from : t > from;
      const atEnd = up ? t > to : t < to;
      if (atStart) {
        lastIn = i;
        armed = true;
      } else if (atEnd && armed && lastIn >= 0 && i - lastIn <= max && mask[lastIn]) {
        cnt++;
        armed = false;
      }
    }
    return cnt;
  };
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  return {
    hoverS: r1(hoverS),
    hoverLongestS: r1(longest),
    flips,
    punches: sweep(P.punch.fromPct, P.punch.toPct, P.punch.maxS, true),
    chops: sweep(P.chop.fromPct, P.chop.toPct, P.chop.maxS, false),
  };
}
