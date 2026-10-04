// Полный путь «лог → анализ → советы → снимок сессии» одной цепочкой чистых функций.
// Его вызывает воркер; его же вызывают тесты и регрессионные случаи (tests/cases): что
// видит пользователь, то и проверяется.

import { AdvisorResult, advisorInputFrom, runAdvisor } from '../advisor/advisor';
import { col } from '../decoder/decoder';
import { FilterBaseline, FilterEval, buildBaseline, evaluate } from '../filters/evaluate';
import { FilterContext, FilterParams, contextFromHeader, paramsFromHeader } from '../filters/settings';
import { PidResult, analyzePid } from '../pid/analyze';
import { simplifiedFromHeader } from '../pid/gains';
import { SessionSnapshot, buildSnapshot } from '../sessions/snapshot';
import { LogContext } from './context';
import { FlightMask, buildFlightMask } from './flightMask';
import { HealthResult, analyzeHealth } from './health';
import { NoiseResult, analyzeNoise } from './noise';
import { Card, LogMeta, buildSummary } from './summary';

export interface Analysis {
  c: LogContext;
  fm: FlightMask;
  nz: NoiseResult;
  h: HealthResult;
  filters: { params: FilterParams; fctx: FilterContext; base: FilterBaseline; sim: ReturnType<typeof buildBaseline>['sim'] } | null;
  pid: PidResult | null;
  cards: Card[];
}

export function analyzeLog(c: LogContext, range: { t0: number; t1: number } | null = null, meta: LogMeta = { crossesWrap: false }, onError: (what: string, e: unknown) => void = () => {}): Analysis {
  const fm = buildFlightMask(c, range);
  const nz = analyzeNoise(c, fm);
  const h = analyzeHealth(c, fm);
  let filters: Analysis['filters'] = null;
  try {
    const params = paramsFromHeader(c.log.header);
    const fctx = contextFromHeader(c.log.header, c.fw.code);
    const { base, sim } = buildBaseline(c, fm.mask, nz.bursts, params, fctx);
    filters = { params, fctx, base, sim };
  } catch (e) {
    onError('filters', e);
  }
  let pid: PidResult | null = null;
  try {
    pid = analyzePid(c, fm.mask);
  } catch (e) {
    onError('pid', e);
  }
  const cards = buildSummary(c, fm, nz, h, meta, filters?.base ?? null, pid);
  return { c, fm, nz, h, filters, pid, cards };
}

/** советы + ожидаемый эффект советов по фильтрам (точная модель, как в песочнице) */
export function adviseLog(a: Analysis, onError: (what: string, e: unknown) => void = () => {}): AdvisorResult {
  const { c, nz, h, filters: f } = a;
  const res = runAdvisor(advisorInputFrom(c, nz, h, f ? { params: f.params, status: f.base.validation.status, reason: f.base.validation.reason } : null, a.pid, simplifiedFromHeader(c.log.header)));
  if (f) {
    const cur = f.base.current;
    const mx = (v: number[]): number => Math.max(...v.filter((x) => Number.isFinite(x)));
    for (const adv of res.advice) {
      const keys = Object.keys(adv.changes);
      if (!keys.length || !keys.every((k) => k in f.params || /^simplified_(gyro|dterm)_filter_multiplier$/.test(k))) continue;
      try {
        const { ev } = evaluate(c, { ...f.params, ...adv.changes }, f.fctx, f.base.segments, f.base.n, cur.op);
        adv.effect = { delay100: [cur.delay.gyro['100'], ev.delay.gyro['100']], delayD100: [cur.delay.dterm['100'], ev.delay.dterm['100']], dterm: [mx(cur.rmsDterm), mx(ev.rmsDterm)], gyro: [mx(cur.rmsGyro), mx(ev.rmsGyro)] };
      } catch (e) {
        onError('advice effect', e);
      }
    }
  }
  return res;
}

/** пересчёт фильтров этого полёта под план (null — план фильтры не трогает) */
export function planFilterEval(a: Analysis, adv: AdvisorResult): FilterEval | null {
  const f = a.filters;
  if (!f || !Object.keys(adv.to).some((k) => k in f.params)) return null;
  return evaluate(a.c, { ...f.params, ...adv.to }, f.fctx, f.base.segments, f.base.n, f.base.current.op).ev;
}

export function snapshotLog(a: Analysis, adv: AdvisorResult, src: { fileName: string; logIndex: number }, onError: (what: string, e: unknown) => void = () => {}): SessionSnapshot {
  const { c } = a;
  let pe: FilterEval | null = null;
  try {
    pe = planFilterEval(a, adv);
  } catch (e) {
    onError('plan eval', e);
  }
  const vb = col(c.log, 'vbatLatest');
  const H = c.log.header;
  return buildSnapshot({
    source: {
      fileName: src.fileName, logIndex: src.logIndex, datetime: H['Log start datetime'] || '', durationS: c.tSec[c.n - 1],
      firmware: c.fw.raw, fwCode: c.fw.code, board: H['Board information'] || '', craft: H['Craft name'] || '', fs: c.fs,
    },
    header: H, cards: a.cards, noise: a.nz, maskSeconds: a.fm.seconds, thrPct: c.thrPct,
    setpoint: [0, 1, 2].map((ax) => col(c.log, `setpoint[${ax}]`)),
    vbatCell: vb && c.cells ? Float32Array.from(vb, (v) => (v * 0.01) / c.cells) : null,
    mask: a.fm.mask, filterBase: a.filters?.base ?? null, pid: a.pid, advice: adv, planEval: pe,
  });
}
