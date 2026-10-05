// Состояние приложения и связь с воркером.

import { T } from '../i18n/ru';
import type { FileStructure } from '../decoder/scan';
import type { AdvicePayload, AnalysisPayload, FiltersPayload, FromWorker, LogInfo, PidPayload, RatesPayload, ToWorker } from '../worker/protocol';
import type { FilterEval } from '../filters/evaluate';
import type { FilterParams } from '../filters/settings';
import type { RatesEval } from '../rates/analyze';
import type { SessionSnapshot } from '../sessions/snapshot';
import { BoardProfile, FcLogEntry, Project, SessionRecord, SessionStore, idbBackend, memoryBackend, newId } from '../sessions/db';
import type { BoardKnowledge } from '../advisor/advisor';
import { Incident, autoAnalyze, boardKnowledge, lastGood, ruleStats } from '../incidents/incidents';
import { buildCaseFiles, caseFolderName } from '../incidents/caseExport';
import { zip } from '../incidents/zip';
import { casePlots, dataUri } from './charts/png';
import { reportHtml } from '../report/report';
import { campaignExport, campaignHtml } from '../report/campaignReport';
import type { AxisForecast } from '../sysid/predict';
import type { RateProfile } from '../rates/rates';
import WorkerCtor from '../worker/worker.ts?worker&inline';
import { FcUi, initialFc } from './fcState';
import { AskReason, BoardKey, boardFor, boardKeyFromHeader, matchBoard } from '../sessions/boards';
import { Campaign, GoalKind, SessionMark, openCampaign } from '../campaigns/campaign';
import { DEFAULT_CLASS } from '../config/classes';
import { normalizeProfile } from '../sessions/profile';

export interface AppState {
  fileName: string | null;
  structure: FileStructure | null;
  info: LogInfo | null;
  analysis: AnalysisPayload | null;
  /** видимый диапазон времени на графиках, с */
  view: { t0: number; t1: number } | null;
  tab: string;
  noiseAxis: number;
  noiseSource: 'unfilt' | 'filt';
  progress: { stage: string; fraction: number } | null;
  error: string | null;
  filters: FiltersPayload | null;
  /** настройки в песочнице */
  sandbox: FilterParams | null;
  sandboxEval: FilterEval | null;
  sandboxBusy: boolean;
  filterAxis: number;
  /** рейты: база из воркера; null + ratesWhy — посчитать нельзя */
  rates: RatesPayload | null;
  ratesWhy: string | null;
  ratesSandbox: RateProfile | null;
  ratesEval: RatesEval | null;
  ratesBusy: boolean;
  /** выбранный манёвр (индекс в rates.maneuvers) */
  ratesManeuver: number;
  pid: PidPayload | null;
  advice: AdvicePayload | null;
  /** сессии: все проекты и сессии из базы; выбранные для сравнения A (было) и B (стало) */
  projects: Project[];
  sessions: SessionRecord[];
  dbPersistent: boolean | null;
  cmpA: string | null;
  cmpB: string | null;
  cmpAxis: number;
  sessionsBusy: boolean;
  sessionsMsg: string | null;
  incidents: Incident[];
  /** форма «сообщить о проблеме» для сессии */
  incidentForm: string | null;
  /** панель «вернуть прошлые настройки» для сессии */
  rollbackFor: string | null;
  /** знание о борте открытого лога (для советчика) */
  board: BoardKnowledge | null;
  /** песочница PID: изменения CLI и прогноз модели */
  pidSandbox: Record<string, number> | null;
  pidForecast: AxisForecast[] | null;
  pidBusy: boolean;
  /** полётник по USB */
  fc: FcUi;
  /** панель «перенести настройки» для борта (id получателя) */
  transferFor: string | null;
  /** видео: счётчик перерисовки (само состояние — в ui/video.ts) */
  videoTick: number;
  /** «это новый борт или существующий?» — ждёт ответа пилота перед сохранением сессии */
  boardAsk: { reason: AskReason; candidates: string[]; key: BoardKey } | null;
  /** кампании настройки (A1) и выбранная */
  campaigns: Campaign[];
  campaignId: string | null;
  /** снимок открытого лога (для проверки протокола до сохранения); null — не считан */
  openSnap: SessionSnapshot | null;
  openSnapBusy: boolean;
}

type Listener = (s: AppState, changed: Set<keyof AppState>) => void;

