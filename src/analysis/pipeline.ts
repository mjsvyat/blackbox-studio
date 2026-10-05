// Полный путь «лог → анализ → советы → снимок сессии» одной цепочкой чистых функций.
// Его вызывает воркер; его же вызывают тесты и регрессионные случаи (tests/cases): что
// видит пользователь, то и проверяется.

import { AdvisorResult, BoardKnowledge, advisorInputFrom, runAdvisor } from '../advisor/advisor';
import { col } from '../decoder/decoder';
import { FilterBaseline, FilterEval, buildBaseline, evaluate } from '../filters/evaluate';
import { FilterContext, FilterParams, contextFromHeader, paramsFromHeader } from '../filters/settings';
import { PidResult, analyzePid } from '../pid/analyze';
import { PidGains, gainsFromHeader, simplifiedFromHeader } from '../pid/gains';
import { AxisForecast, Sysid, forecastAxis, gainsRatio, identify } from '../sysid/predict';
import { SessionSnapshot, buildSnapshot } from '../sessions/snapshot';
import { LogContext } from './context';
import { FlightMask, buildFlightMask } from './flightMask';
import { HealthResult, analyzeHealth } from './health';
import { ManeuverCount, countManeuvers } from './maneuvers';
import { NoiseResult, analyzeNoise } from './noise';
import { Card, LogMeta, buildSummary } from './summary';

export interface Analysis {
  c: LogContext;
  fm: FlightMask;
  nz: NoiseResult;
  h: HealthResult;
  filters: { params: FilterParams; fctx: FilterContext; base: FilterBaseline; sim: ReturnType<typeof buildBaseline>['sim'] } | null;
  pid: PidResult | null;
  /** манёвры для протокола тестового полёта (A2) */
  maneuvers: ManeuverCount;
  /** модель оси для прогноза PID (null — не построена) */
  sysid: Sysid | null;
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
  let sysid: Sysid | null = null;
  if (pid) {
    try {
      sysid = identify(c, fm.mask, pid);
    } catch (e) {
      onError('sysid', e);
    }
  }
  const cards = buildSummary(c, fm, nz, h, meta, filters?.base ?? null, pid);
  const maneuvers = countManeuvers(c, fm.mask);
  return { c, fm, nz, h, filters, pid, maneuvers, sysid, cards };
}

