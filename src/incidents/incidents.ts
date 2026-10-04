// Журнал инцидентов: «пошло не так» после полёта по совету. Утилита сама дополняет случай
// (метрики до/после, прогноз против факта, признаки, подозреваемое правило), считает по
// истории борта, какие правила ухудшали результат, и выдаёт откат настроек.
// Обучение = явные правки правил и порогов (CLAUDE.md, «Разбор инцидента») + эта статистика.

import cfg from '../config/analysis.json';
import type { BoardKnowledge } from '../advisor/advisor';
import { CliResult, cliDiff } from '../params/registry';
import { Comparability, MetricRow, PlanCheck, comparability, metricRows, pidBandScale, planCheck } from '../sessions/compare';
import type { SessionRecord } from '../sessions/db';
import type { SessionSnapshot } from '../sessions/snapshot';

const C = cfg.incidents;

export const SYMPTOMS = ['hot-motors', 'hover-oscillation', 'propwash', 'bounceback', 'sluggish', 'drift', 'video-vibration', 'desync', 'crash', 'other'] as const;
export type Symptom = (typeof SYMPTOMS)[number];

export interface Incident {
  /** INC-0001… (сквозная нумерация в базе) */
  id: string;
  projectId: string;
  /** сессия, после которой проблема (полёт «стало») */
  sessionId: string;
  /** сессия «было» (с планом), null — нет */
  beforeId: string | null;
  createdAt: string;
  symptoms: Symptom[];
  text: string;
  /** момент в логе, с (null — весь полёт) */
  tLog: number | null;
  severity: 1 | 2 | 3;
  /** температура моторов на ощупь: 0 холодные, 1 тёплые, 2 горячие, 3 обжигают */
  motorTemp: 0 | 1 | 2 | 3 | null;
  /** ссылка на видео / заметка */
  media: string;
  status: 'open' | 'resolved';
  resolution: string;
}

export type Sign = 'dterm-up' | 'noise-up' | 'new-peak' | 'overshoot-up' | 'settle-off' | 'delay-up' | 'mechanics' | 'sat';

export interface Finding {
  sign: Sign;
  axis?: number;
  a?: number;
  b?: number;
  hz?: number;
  /** id правил механики, сработавших на полёте «стало» */
  rules?: string[];
}

export interface Suspect {
  rule: string;
  score: number;
  /** совпавшие признаки и симптомы */
  signs: Sign[];
  symptoms: Symptom[];
}

export interface AutoAnalysis {
  comparability: Comparability;
  plan: PlanCheck;
  rows: MetricRow[];
  /** строка, где прогноз разошёлся с фактом сильнее всего */
  worstPrediction: (MetricRow & { errPct: number }) | null;
  findings: Finding[];
  suspects: Suspect[];
  /** изменено вне плана — тоже подозреваемые */
  extraChanged: string[];
}

/** чем рискует правило: признаки на логе и симптомы пилота (из текстов «Риск» правил) */
const RISK: Record<string, { signs: Sign[]; symptoms: Symptom[] }> = {
  'R-FLT-GYRO-RAISE-01': { signs: ['noise-up', 'dterm-up', 'new-peak'], symptoms: ['hot-motors', 'hover-oscillation', 'video-vibration'] },
  'R-FLT-DTERM-RAISE-01': { signs: ['dterm-up', 'new-peak'], symptoms: ['hot-motors', 'video-vibration'] },
  'R-FLT-DTERM-HOT-01': { signs: ['delay-up', 'overshoot-up'], symptoms: ['propwash', 'bounceback', 'sluggish'] },
  'R-FLT-GYRO-NOISY-01': { signs: ['delay-up', 'overshoot-up'], symptoms: ['propwash', 'sluggish', 'bounceback'] },
  'R-DYN-NOTCH-RANGE-01': { signs: ['new-peak', 'noise-up'], symptoms: ['video-vibration', 'hover-oscillation'] },
  'R-PID-OVERSHOOT-01': { signs: ['dterm-up', 'settle-off'], symptoms: ['hot-motors', 'hover-oscillation', 'sluggish', 'propwash'] },
  'R-PID-SLUGGISH-01': { signs: ['overshoot-up'], symptoms: ['bounceback', 'hover-oscillation', 'hot-motors'] },
  'R-PID-SAG-01': { signs: ['overshoot-up'], symptoms: ['bounceback', 'hover-oscillation'] },
};

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** места, где спектр после фильтров вырос (дБ, сглажено по ~5 Гц) */
function newPeaks(a: SessionSnapshot, b: SessionSnapshot, axis: number): { hz: number; db: number }[] {
  const da = a.noise.axes[axis].filtDb, db = b.noise.axes[axis].filtDb;
  const df = a.noise.df;
  const n = Math.min(da.length, db.length, Math.floor(Math.min(a.noise.nyquist, b.noise.nyquist) / df));
  const w = Math.max(1, Math.round(5 / df));
  const d: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += db[k] - da[k]; c++; }
    d.push(s / c);
  }
  const out: { hz: number; db: number }[] = [];
  for (let i = Math.ceil(C.peakMinHz / df); i < n - 1; i++) {
    if (d[i] >= C.peakRiseDb && d[i] >= d[i - 1] && d[i] >= d[i + 1] && !out.some((p) => Math.abs(p.hz - i * df) < 20)) out.push({ hz: i * df, db: d[i] });
  }
  return out.sort((x, y) => y.db - x.db).slice(0, 3);
}