export const state: AppState = {
  fileName: null,
  structure: null,
  info: null,
  analysis: null,
  view: null,
  tab: 'file',
  noiseAxis: 0,
  noiseSource: 'unfilt',
  progress: null,
  error: null,
  filters: null,
  sandbox: null,
  sandboxEval: null,
  sandboxBusy: false,
  filterAxis: 0,
  rates: null,
  ratesWhy: null,
  ratesSandbox: null,
  ratesEval: null,
  ratesBusy: false,
  ratesManeuver: 0,
  pid: null,
  advice: null,
  projects: [],
  sessions: [],
  dbPersistent: null,
  cmpA: null,
  cmpB: null,
  cmpAxis: 0,
  sessionsBusy: false,
  sessionsMsg: null,
  incidents: [],
  incidentForm: null,
  rollbackFor: null,
  board: null,
  pidSandbox: null,
  pidForecast: null,
  pidBusy: false,
  fc: initialFc(),
  videoTick: 0,
  transferFor: null,
  boardAsk: null,
  campaigns: [],
  campaignId: null,
  openSnap: null,
  openSnapBusy: false,
};

const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(patch: Partial<AppState>): void {
  const changed = new Set<keyof AppState>();
  for (const [k, v] of Object.entries(patch) as [keyof AppState, unknown][]) {
    if (state[k] !== v) {
      (state as unknown as Record<string, unknown>)[k] = v;
      changed.add(k);
    }
  }
  if (changed.size) for (const l of [...listeners]) l(state, changed);
}

// --- воркер ---
const worker: Worker = new WorkerCtor();
let reqSeq = 0;
const pending = new Map<number, (r: { x: Float64Array; ys: Float32Array[]; raw: boolean }) => void>();

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'progress':
      set({ progress: m.fraction >= 1 && !m.stage ? null : { stage: m.stage, fraction: m.fraction } });
      break;
    case 'scanned': {
      set({ structure: m.structure, fileName: m.name, info: null, analysis: null, view: null, progress: null, tab: 'file', error: null });
      // единственный нормальный лог — открываем сразу
      const usable = m.structure.logs.filter((l) => l.duplicateOf === null && l.headerOk && !l.empty);
      if (usable.length === 1) openLog(usable[0].index);
      break;
    }
    case 'opened':
      queueMicrotask(() => void syncBoardClass());
      set({ filters: null, sandbox: null, sandboxEval: null, rates: null, ratesWhy: null, ratesSandbox: null, ratesEval: null, ratesManeuver: 0, pid: null, advice: null, pidSandbox: null, pidForecast: null, openSnap: null, info: m.info, analysis: m.analysis, view: { t0: 0, t1: m.info.durationS }, progress: null, error: null, tab: state.tab === 'file' ? 'summary' : state.tab });
      break;
    case 'analysis':
      set({ analysis: m.analysis, progress: null, filters: null, sandboxEval: null, rates: null, ratesEval: null, ratesManeuver: 0, pid: null, advice: null, pidForecast: null, openSnap: null });
      break;
    case 'filters':
      if (state.sandbox) {
        // участок анализа поменялся — песочницу пересчитать на новых данных
        set({ filters: m.payload, progress: null });
        requestSandbox(state.sandbox);
      } else set({ filters: m.payload, sandbox: { ...m.payload.params }, sandboxEval: m.payload.base.current, progress: null });
      break;
    case 'filtersEval':
      if (m.reqId === sandboxReq) set({ sandboxEval: m.ev, sandboxBusy: false });
      break;
    case 'rates':
      set({ rates: m.payload, ratesWhy: m.payload ? null : m.why ?? 'unknown', progress: null });
      // участок анализа поменялся, а в песочнице уже что-то есть — пересчитать
      if (m.payload) requestRatesEval(state.ratesSandbox ?? m.payload.profile, 0);
      break;
    case 'ratesEval':
      if (m.reqId === ratesReq) set({ ratesEval: m.ev, ratesBusy: false });
      break;
    case 'pid':
      set({ pid: m.payload, progress: null });
      if (state.pidSandbox) requestPidForecast(state.pidSandbox, 0);
      break;
    case 'pidPredict':
      if (m.reqId === pidReq) set({ pidForecast: m.axes, pidBusy: false });
      break;
    case 'advice':
      set({ advice: m.payload, progress: null });
      break;
    case 'snapshot': {
      const cb = snapPending.get(m.reqId);
      snapPending.delete(m.reqId);
      cb?.(m.snap);
      break;
    }
    case 'series': {
      const cb = pending.get(m.reqId);
      pending.delete(m.reqId);
      cb?.(m);
      break;
    }
    case 'error':
      set({ error: m.message, progress: null });
      break;
  }
};

