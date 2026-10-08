// Кампания настройки (A1–A2): серия сессий одного борта с общей целью. Итерация = полёт;
// для каждой — что было предложено (план прошлой сессии), что реально применено (по заголовку
// этого лога), что вышло (метрики против прошлого полёта, только если полёты сопоставимы), и
// проверка протокола тестового полёта (хватает ли манёвров, тот же ли полёт).
// Чистые функции — без базы и интерфейса.

import cfg from '../config/analysis.json';
import { Comparability, MetricRow, PlanCheck, comparability, metricRows, planCheck } from '../sessions/compare';
import type { SessionRecord } from '../sessions/db';
import type { SessionSnapshot } from '../sessions/snapshot';
import type { FeelTag, PropsState } from '../autotune/autotune';

// autotune — серия автотюна (создаётся кнопкой «Автотюн», в списке целей новой кампании её нет)
export type GoalKind = 'propwash' | 'cooler' | 'noise' | 'sharper' | 'other' | 'autotune';
export const GOALS: GoalKind[] = ['propwash', 'cooler', 'noise', 'sharper', 'other'];

/** отметки пилота к полёту: то, чего нет в логе */
export interface SessionMark {
  /** моторы на ощупь: 0 холодные, 1 тёплые, 2 горячие, 3 обжигают */
  motorTemp: 0 | 1 | 2 | 3 | null;
  feel: string;
  /** пропы в этом полёте (автотюн): целые / сколы / побиты */
  props?: PropsState | null;
  /** ощущения отметками (автотюн) */
  tags?: FeelTag[];
}

export interface Campaign {
  id: string;
  projectId: string;
  goal: GoalKind;
  title: string;
  createdAt: string;
  status: 'open' | 'closed';
  sessionIds: string[];
  marks: Record<string, SessionMark>;
  notes: string;
}

const P = cfg.protocol;

export interface ProtocolNeeds {
  hoverS: number;
  flips: number;
  punches: number;
  chops: number;
}

/** сколько манёвров нужно; цель может требовать больше (пропвош — сбросы газа) */
export function protocolNeeds(goal: GoalKind): ProtocolNeeds {
  const g = (P.goalNeed as Record<string, { hoverS?: number; chop?: number; flip?: number; punch?: number }>)[goal] ?? {};
  return { hoverS: g.hoverS ?? P.hover.needS, flips: g.flip ?? P.flip.need, punches: g.punch ?? P.punch.need, chops: g.chop ?? P.chop.need };
}

export type ProtoId = 'flight' | 'hover' | 'flipsRoll' | 'flipsPitch' | 'punches' | 'chops' | 'logRate' | 'unfilt' | 'comparable';

export interface ProtoItem {
  id: ProtoId;
  state: 'ok' | 'bad' | 'na';
  have: number | string | null;
  need: number | string | null;
}

export interface ProtocolCheck {
  items: ProtoItem[];
  /** сопоставимость с прошлым полётом кампании (null — первый полёт) */
  fair: Comparability | null;
  /** все пункты выполнены — сравнение с прошлым полётом честное */
  ok: boolean;
  /** что дослетать / поменять (id пунктов с state = bad) */
  todo: ProtoId[];
}

/** проверка полёта по протоколу: манёвры, настройки лога, сопоставимость с прошлым полётом */
export function checkProtocol(s: SessionSnapshot, prev: SessionSnapshot | null, goal: GoalKind): ProtocolCheck {
  const need = protocolNeeds(goal);
  const m = s.flight.maneuvers;
  const it = (id: ProtoId, have: number | null, needV: number): ProtoItem => ({ id, have, need: needV, state: have === null ? 'na' : have >= needV ? 'ok' : 'bad' });
  const items: ProtoItem[] = [
    it('flight', s.flight.seconds, P.minFlightS),
    it('hover', m ? m.hoverS : null, need.hoverS),
    it('flipsRoll', m ? m.flips[0] : null, need.flips),
    it('flipsPitch', m ? m.flips[1] : null, need.flips),
    it('punches', m ? m.punches : null, need.punches),
    it('chops', m ? m.chops : null, need.chops),
    it('logRate', Math.round(s.source.fs), P.minLogHz),
    { id: 'unfilt', have: s.noise.axes[0]?.rmsUnfilt !== null ? 1 : 0, need: 1, state: s.noise.axes[0]?.rmsUnfilt !== null ? 'ok' : 'bad' },
  ];
  const fair = prev ? comparability(prev, s) : null;
  if (fair) items.push({ id: 'comparable', have: fair.status, need: 'green', state: fair.status === 'red' ? 'bad' : 'ok' });
  const todo = items.filter((i) => i.state === 'bad').map((i) => i.id);
  return { items, fair, ok: !todo.length, todo };
}

