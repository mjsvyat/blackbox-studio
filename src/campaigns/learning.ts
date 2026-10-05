// Обучение по истории (A3–A4) — без нейросети, видимыми цифрами:
//  - точность прогнозов: по каждой метрике — сколько раз факт попал в полосу прогноза, средняя
//    ошибка; только пары «план применён» и сопоставимые полёты;
//  - правила: сколько раз применены целиком, по их цели стало лучше / хуже / так же, инциденты,
//    «с осторожностью» (та же логика, что советчик: incidents.ts → ruleStats/boardKnowledge);
//  - предложения порогов: если накопились сессии, где порог явно не там (зелёный D-term, а моторы
//    горячие), — отчёт «какой порог, было → предлагаю, на каких сессиях видно, какие правила и
//    инциденты затронет». НЕ применяется: правит человек (analysis.json + _history) или Claude.

import cfg from '../config/analysis.json';
import { classValue } from '../config/classes';
import { Incident, boardKnowledge, ruleStats, ruleTarget, ruleWorse } from '../incidents/incidents';
import { comparability, metricRows, planCheck } from '../sessions/compare';
import type { SessionRecord } from '../sessions/db';
import type { Campaign } from './campaign';

const L = cfg.learning;
const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const key = (s: SessionRecord): string => s.snap.source.datetime || s.savedAt;
const sorted = (ss: SessionRecord[]): SessionRecord[] => [...ss].sort((a, b) => key(a).localeCompare(key(b)));

export interface MetricAcc {
  id: string;
  n: number;
  /** факт внутри полосы (PID) или в пределах predTolPct (фильтры) */
  inBand: number;
  meanErrPct: number;
  /** сессии «стало» с прогнозом */
  sessions: string[];
}

export interface RuleAcc {
  rule: string;
  applied: number;
  better: number;
  worse: number;
  same: number;
  incidents: string[];
  caution: boolean;
}

export interface Accuracy {
  /** пар «план применён, полёты сопоставимы» */
  pairs: number;
  metrics: MetricAcc[];
  rules: RuleAcc[];
}

/** пары «было → стало» внутри одного борта (сессии чужих бортов между ними не рвут пару) */
function boardPairs(sessions: SessionRecord[]): [SessionRecord, SessionRecord][] {
  const out: [SessionRecord, SessionRecord][] = [];
  const last = new Map<string, SessionRecord>();
  for (const s of sorted(sessions)) {
    const prev = last.get(s.projectId);
    if (prev) out.push([prev, s]);
    last.set(s.projectId, s);
  }
  return out;
}

export function accuracy(sessions: SessionRecord[], incidents: Incident[]): Accuracy {
  const m = new Map<string, { n: number; inBand: number; err: number; sessions: Set<string> }>();
  const r = new Map<string, RuleAcc>();
  const blank = (id: string): RuleAcc => ({ rule: id, applied: 0, better: 0, worse: 0, same: 0, incidents: [], caution: false });
  let pairs = 0;
  for (const [A, B] of boardPairs(sessions)) {
    if (!A.snap.plan) continue;
    const pc = planCheck(A.snap, B.snap);
    if (pc.state !== 'applied' && pc.state !== 'partial') continue;
    if (comparability(A.snap, B.snap).status === 'red') continue;
    pairs++;
    const rows = metricRows(A.snap, B.snap);
    for (const row of rows) {
      if (row.pred === undefined || !fin(row.b) || Math.abs(row.b) < 1e-9) continue;
      const e = (Math.abs(row.pred - row.b) / Math.abs(row.b)) * 100;
      const ok = row.band ? row.b >= row.band.lo && row.b <= row.band.hi : e <= L.predTolPct;
      const st = m.get(row.id) ?? { n: 0, inBand: 0, err: 0, sessions: new Set<string>() };
      st.n++;
      if (ok) st.inBand++;
      st.err += e;
      st.sessions.add(B.id);
      m.set(row.id, st);
    }
    for (const rr of pc.rules) {
      if (rr.state !== 'applied') continue;
      const id = rr.rule.split('@')[0];
      const st = r.get(id) ?? blank(id);
      st.applied++;
      // «хуже» — та же проверка, что у советчика (ruleStats); «лучше» — цель правила улучшилась
      const t = ruleTarget(id);
      if (ruleWorse(id, rows)) st.worse++;
      else if (rows.some((x) => x.id === t && x.verdict === 'better')) st.better++;
      else st.same++;
      r.set(id, st);
    }
  }
  // инциденты и «с осторожностью» — как у советчика (по каждому борту отдельно)
  for (const pid of new Set(sessions.map((s) => s.projectId))) {
    const own = sessions.filter((s) => s.projectId === pid);
    const stats = ruleStats(own, incidents.filter((i) => i.projectId === pid));
    const caution = boardKnowledge(stats, {}, own).caution ?? {};
    for (const [id, s] of Object.entries(stats)) {
      const st = r.get(id) ?? { ...blank(id), applied: s.n };
      st.incidents = [...new Set([...st.incidents, ...s.incidents])];
      st.caution ||= id in caution;
      r.set(id, st);
    }
  }
  return {
    pairs,
    metrics: [...m.entries()].map(([id, s]) => ({ id, n: s.n, inBand: s.inBand, meanErrPct: s.err / s.n, sessions: [...s.sessions] })),
    rules: [...r.values()].sort((a, b) => a.rule.localeCompare(b.rule)),
  };
}