worker.onerror = (e) => {
  set({ error: `Воркер анализа не запустился: ${e.message || 'неизвестная ошибка'}. Попробуй открыть через npm run dev.`, progress: null });
};

const send = (m: ToWorker): void => worker.postMessage(m);

let openedFile: File | null = null;
export function openFile(f: File): void {
  openedFile = f;
  set({ progress: { stage: 'Чтение файла', fraction: 0 }, error: null });
  send({ type: 'scan', file: f, name: f.name });
}

export function openLog(index: number): void {
  set({ progress: { stage: 'Открываю лог', fraction: 0 }, error: null });
  send({ type: 'open', logIndex: index });
}

export function setAnalysisRange(range: { t0: number; t1: number } | null): void {
  set({ progress: { stage: 'Пересчёт', fraction: 0.5 } });
  send({ type: 'setRange', range });
}

export function fetchSeries(keys: string[], t0: number, t1: number, width: number): Promise<{ x: Float64Array; ys: Float32Array[]; raw: boolean }> {
  const reqId = ++reqSeq;
  return new Promise((res) => {
    pending.set(reqId, res);
    send({ type: 'series', reqId, keys, t0, t1, width });
  });
}

let filtersRequested = false;
subscribe((s, ch) => {
  if (ch.has('filters') && !s.filters) filtersRequested = false;
});
/** базовая оценка фильтров — лениво, при первом показе вкладки */
export function ensureFilters(): void {
  if (state.filters || filtersRequested || !state.info) return;
  filtersRequested = true;
  set({ progress: { stage: 'Модель фильтров', fraction: 0.1 } });
  send({ type: 'filtersInit' });
}

let sandboxReq = 0;
let sandboxTimer: ReturnType<typeof setTimeout> | null = null;
/** пересчёт песочницы с задержкой (ползунки двигаются часто) */
export function requestSandbox(params: FilterParams): void {
  set({ sandbox: params, sandboxBusy: true });
  if (sandboxTimer) clearTimeout(sandboxTimer);
  sandboxTimer = setTimeout(() => {
    sandboxReq++;
    send({ type: 'filtersEval', reqId: sandboxReq, params });
  }, 250);
}

let ratesRequested = false;
subscribe((s, ch) => {
  if (ch.has('rates') && !s.rates) ratesRequested = false;
});
/** база рейтов — лениво, при первом показе вкладки */
export function ensureRates(): void {
  if (state.rates || state.ratesWhy || ratesRequested || !state.info) return;
  ratesRequested = true;
  send({ type: 'ratesInit' });
}

let ratesReq = 0;
let ratesTimer: ReturnType<typeof setTimeout> | null = null;
/** пересчёт setpoint под рейты песочницы (кривые считаются в UI мгновенно, это — манёвры) */
export function requestRatesEval(profile: RateProfile, delayMs = 150): void {
  set({ ratesSandbox: profile, ratesBusy: true });
  if (ratesTimer) clearTimeout(ratesTimer);
  ratesTimer = setTimeout(() => {
    ratesReq++;
    send({ type: 'ratesEval', reqId: ratesReq, profile });
  }, delayMs);
}

let pidRequested = false, adviceRequested = false;
subscribe((s, ch) => {
  if (ch.has('pid') && !s.pid) pidRequested = false;
  if (ch.has('advice') && !s.advice) adviceRequested = false;
});
export function ensurePid(): void {
  if (state.pid || pidRequested || !state.info) return;
  pidRequested = true;
  send({ type: 'pidInit' });
}
export function ensureAdvice(): void {
  if (state.advice || adviceRequested || !state.info) return;
  adviceRequested = true;
  set({ progress: { stage: 'Советчик', fraction: 0.5 } });
  // знание о борте (правила «с осторожностью», профиль) — из базы сессий
  currentBoard().then((board) => {
    set({ board });
    send({ type: 'adviceInit', board: board ?? undefined });
  });
}

async function currentBoard(): Promise<BoardKnowledge | null> {
  if (!state.info) return null;
  const st = await db();
  // только уверенное совпадение (UID + имя); спорные случаи решает пилот при сохранении сессии
  const p = boardFor(await st.projects(), state.info.header);
  if (!p) return null;
  const ss = await st.sessions(p.id);
  return { ...boardKnowledge(ruleStats(ss, await st.incidents(p.id)), p.profile ?? {}, ss), cls: normalizeProfile(p.profile).cls };
}

