// Автотюн: полуавтоматический цикл «разобрали лог → записали на борт → слетал → снова разобрали».
// Это не второй советчик, а политика поверх правил (advisor.ts): тот же список правил с ID, но
// выбор на полёт другой — «не душить» борт.
//  - Побитые пропы: полёт не для настройки, ничего не меняем (шум и нагрев — от пропов).
//    Сколы или подозрение по шуму до фильтров (gyroUnfilt не зависит от настроек: если он
//    вырос против прошлых полётов серии — дело в механике) — по шуму этого полёта не решаем.
//  - Не душить: фильтры зажимаются, только если моторы реально горячие (отметка пилота), а не
//    «по цифре D-term»; ниже стартовых настроек серии больше чем на floorPct % — никогда.
//  - По одному изменению за полёт: видно, что сработало, и легко откатить.
//  - Пилоту нравится — не трогаем (кроме горячих моторов).
//  - Прошлое изменение сделало хуже (по цифрам своей цели или по ощущению) — следующий шаг
//    только откат; откатанное правило в этой серии больше не предлагается.
// Пороги — config/analysis.json → autotune; тексты — i18n (T.at, T.adv.rules['R-AT-*']).

import cfg from '../config/analysis.json';
import type { Advice, AdvisorInput } from '../advisor/advisor';
import { ruleWorse } from '../incidents/incidents';
import { comparability, metricRows, planCheck } from '../sessions/compare';
import type { SessionSnapshot } from '../sessions/snapshot';

const C = cfg.autotune;

/** состояние пропов в этом полёте (со слов пилота) */
export type PropsState = 'ok' | 'chipped' | 'damaged';
/** ощущения пилота от полёта */
export type FeelTag = 'good' | 'sluggish' | 'twitchy' | 'propwash' | 'jello' | 'worse';
export const FEEL_TAGS: FeelTag[] = ['good', 'sluggish', 'twitchy', 'propwash', 'jello', 'worse'];

export interface AutotuneCheckin {
  props: PropsState;
  /** моторы на ощупь после полёта: 0 холодные … 3 обжигают */
  motorTemp: 0 | 1 | 2 | 3;
  feel: FeelTag[];
}

export interface AutotuneRevert {
  /** параметр → значение сейчас на борту (стало) */
  from: Record<string, number>;
  /** параметр → значение до прошлого изменения */
  to: Record<string, number>;
  why: 'metric' | 'pilot' | 'hot';
  /** правила прошлого изменения */
  rules: string[];
}

/** контекст автотюна для советчика (уходит в воркер вместе со знанием о борте) */
export interface AutotuneCtx {
  checkin: AutotuneCheckin;
  /** настройки на старте серии (CLI первого полёта) — от них считается «не душить» */
  baseline: Record<string, number>;
  /** номер полёта в серии (1 — первый) */
  iteration: number;
  /** прошлое изменение надо откатить */
  revert?: AutotuneRevert | null;
  /** на сколько % шум до фильтров выше, чем в прошлых полётах серии с целыми пропами */
  unfiltJumpPct?: number | null;
  /** правила, уже откатанные в этой серии, — больше не предлагать */
  avoid?: string[];
}

export type AutotuneVerdict = 'props' | 'mechanics' | 'revert' | 'tune' | 'limit' | 'flight' | 'done';