/** сессии кампании по времени полёта */
export function campaignSessions(c: Campaign, all: SessionRecord[]): SessionRecord[] {
  const set = new Set(c.sessionIds);
  return all.filter((s) => set.has(s.id)).sort((x, y) => (x.snap.source.datetime || x.savedAt).localeCompare(y.snap.source.datetime || y.savedAt));
}

export interface Iteration {
  n: number;
  session: SessionRecord;
  prev: SessionRecord | null;
  /** что предлагалось перед этим полётом (план прошлой сессии) */
  proposed: { rules: string[]; to: Record<string, number> } | null;
  /** что из предложенного стоит на борту в этом полёте (по заголовку лога) */
  applied: PlanCheck | null;
  /** что вышло: ключевые метрики против прошлого полёта */
  rows: MetricRow[];
  protocol: ProtocolCheck;
  mark: SessionMark | null;
}

/** ключевые метрики для ленты (полный список — в «Сессии и сравнение») */
const KEY = new Set(['noiseFilt', 'dterm', 'overshoot', 'delay100']);

export function iterations(c: Campaign, all: SessionRecord[]): Iteration[] {
  const ss = campaignSessions(c, all);
  return ss.map((s, i) => {
    const prev = i ? ss[i - 1] : null;
    const plan = prev?.snap.plan ?? null;
    return {
      n: i + 1,
      session: s,
      prev,
      proposed: plan ? { rules: plan.ruleIds, to: plan.to } : null,
      applied: prev ? planCheck(prev.snap, s.snap) : null,
      rows: prev ? metricRows(prev.snap, s.snap).filter((r) => KEY.has(r.id)) : [],
      protocol: checkProtocol(s.snap, prev?.snap ?? null, c.goal),
      mark: c.marks[s.id] ?? null,
    };
  });
}

export interface MetricSeries {
  /** номер итерации (1…N) */
  x: number[];
  /** шум после фильтров, макс. по осям, °/с */
  noiseFilt: number[];
  /** D-term, макс. по ролу/питчу */
  dterm: number[];
  /** перерегулирование, среднее по ролу/питчу, где хватает данных, % */
  overshoot: number[];
  /** задержка гиро-фильтров на 100 Гц, мс */
  delay: number[];
  /** температура моторов по отметке пилота (0…3) */
  motorTemp: number[];
}

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

export function metricSeries(c: Campaign, all: SessionRecord[]): MetricSeries {
  const ss = campaignSessions(c, all);
  const max = (v: (number | null)[]): number => {
    const f = v.filter(fin);
    return f.length ? Math.max(...f) : NaN;
  };
  return {
    x: ss.map((_, i) => i + 1),
    noiseFilt: ss.map((s) => max(s.snap.noise.axes.map((a) => a.rmsFilt))),
    dterm: ss.map((s) => max(s.snap.noise.axes.slice(0, 2).map((a) => a.rmsDterm))),
    overshoot: ss.map((s) => {
      const v = (s.snap.pid?.axes ?? []).slice(0, 2).filter((a) => a.enough && fin(a.overshootPct)).map((a) => a.overshootPct);
      return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN;
    }),
    delay: ss.map((s) => s.snap.filters?.delay100 ?? NaN),
    motorTemp: ss.map((s) => c.marks[s.id]?.motorTemp ?? NaN),
  };
}

/** открытая кампания борта, в которую попадают новые сессии (последняя открытая) */
export function openCampaign(cs: Campaign[], projectId: string): Campaign | null {
  return cs.filter((c) => c.projectId === projectId && c.status === 'open').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