// --- сессии (этап 5) ---
let storeP: Promise<SessionStore> | null = null;
function db(): Promise<SessionStore> {
  if (!storeP) {
    storeP = (async () => {
      try {
        if (typeof indexedDB === 'undefined') throw new Error('нет IndexedDB');
        const b = await idbBackend();
        set({ dbPersistent: true });
        const st = new SessionStore(b);
        // проекты до E2.1 (борт = имя/плата): UID из сохранённых заголовков, деление по UID
        await st.migrate();
        return st;
      } catch {
        set({ dbPersistent: false });
        return new SessionStore(memoryBackend());
      }
    })();
  }
  return storeP;
}

export async function loadSessions(): Promise<void> {
  const st = await db();
  set({ projects: await st.projects(), sessions: await st.sessions(), incidents: await st.incidents(), campaigns: await st.campaigns() });
}

/** сдвиг видео — в сессию открытого лога, если она сохранена */
export async function saveVideoToSession(v: { name: string; size: number; offsetS: number }): Promise<boolean> {
  const snap = state.info ? { fileName: state.fileName ?? '', logIndex: state.info.index, datetime: state.info.datetime } : null;
  if (!snap) return false;
  const st = await db();
  const r = (await st.sessions()).find((x) => x.snap.source.fileName === snap.fileName && x.snap.source.logIndex === snap.logIndex && x.snap.source.datetime === snap.datetime);
  if (!r) return false;
  await st.updateSession({ ...r, video: v });
  return true;
}

/** запись в полётник — в журнал последней сессии борта; false — сессий борта нет */
export async function recordFcWrite(uid: string, e: FcLogEntry): Promise<boolean> {
  const r = await (await db()).logFcWrite(uid, e);
  await loadSessions();
  return !!r;
}

// --- кампании (A1–A2) ---
export async function createCampaign(projectId: string, goal: GoalKind, title: string): Promise<void> {
  const st = await db();
  const c: Campaign = { id: newId('cmp'), projectId, goal, title, createdAt: new Date().toISOString(), status: 'open', sessionIds: [], marks: {}, notes: '' };
  await st.saveCampaign(c);
  await loadSessions();
  set({ campaignId: c.id });
}

export async function updateCampaign(c: Campaign): Promise<void> {
  await (await db()).saveCampaign(c);
  await loadSessions();
}

export async function deleteCampaign(id: string): Promise<void> {
  await (await db()).deleteCampaign(id);
  await loadSessions();
  if (state.campaignId === id) set({ campaignId: null });
}

export async function setMark(c: Campaign, sessionId: string, mark: SessionMark): Promise<void> {
  await updateCampaign({ ...c, marks: { ...c.marks, [sessionId]: mark } });
}

/** снимок открытого лога — для проверки по протоколу сразу после загрузки (без сохранения) */
export async function ensureOpenSnap(): Promise<void> {
  if (!state.info || state.openSnap || state.openSnapBusy) return;
  set({ openSnapBusy: true });
  try {
    const snap = await requestSnapshot();
    set({ openSnap: snap });
  } finally {
    set({ openSnapBusy: false });
  }
}

const snapPending = new Map<number, (s: SessionSnapshot) => void>();
async function requestSnapshot(): Promise<SessionSnapshot> {
  const board = await currentBoard();
  const reqId = ++reqSeq;
  return new Promise((res) => {
    snapPending.set(reqId, res);
    send({ type: 'snapshot', reqId, board: board ?? undefined });
  });
}