/** советы + ожидаемый эффект советов по фильтрам (точная модель, как в песочнице) */
export function adviseLog(a: Analysis, onError: (what: string, e: unknown) => void = () => {}, board?: BoardKnowledge, override: Record<string, unknown> = {}): AdvisorResult {
  const { c, nz, h, filters: f } = a;
  const inp = advisorInputFrom(c, nz, h, f ? { params: f.params, status: f.base.validation.status, reason: f.base.validation.reason } : null, a.pid, simplifiedFromHeader(c.log.header));
  if (board) inp.board = board;
  const res = runAdvisor(inp, override);
  // прогноз PID по модели оси для советов, меняющих PID или фильтры
  for (const adv of res.advice) {
    if (adv.kind !== 'tune' || !Object.keys(adv.changes).length) continue;
    try {
      const fc = pidForecast(a, adv.changes, board?.pidBandScale ?? 1);
      if (fc.length) adv.forecast = fc;
    } catch (e) {
      onError('pid forecast', e);
    }
  }
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

/** новые PID после изменений CLI (p_roll, d_max_pitch…) */
export function applyPidChanges(g: PidGains, ch: Record<string, number>): PidGains {
  const out: PidGains = { P: [...g.P], I: [...g.I], D: [...g.D], F: [...g.F], dExtra: g.dExtra ? [...g.dExtra] : null, dExtraKind: g.dExtraKind };
  ['roll', 'pitch', 'yaw'].forEach((ax, i) => {
    if (ch[`p_${ax}`] !== undefined) out.P[i] = ch[`p_${ax}`];
    if (ch[`i_${ax}`] !== undefined) out.I[i] = ch[`i_${ax}`];
    if (ch[`d_${ax}`] !== undefined) out.D[i] = ch[`d_${ax}`];
    if (ch[`f_${ax}`] !== undefined) out.F[i] = ch[`f_${ax}`];
  });
  return out;
}

/** прогноз с кривыми (песочница PID) */
export function pidForecastCurves(a: Analysis, changes: Record<string, number>, bandScale = 1): AxisForecast[] {
  if (!a.sysid || !a.pid) return [];
  const g = gainsRatio(gainsFromHeader(a.c.log.header), applyPidChanges(gainsFromHeader(a.c.log.header), changes), filterDelays(a, changes));
  return a.sysid.axes.map((m) => forecastAxis(m, g[m.axis], a.sysid!.t, bandScale));
}

/** изменение задержек фильтров (на 50 Гц) под изменения CLI; undefined — фильтры не меняются */
function filterDelays(a: Analysis, changes: Record<string, number>): { dGyroMs: number; dDtermMs: number } | undefined {
  const f = a.filters;
  if (!f || !Object.keys(changes).some((k) => k in f.params && changes[k] !== f.params[k])) return undefined;
  try {
    const ev = evaluate(a.c, { ...f.params, ...changes }, f.fctx, f.base.segments, f.base.n, f.base.current.op).ev;
    return { dGyroMs: ev.delay.gyro['50'] - f.base.current.delay.gyro['50'], dDtermMs: ev.delay.dterm['50'] - f.base.current.delay.dterm['50'] };
  } catch {
    return undefined;
  }
}

/** прогноз step response под изменения CLI (PID; задержки фильтров — если меняются фильтры) */
export function pidForecast(a: Analysis, changes: Record<string, number>, bandScale = 1): NonNullable<import('../advisor/advisor').Advice['forecast']> {
  if (!a.sysid || !a.pid) return [];
  const cur = gainsFromHeader(a.c.log.header);
  const delays = filterDelays(a, changes);
  const g = gainsRatio(cur, applyPidChanges(cur, changes), delays);
  return a.sysid.axes.filter((m) => m.ok).map((m) => {
    const fc = forecastAxis(m, g[m.axis], a.sysid!.t, bandScale);
    return { axis: m.axis, now: fc.nowMetrics, overshoot: fc.overshoot, delayMs: fc.delayMs, settle: fc.settle };
  });
}

/** пересчёт фильтров этого полёта под план (null — план фильтры не трогает) */
export function planFilterEval(a: Analysis, adv: AdvisorResult): FilterEval | null {
  const f = a.filters;
  if (!f || !Object.keys(adv.to).some((k) => k in f.params)) return null;
  return evaluate(a.c, { ...f.params, ...adv.to }, f.fctx, f.base.segments, f.base.n, f.base.current.op).ev;
}

export function snapshotLog(a: Analysis, adv: AdvisorResult, src: { fileName: string; logIndex: number; byteStart?: number; byteEnd?: number }, onError: (what: string, e: unknown) => void = () => {}, bandScale = 1): SessionSnapshot {
  const { c } = a;
  let planPid: ReturnType<typeof pidForecast> = [];
  try {
    if (Object.keys(adv.to).length) planPid = pidForecast(a, adv.to, bandScale);
  } catch (e) {
    onError('plan pid', e);
  }
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
      fileName: src.fileName, logIndex: src.logIndex, byteStart: src.byteStart, byteEnd: src.byteEnd, datetime: H['Log start datetime'] || '', durationS: c.tSec[c.n - 1],
      firmware: c.fw.raw, fwCode: c.fw.code, board: H['Board information'] || '', craft: H['Craft name'] || '', fs: c.fs,
    },
    header: H, cards: a.cards, noise: a.nz, maskSeconds: a.fm.seconds, thrPct: c.thrPct,
    setpoint: [0, 1, 2].map((ax) => col(c.log, `setpoint[${ax}]`)),
    vbatCell: vb && c.cells ? Float32Array.from(vb, (v) => (v * 0.01) / c.cells) : null,
    mask: a.fm.mask, filterBase: a.filters?.base ?? null, pid: a.pid, advice: adv, planEval: pe, planPid, maneuvers: a.maneuvers,
  });
}