export function autoAnalyze(before: SessionSnapshot, after: SessionSnapshot, inc: Pick<Incident, 'symptoms'>): AutoAnalysis {
  const cmp = comparability(before, after);
  const plan = planCheck(before, after);
  const rows = metricRows(before, after);
  const pr = rows.filter((r) => r.pred !== undefined && fin(r.b) && Math.abs(r.b) > 1e-9).map((r) => ({ ...r, errPct: (Math.abs(r.pred! - r.b) / Math.abs(r.b)) * 100 }));
  const worstPrediction = pr.length ? pr.reduce((x, y) => (y.errPct > x.errPct ? y : x)) : null;

  const findings: Finding[] = [];
  const pct = (a: number, b: number): number => ((b - a) / Math.max(Math.abs(a), 1e-9)) * 100;
  for (const r of rows) {
    if (!fin(r.a) || !fin(r.b)) continue;
    if (r.id === 'dterm' && pct(r.a, r.b) >= C.dtermRisePct) findings.push({ sign: 'dterm-up', axis: r.axis, a: r.a, b: r.b });
    if (r.id === 'noiseFilt' && pct(r.a, r.b) >= C.noiseRisePct) findings.push({ sign: 'noise-up', axis: r.axis, a: r.a, b: r.b });
    if (r.id === 'overshoot' && r.b - r.a >= C.overshootRisePp) findings.push({ sign: 'overshoot-up', axis: r.axis, a: r.a, b: r.b });
    if (r.id === 'settle' && Math.abs(1 - r.b) - Math.abs(1 - r.a) >= C.settleDrop) findings.push({ sign: 'settle-off', axis: r.axis, a: r.a, b: r.b });
    if ((r.id === 'delay100' || r.id === 'delayD100') && r.b - r.a >= C.delayRiseMs) findings.push({ sign: 'delay-up', a: r.a, b: r.b });
  }
  for (let ax = 0; ax < 3; ax++) for (const p of newPeaks(before, after, ax)) findings.push({ sign: 'new-peak', axis: ax, hz: Math.round(p.hz), b: +p.db.toFixed(1) });
  const mech = after.advice.filter((x) => x.kind === 'mechanic').map((x) => x.id);
  if (mech.length) findings.push({ sign: 'mechanics', rules: mech });
  const satA = before.cards.find((c) => c.id === 'motors')?.status, satB = after.cards.find((c) => c.id === 'motors')?.status;
  if (satB === 'red' && satA !== 'red') findings.push({ sign: 'sat' });

  // подозреваемые — применённые правила плана, чьи риски совпали с увиденным
  const signs = new Set(findings.map((f) => f.sign));
  const suspects: Suspect[] = [];
  for (const r of plan.rules) {
    if (r.state === 'not') continue;
    const id = r.rule.split('@')[0];
    const risk = RISK[id];
    if (!risk) continue;
    const s = risk.signs.filter((x) => signs.has(x));
    const y = risk.symptoms.filter((x) => inc.symptoms.includes(x));
    suspects.push({ rule: r.rule, score: s.length + 2 * y.length, signs: s, symptoms: y });
  }
  suspects.sort((x, y) => y.score - x.score);
  return { comparability: cmp, plan, rows, worstPrediction, findings, suspects, extraChanged: plan.extra.map((x) => x.key) };
}

/** итог применения правила между двумя полётами: стало ли хуже по его же цели */
function ruleWorse(id: string, rows: MetricRow[]): boolean {
  const worse = (m: string): boolean => rows.some((r) => r.id === m && r.verdict === 'worse');
  switch (id) {
    case 'R-FLT-DTERM-HOT-01': return worse('dterm');
    case 'R-FLT-GYRO-NOISY-01': case 'R-DYN-NOTCH-RANGE-01': return worse('noiseFilt');
    case 'R-FLT-GYRO-RAISE-01': case 'R-FLT-DTERM-RAISE-01':
      return rows.some((r) => (r.id === 'dterm' || r.id === 'noiseFilt') && fin(r.a) && fin(r.b) && ((r.b - r.a) / Math.max(r.a, 1e-9)) * 100 >= C.dtermRisePct);
    case 'R-PID-OVERSHOOT-01': return worse('overshoot');
    case 'R-PID-SLUGGISH-01': return worse('stepDelay');
    case 'R-PID-SAG-01': return worse('settle');
    default: return false;
  }
}

export interface RuleStat { n: number; worse: number; incidents: string[] }