export interface Evidence {
  sessionId: string;
  when: string;
  file: string;
  /** значение метрики на этой сессии */
  value: number;
  /** что говорит пилот (отметка) */
  motorTemp: number | null;
}

export interface Proposal {
  id: 'dterm-red-down' | 'dterm-red-up' | 'rule-disable';
  /** путь в analysis.json */
  path: string;
  was: number | string[];
  now: number | string[];
  evidence: Evidence[];
  /** правила, которые читают этот порог / о которых речь */
  rules: string[];
  /** инциденты, где эти правила — подозреваемые или которые на этих сессиях */
  incidents: string[];
  /** прошлые сессии борта, где вывод изменится (светофор D-term сменит цвет / совет пропадёт) */
  affected: Evidence[];
}

const dtermOf = (s: SessionRecord): number => {
  const v = s.snap.noise.axes.slice(0, 2).map((a) => a.rmsDterm).filter(fin);
  return v.length ? Math.max(...v) : NaN;
};

/**
 * Предложения порогов по кампании (или всем сессиям борта): только когда доказательств ≥ minEvidence.
 * cls — класс борта: правило «отключить» предлагается для класса, не для всех.
 */
export function proposeThresholds(c: Campaign, sessions: SessionRecord[], incidents: Incident[], cls: string = cfg.classes.default): Proposal[] {
  const out: Proposal[] = [];
  const board = sorted(sessions.filter((s) => s.projectId === c.projectId));
  const ss = board.filter((s) => c.sessionIds.includes(s.id));
  const ev = (s: SessionRecord, value: number): Evidence => ({ sessionId: s.id, when: key(s), file: `${s.snap.source.fileName} №${s.snap.source.logIndex}`, value: fin(value) ? +value.toFixed(2) : NaN, motorTemp: c.marks[s.id]?.motorTemp ?? null });
  // инциденты, записанные на сессиях-доказательствах (или где они — «до»)
  const incOf = (ids: string[]): string[] => [...new Set(incidents.filter((i) => ids.includes(i.sessionId) || ids.includes(i.beforeId ?? '')).map((i) => i.id))].sort();
  // порог — для класса борта (не для всех бортов): D-term «греет» по-разному на 3" и 7"
  const base = `classes.list.${cls}.overrides.`;
  const red = Number(classValue(cls, 'advisor.dtermRms.red'));
  const green = Number(classValue(cls, 'advisor.dtermRms.green'));
  const dRules = ['R-FLT-DTERM-HOT-01', 'R-FLT-DTERM-RAISE-01', 'R-PID-OVERSHOOT-01'];
  // прошлые сессии борта, у которых D-term между старым и новым порогом, — светофор сменит цвет
  const between = (a: number, b: number): Evidence[] => board.filter((s) => { const v = dtermOf(s); return fin(v) && v >= Math.min(a, b) && v < Math.max(a, b); }).map((s) => ev(s, dtermOf(s)));

  // «зелёный» (не красный) D-term, а моторы горячие → красный порог D-term ниже
  const hot = ss.filter((s) => (c.marks[s.id]?.motorTemp ?? -1) >= L.hotTemp && fin(dtermOf(s)) && dtermOf(s) < red);
  if (hot.length >= L.minEvidence) {
    const lo = Math.min(...hot.map(dtermOf));
    const now = Math.max(green, Math.floor(lo * (1 - L.marginPct / 100)));
    const ids = hot.map((s) => s.id);
    if (now < red) out.push({ id: 'dterm-red-down', path: `${base}advisor.dtermRms.red`, was: red, now, evidence: hot.map((s) => ev(s, dtermOf(s))), rules: dRules, incidents: incOf(ids), affected: between(now, red).filter((e) => !ids.includes(e.sessionId)) });
  }
  // «красный» D-term, а моторы холодные/тёплые → порог выше
  const cold = ss.filter((s) => { const t = c.marks[s.id]?.motorTemp; return t !== null && t !== undefined && t <= L.coldTemp && fin(dtermOf(s)) && dtermOf(s) >= red; });
  if (cold.length >= L.minEvidence) {
    const now = Math.ceil(Math.max(...cold.map(dtermOf)) * (1 + L.marginPct / 100));
    const ids = cold.map((s) => s.id);
    out.push({ id: 'dterm-red-up', path: `${base}advisor.dtermRms.red`, was: red, now, evidence: cold.map((s) => ev(s, dtermOf(s))), rules: dRules, incidents: incOf(ids), affected: between(red, now).filter((e) => !ids.includes(e.sessionId)) });
  }
  // правило стабильно ухудшает (как «с осторожностью») → отключить для класса борта
  const acc = accuracy(ss, incidents.filter((i) => ss.some((s) => s.id === i.sessionId)));
  const disabled = (classValue(cls, 'advisor.disabledRules') as string[] | undefined) ?? [];
  for (const r of acc.rules.filter((x) => x.caution && !disabled.includes(x.rule))) {
    // доказательства — сессии «стало», где по цели правила стало хуже
    const evid: Evidence[] = [];
    for (const [A, B] of boardPairs(ss)) {
      const pc = planCheck(A.snap, B.snap);
      if (!pc.rules.some((x) => x.state === 'applied' && x.rule.startsWith(`${r.rule}@`))) continue;
      const rows = metricRows(A.snap, B.snap);
      if (comparability(A.snap, B.snap).status === 'red' || !ruleWorse(r.rule, rows)) continue;
      const t = ruleTarget(r.rule);
      const row = rows.find((x) => x.id === t && x.verdict === 'worse') ?? rows.find((x) => x.id === t);
      evid.push(ev(B, row ? row.b : NaN));
    }
    // затронет: сессии борта, где правило советовалось (совет пропадёт)
    const affected = board.filter((s) => s.snap.advice.some((a) => a.id === r.rule && a.kind === 'tune')).map((s) => ev(s, NaN));
    if (evid.length >= L.minEvidence) out.push({ id: 'rule-disable', path: `${base}advisor.disabledRules`, was: disabled, now: [...disabled, r.rule], evidence: evid, rules: [r.rule], incidents: r.incidents, affected });
  }
  return out;
}

/** запись для _history раздела (подсказка тому, кто будет править analysis.json) */
export function historyEntry(p: Proposal, campaignTitle: string, configVersion: string): Record<string, unknown> {
  const [maj, min] = configVersion.split('.').map(Number);
  return { version: `${maj}.${(min || 0) + 1}`, was: p.was, now: p.now, why: `кампания «${campaignTitle}»: ${p.evidence.length} сессий (${p.evidence.map((e) => e.when.slice(0, 10)).join(', ')})`, by: 'кампания (A4)' };
}