/** что автотюн решил по этому полёту (в результат советчика и в снимок сессии) */
export interface AutotuneSummary {
  policy: string;
  verdict: AutotuneVerdict;
  iteration: number;
  checkin: AutotuneCheckin;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** правила, которые решают по шуму/нагреву (им нужны целые пропы) */
const NOISE_RULES = new Set(['R-FLT-DTERM-HOT-01', 'R-FLT-GYRO-NOISY-01', 'R-FLT-GYRO-RAISE-01', 'R-FLT-DTERM-RAISE-01', 'R-DYN-NOTCH-RANGE-01']);
const FILTER_KEY = /^(simplified_(gyro|dterm)_filter_multiplier|(gyro|dterm)_lpf[12]_(dyn_min|dyn_max|static)_hz)$/;
const GAIN_KEY = /^(p|d)_(roll|pitch|yaw)$|^d_(max|min)_(roll|pitch|yaw)$|^simplified_(master_multiplier|d_gain|pi_gain|d_max_gain|dmax_gain)$/;

const down = (a: Advice, re: RegExp): boolean => Object.entries(a.changes).some(([k, v]) => re.test(k) && isNum(a.from[k]) && v < a.from[k]);
const up = (a: Advice, re: RegExp): boolean => Object.entries(a.changes).some(([k, v]) => re.test(k) && isNum(a.from[k]) && v > a.from[k]);
/** зажимает фильтры (срез или множитель ниже) */
export const tightensFilters = (a: Advice): boolean => down(a, FILTER_KEY);
/** ослабляет фильтры или поднимает P/D — рискованно для нагрева */
const loosens = (a: Advice): boolean => up(a, FILTER_KEY) || up(a, GAIN_KEY);

/** изменение уводит фильтры или P/D ниже пола от стартовых настроек серии */
export function belowFloor(a: Advice, baseline: Record<string, number>): boolean {
  for (const [k, v] of Object.entries(a.changes)) {
    if (!isNum(a.from[k]) || v >= a.from[k]) continue;
    if (!FILTER_KEY.test(k) && !GAIN_KEY.test(k)) continue;
    if (/^simplified_(gyro|dterm)_filter_multiplier$/.test(k) && v < C.minFilterMultiplier) return true;
    const b = baseline[k];
    if (isNum(b) && b > 0 && v < (b * C.floorPct) / 100) return true;
  }
  return false;
}

type AddFn = (a: Omit<Advice, 'selected' | 'from' | 'changes' | 'sliders' | 'safety' | 'tab'> & Partial<Pick<Advice, 'from' | 'changes' | 'sliders' | 'safety' | 'tab'>>) => void;

/**
 * Политика автотюна: добавляет правила R-AT-* и заранее откладывает советы, которые сейчас
 * трогать нельзя (deferred). Вызывается советчиком до выбора на полёт; выбор уважает отложенное.
 */
export function autotunePolicy(out: Advice[], inp: AdvisorInput, add: AddFn): void {
  const at = inp.board?.autotune;
  if (!at) return;
  const ck = at.checkin;
  const hot = ck.motorTemp >= C.hotTemp;
  const suspect = ck.props === 'ok' && isNum(at.unfiltJumpPct) && at.unfiltJumpPct >= C.unfiltJumpPct;
  const avoid = new Set(at.avoid ?? []);
  const defer = (a: Advice, why: NonNullable<Advice['deferred']>): void => {
    if (!a.deferred) a.deferred = why;
  };

  // ---- пропы ----
  if (ck.props === 'damaged') add({ id: 'R-AT-PROPS-01', version: 1, kind: 'mechanic', severity: 'red', inputs: {}, tab: 'noise', priority: -2 });
  else if (ck.props === 'chipped') add({ id: 'R-AT-PROPS-CHIPPED-01', version: 1, kind: 'info', severity: 'yellow', inputs: {}, tab: 'noise', priority: 6 });
  if (suspect) add({ id: 'R-AT-PROPS-SUSPECT-01', version: 1, kind: 'info', severity: 'yellow', inputs: { jump: Math.round(at.unfiltJumpPct!), lim: C.unfiltJumpPct }, tab: 'noise', priority: 7 });

  // ---- откат прошлого изменения ----
  if (at.revert && ck.props !== 'damaged') {
    const rv = at.revert;
    add({ id: 'R-AT-REVERT-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { why: rv.why, rules: rv.rules.join(', ') || '—' }, tab: 'compare', priority: -1, from: { ...rv.from }, changes: { ...rv.to } });
  }

  // ---- ощущения ----
  const happy = ck.feel.includes('good') && !ck.feel.includes('worse');
  if (happy && !hot) add({ id: 'R-AT-HAPPY-01', version: 1, kind: 'info', severity: 'info', inputs: {}, tab: 'summary', priority: 95 });
  if (ck.feel.includes('propwash')) add({ id: 'R-AT-PROPWASH-01', version: 1, kind: 'info', severity: 'info', inputs: {}, tab: 'pid', priority: 96 });

  // ---- что в этот полёт не трогаем ----
  for (const a of out) {
    if (a.kind !== 'tune' || a.id === 'R-AT-REVERT-01') continue;
    if (ck.props === 'damaged') { defer(a, 'props'); continue; }
    if (at.revert) { defer(a, 'revert-only'); continue; }
    if (avoid.has(a.id)) { defer(a, 'reverted'); continue; }
    if ((ck.props === 'chipped' || suspect) && (NOISE_RULES.has(a.id) || up(a, GAIN_KEY))) { defer(a, 'props'); continue; }
    // «не душить»: зажимать фильтры по одной цифре D-term нельзя — только если моторы горячие
    // (или пилот видит «желе» в видео)
    if (tightensFilters(a) && !hot && !ck.feel.includes('jello')) { defer(a, 'not-hot'); continue; }
    if (belowFloor(a, at.baseline)) { defer(a, 'floor'); continue; }
    // горячие моторы — ничего не ослабляем и D не поднимаем
    if (hot && loosens(a)) { defer(a, 'hot'); continue; }
    // нравится — не трогаем, кроме красного (горячие моторы при целых пропах)
    if (happy && a.severity !== 'red') { defer(a, 'happy'); continue; }
  }
}

/** итог по полёту — после выбора на полёт */
export function autotuneSummary(adv: Advice[], inp: AdvisorInput): AutotuneSummary | undefined {
  const at = inp.board?.autotune;
  if (!at) return undefined;
  const ck = at.checkin;
  const sel = adv.filter((a) => a.kind === 'tune' && a.selected && Object.keys(a.changes).length);
  const happy = ck.feel.includes('good') && !ck.feel.includes('worse');
  let verdict: AutotuneVerdict;
  if (ck.props === 'damaged') verdict = 'props';
  else if (sel.some((a) => a.id === 'R-AT-REVERT-01')) verdict = 'revert';
  else if (adv.some((a) => a.kind === 'mechanic' && a.severity === 'red')) verdict = 'mechanics';
  else if (sel.length) verdict = 'tune';
  else if (!happy && adv.some((a) => a.deferred === 'floor')) verdict = 'limit';
  else if (!happy && adv.some((a) => a.id === 'R-STEP-DATA-01')) verdict = 'flight';
  else verdict = 'done';
  return { policy: C.version, verdict, iteration: at.iteration, checkin: ck };
}

// ---------------- контекст из истории серии (интерфейс и тесты) ----------------

/** шум гироскопа до фильтров, худшая из ролл/питч */
const unfiltOf = (s: SessionSnapshot): number => {
  const v = s.noise.axes.slice(0, 2).map((a) => a.rmsUnfilt).filter(isNum);
  return v.length ? Math.max(...v) : NaN;
};

/**
 * На сколько % шум до фильтров выше, чем в прошлых полётах серии с целыми пропами (медиана),
 * только по сопоставимым полётам. gyroUnfilt от настроек не зависит — рост значит механику.
 */
export function unfiltJump(refs: SessionSnapshot[], cur: SessionSnapshot): number | null {
  const now = unfiltOf(cur);
  if (!isNum(now)) return null;
  const v = refs.filter((r) => comparability(r, cur).status !== 'red').map(unfiltOf).filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const med = v[Math.floor(v.length / 2)];
  return med > 0 ? ((now / med) - 1) * 100 : null;
}

/**
 * Надо ли откатить прошлое изменение: план прошлого полёта стоит на борту, и по его цели стало
 * хуже (полёты сопоставимы), или пилот говорит «стало хуже», или моторы стали горячими после
 * ослабления фильтров / подъёма D. С побитыми пропами в этом полёте — не судим. Откат отката
 * не делаем (качели).
 */
export function revertFor(prev: SessionSnapshot, cur: SessionSnapshot, ck: AutotuneCheckin, prevTemp: number | null): AutotuneRevert | null {
  const plan = prev.plan;
  if (!plan || ck.props === 'damaged') return null;
  if (plan.ruleIds.some((r) => r.startsWith('R-AT-REVERT-01'))) return null;
  const pc = planCheck(prev, cur);
  if (pc.state !== 'applied' && pc.state !== 'partial') return null;
  const applied = pc.items.filter((i) => i.state === 'applied');
  if (!applied.length) return null;
  const rules = pc.rules.filter((r) => r.state !== 'not').map((r) => r.rule.split('@')[0]);
  let why: AutotuneRevert['why'] | null = null;
  if (ck.feel.includes('worse')) why = 'pilot';
  else if (comparability(prev, cur).status !== 'red' && rules.some((id) => ruleWorse(id, metricRows(prev, cur)))) why = 'metric';
  else {
    // стало горячо после изменения, которое греет (ослабили фильтры / подняли P/D)
    const heats = applied.some((i) => (FILTER_KEY.test(i.key) || GAIN_KEY.test(i.key)) && isNum(i.from) && isNum(i.planned) && i.planned > i.from);
    if (heats && ck.motorTemp >= C.hotTemp && (prevTemp === null || prevTemp < C.hotTemp)) why = 'hot';
  }
  if (!why) return null;
  const from: Record<string, number> = {};
  const to: Record<string, number> = {};
  for (const i of applied) {
    if (!isNum(i.from) || !isNum(i.actual)) continue;
    from[i.key] = i.actual;
    to[i.key] = i.from;
  }
  return Object.keys(to).length ? { from, to, why, rules } : null;
}

/** правила, откатанные в серии (по сохранённым снимкам) */
export function revertedRules(snaps: SessionSnapshot[]): string[] {
  const out = new Set<string>();
  for (const s of snaps) {
    for (const a of s.advice) {
      if (a.id !== 'R-AT-REVERT-01' || !a.selected) continue;
      for (const r of String(a.inputs.rules ?? '').split(',').map((x) => x.trim())) if (r && r !== '—') out.add(r);
    }
  }
  return [...out];
}