/**
 * Статистика правил на борту: пары соседних сессий, где правило применено целиком; «хуже» —
 * если по его цели стало хуже (на сопоставимых полётах) или на «стало» есть инцидент, где
 * правило — главный подозреваемый.
 */
export function ruleStats(sessions: SessionRecord[], incidents: Incident[]): Record<string, RuleStat> {
  const out: Record<string, RuleStat> = {};
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const list = [...sessions].sort((x, y) => (x.snap.source.datetime || x.savedAt).localeCompare(y.snap.source.datetime || y.savedAt));
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (a.projectId !== b.projectId || !a.snap.plan) continue;
    const pc = planCheck(a.snap, b.snap);
    const cmp = comparability(a.snap, b.snap);
    const rows = metricRows(a.snap, b.snap);
    const incs = incidents.filter((x) => x.sessionId === b.id);
    for (const r of pc.rules) {
      if (r.state !== 'applied') continue;
      const id = r.rule.split('@')[0];
      const st = (out[id] ??= { n: 0, worse: 0, incidents: [] });
      st.n++;
      const blamed = incs.filter((inc) => {
        const before = inc.beforeId ? byId.get(inc.beforeId) : a;
        if (!before) return false;
        return autoAnalyze(before.snap, b.snap, inc).suspects[0]?.rule.split('@')[0] === id;
      });
      if (blamed.length || (cmp.status !== 'red' && ruleWorse(id, rows))) st.worse++;
      for (const inc of blamed) if (!st.incidents.includes(inc.id)) st.incidents.push(inc.id);
    }
  }
  return out;
}

/** соседние пары сессий борта (по времени полёта) — для калибровки прогноза */
export function sessionPairs(sessions: SessionRecord[]): { a: SessionSnapshot; b: SessionSnapshot }[] {
  const list = [...sessions].sort((x, y) => (x.snap.source.datetime || x.savedAt).localeCompare(y.snap.source.datetime || y.savedAt));
  const out: { a: SessionSnapshot; b: SessionSnapshot }[] = [];
  for (let i = 1; i < list.length; i++) if (list[i].projectId === list[i - 1].projectId) out.push({ a: list[i - 1].snap, b: list[i].snap });
  return out;
}

/** знание о борте для советчика: правила «с осторожностью» по статистике + профиль + калибровка */
export function boardKnowledge(stats: Record<string, RuleStat>, profile: { disabledRules?: string[]; dSensitive?: boolean } = {}, sessions: SessionRecord[] = []): BoardKnowledge {
  const A = cfg.advisor;
  const caution: BoardKnowledge['caution'] = {};
  for (const [id, s] of Object.entries(stats)) {
    if (s.n >= A.cautionMinApplied && s.worse / s.n >= A.cautionWorseShare) caution[id] = { worse: s.worse, n: s.n, incidents: s.incidents };
  }
  return { caution, disabledRules: profile.disabledRules ?? [], dSensitive: profile.dSensitive ?? false, pidBandScale: pidBandScale(sessionPairs(sessions)).scale };
}

/** точность прогнозов фильтров на этом борту (медиана по парам с применённым планом) */
export function predictionHistory(sessions: SessionRecord[]): number[] {
  const list = [...sessions].sort((x, y) => (x.snap.source.datetime || x.savedAt).localeCompare(y.snap.source.datetime || y.savedAt));
  const out: number[] = [];
  for (let i = 1; i < list.length; i++) {
    const rows = metricRows(list[i - 1].snap, list[i].snap).filter((r) => r.pred !== undefined && fin(r.b) && Math.abs(r.b) > 1e-9);
    if (!rows.length) continue;
    const e = rows.map((r) => (Math.abs(r.pred! - r.b) / Math.abs(r.b)) * 100).sort((x, y) => x - y);
    out.push(e[Math.floor(e.length / 2)]);
  }
  return out;
}

/** прошлая «удачная» сессия: последняя раньше этой, без инцидентов */
export function lastGood(session: SessionRecord, sessions: SessionRecord[], incidents: Incident[]): SessionRecord | null {
  const bad = new Set(incidents.map((i) => i.sessionId));
  const key = (s: SessionRecord): string => s.snap.source.datetime || s.savedAt;
  return sessions.filter((s) => s.projectId === session.projectId && s.id !== session.id && !bad.has(s.id) && key(s) < key(session)).sort((x, y) => key(x).localeCompare(key(y))).pop() ?? null;
}

/** CLI отката: вернуть значения прошлой сессии (только известные параметры своей версии) */
export function rollbackCli(current: SessionSnapshot, previous: SessionSnapshot): CliResult {
  return cliDiff(current.cli, previous.cli, current.source.fwCode);
}

/** серьёзный случай: откат показываем первым, крупно */
export function isSevere(inc: Pick<Incident, 'symptoms' | 'severity'>): boolean {
  return inc.severity === 3 || inc.symptoms.includes('crash') || (inc.symptoms.includes('hover-oscillation') && inc.severity >= 2);
}