/** сохранить открытый лог как сессию (проект — по борту из заголовка) */
export async function saveCurrentSession(notes: string): Promise<void> {
  if (!state.info) return;
  set({ sessionsBusy: true, sessionsMsg: null });
  try {
    const snap = await requestSnapshot();
    const st = await db();
    const same = await st.findSame(snap);
    if (same) {
      set({ sessionsMsg: 'Этот лог уже сохранён.' });
      return;
    }
    const key = boardKeyFromHeader(snap.header);
    const m = matchBoard(await st.projects(), key);
    if (m.kind === 'ask') {
      // борт по логу не определить уверенно — спросить пилота (сессия ждёт ответа)
      pendingSave = { snap, notes };
      set({ boardAsk: { reason: m.reason, candidates: m.candidates.map((p) => p.id), key } });
      return;
    }
    await finishSave(m.project.id, snap, notes);
  } catch (e) {
    set({ sessionsMsg: `Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    set({ sessionsBusy: false });
  }
}

let pendingSave: { snap: SessionSnapshot; notes: string } | null = null;

async function finishSave(projectId: string, snap: SessionSnapshot, notes: string): Promise<void> {
  const st = await db();
  const r = await st.saveSession(projectId, snap, notes);
  // новый полёт борта — в его открытую кампанию (следующая итерация)
  const oc = openCampaign(await st.campaigns(projectId), projectId);
  if (oc) await st.saveCampaign({ ...oc, sessionIds: [...oc.sessionIds, r.id] });
  await loadSessions();
  // удобно: последняя сохранённая — «стало», предыдущая этого борта — «было»
  const list = state.sessions.filter((x) => x.projectId === projectId);
  const prev = list.filter((x) => x.id !== r.id).pop();
  set({ cmpB: r.id, cmpA: prev?.id ?? state.cmpA, sessionsMsg: 'Сессия сохранена.' });
}

/** ответ пилота: новый борт / это существующий / полётник переехал из борта id в новую раму */
export async function resolveBoardAsk(choice: { kind: 'new'; name: string } | { kind: 'existing'; id: string } | { kind: 'moved'; id: string; name: string } | { kind: 'cancel' }): Promise<void> {
  const ask = state.boardAsk;
  const ps = pendingSave;
  set({ boardAsk: null });
  pendingSave = null;
  if (!ask || !ps || choice.kind === 'cancel') return;
  set({ sessionsBusy: true });
  try {
    const st = await db();
    let pid: string;
    if (choice.kind === 'new') pid = (await st.createBoard(ask.key, choice.name)).id;
    else if (choice.kind === 'moved') pid = (await st.adopt(await st.moveFc(choice.id, choice.name), ask.key)).id;
    else {
      const p = (await st.projects()).find((x) => x.id === choice.id);
      if (!p) throw new Error('борт не найден');
      pid = (await st.adopt(p, ask.key)).id;
    }
    await finishSave(pid, ps.snap, ps.notes);
  } catch (e) {
    set({ sessionsMsg: `Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    set({ sessionsBusy: false });
  }
}

/** явная операция: полётник борта id переехал в новую раму → новый борт */
export async function moveFcToNewFrame(id: string, name: string): Promise<void> {
  await (await db()).moveFc(id, name);
  await loadSessions();
}

export async function updateSessionNotes(r: SessionRecord, notes: string): Promise<void> {
  await (await db()).updateSession({ ...r, notes });
  await loadSessions();
}

export async function renameProject(p: Project, name: string): Promise<void> {
  await (await db()).saveProject({ ...p, name });
  await loadSessions();
}

export async function deleteSession(id: string): Promise<void> {
  await (await db()).deleteSession(id);
  set({ cmpA: state.cmpA === id ? null : state.cmpA, cmpB: state.cmpB === id ? null : state.cmpB });
  await loadSessions();
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).deleteProject(id);
  await loadSessions();
}

export async function exportProject(p: Project): Promise<void> {
  const json = await (await db()).exportProject(p.id);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `blackbox-studio-${p.name.replace(/[^\wа-яА-Я-]+/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importProject(f: File): Promise<void> {
  try {
    const r = await (await db()).importProject(await f.text());
    await loadSessions();
    set({ sessionsMsg: `Импортировано сессий: ${r.added}${r.skipped ? `, уже были: ${r.skipped}` : ''}.` });
  } catch (e) {
    set({ sessionsMsg: `Импорт не удался: ${e instanceof Error ? e.message : String(e)}` });
  }
}

// --- журнал инцидентов (этап 6) ---
export async function saveIncident(data: Omit<Incident, 'id' | 'createdAt' | 'status' | 'resolution' | 'projectId' | 'beforeId'>): Promise<void> {
  const st = await db();
  const after = state.sessions.find((s) => s.id === data.sessionId);
  if (!after) return;
  // «было» — предыдущая сессия этого борта
  const prev = state.sessions.filter((s) => s.projectId === after.projectId && (s.snap.source.datetime || s.savedAt) < (after.snap.source.datetime || after.savedAt)).pop();
  const inc: Incident = { ...data, id: await st.nextIncidentId(), projectId: after.projectId, beforeId: prev?.id ?? null, createdAt: new Date().toISOString(), status: 'open', resolution: '' };
  await st.saveIncident(inc);
  await loadSessions();
  set({ incidentForm: null, sessionsMsg: `Инцидент ${inc.id} записан.`, advice: null });
}

export async function updateIncident(i: Incident): Promise<void> {
  await (await db()).saveIncident(i);
  await loadSessions();
}

export async function saveProfile(p: Project, profile: BoardProfile): Promise<void> {
  await (await db()).saveProject({ ...p, profile });
  await loadSessions();
  set({ advice: null });
  void syncBoardClass();
}

/** класс, который сейчас стоит в воркере (по умолчанию — 5") */
let workerClass: string = DEFAULT_CLASS;

/** класс борта открытого лога → воркер (пороги светофора и советчика); меняется — пересчёт */
export async function syncBoardClass(): Promise<void> {
  if (!state.info) return;
  const p = boardFor((await (await db()).projects()), state.info.header);
  const cls = normalizeProfile(p?.profile).cls ?? DEFAULT_CLASS;
  if (cls === workerClass) return;
  workerClass = cls;
  adviceRequested = false;
  set({ progress: { stage: T.cls.progress, fraction: 0.5 } });
  send({ type: 'setClass', cls });
}

/** байты лога из открытого файла, если это тот же файл */
async function logBytes(s: SessionRecord | null): Promise<Uint8Array | undefined> {
  const src = s?.snap.source;
  if (!src || !openedFile || openedFile.name !== src.fileName || src.byteStart === undefined || src.byteEnd === undefined) return undefined;
  return new Uint8Array(await openedFile.slice(src.byteStart, src.byteEnd).arrayBuffer());
}

export async function exportCase(i: Incident): Promise<void> {
  const after = state.sessions.find((s) => s.id === i.sessionId)!;
  const before = i.beforeId ? state.sessions.find((s) => s.id === i.beforeId) ?? null : null;
  const auto = before ? autoAnalyze(before.snap, after.snap, i) : null;
  const good = lastGood(after, state.sessions, state.incidents);
  const files = buildCaseFiles({
    incident: i, before, after, auto, good,
    logs: { before: await logBytes(before), after: await logBytes(after) },
    plots: await casePlots(before?.snap ?? null, after.snap),
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zip(files)], { type: 'application/zip' }));
  a.download = `${caseFolderName(i)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- прогноз PID (этап 7) ---
let pidReq = 0;
let pidTimer: ReturnType<typeof setTimeout> | null = null;
export function requestPidForecast(changes: Record<string, number>, delayMs = 150): void {
  set({ pidSandbox: changes, pidBusy: true });
  if (pidTimer) clearTimeout(pidTimer);
  pidTimer = setTimeout(async () => {
    const board = state.board ?? (await currentBoard());
    pidReq++;
    send({ type: 'pidPredict', reqId: pidReq, changes, bandScale: board?.pidBandScale ?? 1 });
  }, delayMs);
}

// --- отчёт HTML (этап 8) ---
function download(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** экспорт кампании одним HTML-файлом с данными внутри (A5) */
export function exportCampaign(c: Campaign): void {
  const p = state.projects.find((x) => x.id === c.projectId);
  if (!p) return;
  const x = campaignExport(c, p, state.sessions, state.incidents, normalizeProfile(p.profile).cls ?? DEFAULT_CLASS);
  // имя латиницей: кириллицу в имени скачиваемого файла Chromium местами отбрасывает («download»)
  download(`campaign-${c.goal}-${x.exportedAt.slice(0, 10)}.html`, campaignHtml(x), 'text/html');
}

/** отчёт по снимку; before — «было» для блока сравнения; без снимка — по открытому логу */
export async function exportReport(snap?: SessionSnapshot, before?: SessionSnapshot): Promise<void> {
  set({ progress: { stage: 'Отчёт', fraction: 0.5 } });
  try {
    const s = snap ?? (await requestSnapshot());
    const png = await casePlots(before ?? null, s);
    const images = Object.fromEntries(Object.entries(png).map(([k, v]) => [k, dataUri(v)]));
    const name = `blackbox-report-${(s.source.craft || 'board').replace(/[^\wа-яА-Я-]+/g, '_')}-${s.source.datetime.slice(0, 10)}-${s.source.logIndex}${before ? '-compare' : ''}.html`;
    download(name, reportHtml(s, images, before), 'text/html');
  } finally {
    set({ progress: null });
  }
}
