// Ключ борта (E2.1). Раньше борт = Craft name, а при пустом имени — модель платы: два квадрика на
// одинаковых полётниках сливались в один, а полётник, переставленный в новую раму, оставался «тем
// же бортом». Теперь: DeviceUID (уникальный ID процессора, пишется в заголовок с BF 2025.12;
// в 4.5.2 его нет) + Craft name, а решения, которые по логу принять нельзя, — за пилотом:
//  - первая встреча (нет борта с этим UID) → «новый борт или существующий?»;
//  - тот же UID, другое имя → «переименовал или полётник переехал в новую раму?»;
//  - «полётник переехал» — явная операция: новый борт с тем же UID и ссылкой sameFcAs на старый;
//    старый получает fcMovedTo, его история сохраняется, к нему больше ничего не приписывается.
// Чистые функции — без базы; база (db.ts) только применяет их результат.

import type { Incident } from '../incidents/incidents';
import type { Project, SessionRecord } from './db';

export interface BoardKey {
  /** DeviceUID в нижнем регистре; null — прошивка его не пишет */
  uid: string | null;
  craft: string;
  board: string;
}

export function boardKeyFromHeader(H: Record<string, string> | undefined): BoardKey {
  H = H ?? {};
  const uid = (H['DeviceUID'] || '').trim().toLowerCase();
  return { uid: /^[0-9a-f]{8,}$/.test(uid) ? uid : null, craft: (H['Craft name'] || '').trim(), board: (H['Board information'] || '').trim() };
}

/** старый ключ (до E2.1): Craft name или плата */
export const legacyKey = (k: Pick<BoardKey, 'craft' | 'board'>): string => k.craft || k.board || 'Борт';

export type AskReason = 'new' | 'craft-changed' | 'legacy' | 'several' | 'no-uid';

export type BoardMatch = { kind: 'match'; project: Project } | { kind: 'ask'; reason: AskReason; candidates: Project[] };

/** борт ещё «живой»: полётник с него не переезжал */
export const isActive = (p: Project): boolean => !p.fcMovedTo;

const sameCraft = (p: Project, k: BoardKey): boolean => (p.craftName ?? p.craftKey ?? '') === k.craft || (!p.craftName && p.craftKey === legacyKey(k));

/** к какому борту относится лог; ask — спросить пилота (кандидаты — по убыванию вероятности) */
export function matchBoard(projects: Project[], k: BoardKey): BoardMatch {
  const act = projects.filter(isActive);
  if (k.uid) {
    const byUid = act.filter((p) => p.uid === k.uid);
    if (byUid.length === 1) return sameCraft(byUid[0], k) ? { kind: 'match', project: byUid[0] } : { kind: 'ask', reason: 'craft-changed', candidates: byUid };
    if (byUid.length > 1) return { kind: 'ask', reason: 'several', candidates: byUid };
    // старые борта без UID (логи 4.5 или проекты до E2.1) с тем же именем/платой — возможно, он
    const legacy = act.filter((p) => !p.uid && p.craftKey === legacyKey(k));
    if (legacy.length) return { kind: 'ask', reason: 'legacy', candidates: [...legacy, ...act.filter((p) => !legacy.includes(p))] };
    return { kind: 'ask', reason: 'new', candidates: act };
  }
  // прошивка без UID: по-старому, но два кандидата — спросить; кандидат известен по UID —
  // тоже спросить: одинаковая плата ещё не значит тот же полётник
  const byKey = act.filter((p) => p.craftKey === legacyKey(k));
  const noUid = byKey.filter((p) => !p.uid);
  if (noUid.length === 1) return { kind: 'match', project: noUid[0] };
  if (byKey.length === 1) return { kind: 'ask', reason: 'no-uid', candidates: [...byKey, ...act.filter((p) => p !== byKey[0])] };
  if (byKey.length > 1) return { kind: 'ask', reason: 'several', candidates: byKey };
  return { kind: 'ask', reason: 'new', candidates: act };
}

/** борт для советчика без вопросов: только уверенное совпадение */
export function boardFor(projects: Project[], H: Record<string, string>): Project | null {
  const m = matchBoard(projects, boardKeyFromHeader(H));
  return m.kind === 'match' ? m.project : null;
}

/** новый борт под ключ */
export function newProject(id: string, k: BoardKey, name?: string, now = new Date().toISOString()): Project {
  return { id, name: name || legacyKey(k), craftKey: legacyKey(k), craftName: k.craft, uid: k.uid ?? undefined, createdAt: now, notes: '' };
}

/** пилот сказал «это борт p»: борт запоминает UID (если не было) и текущее имя */
export function adoptKey(p: Project, k: BoardKey): Project {
  return { ...p, uid: p.uid ?? k.uid ?? undefined, craftName: k.craft, craftKey: legacyKey(k) };
}

/** «полётник переехал в новую раму»: новый борт с тем же UID, старый закрыт для новых логов */
export function moveFc(old: Project, newId: string, name: string, now = new Date().toISOString()): { old: Project; fresh: Project } {
  const fresh: Project = { id: newId, name, craftKey: old.craftKey, craftName: old.craftName, uid: old.uid, sameFcAs: old.id, createdAt: now, notes: '' };
  return { old: { ...old, fcMovedTo: newId }, fresh };
}

export interface Migration {
  projects: Project[];
  /** сессии, сменившие борт */
  sessions: SessionRecord[];
  incidents: Incident[];
}

/**
 * Миграция проектов до E2.1 (без UID): UID из заголовков сохранённых сессий (снимок хранит
 * заголовок целиком). Один UID — проект его получает. Несколько — проект делится по UID: каждый
 * UID кроме самого частого уходит в новый борт вместе со своими сессиями и инцидентами; сессии
 * без UID (4.5) остаются на месте. Ничего не удаляется. Идемпотентна.
 */
export function migrate(projects: Project[], sessions: SessionRecord[], incidents: Incident[], mkId: () => string, now = new Date().toISOString()): Migration {
  const out: Migration = { projects: [], sessions: [], incidents: [] };
  for (const p of projects) {
    if (p.uid || p.fcMovedTo || p.sameFcAs) continue;
    const ss = sessions.filter((s) => s.projectId === p.id);
    const byUid = new Map<string, SessionRecord[]>();
    for (const s of ss) {
      const u = boardKeyFromHeader(s.snap.header).uid;
      if (u) byUid.set(u, [...(byUid.get(u) ?? []), s]);
    }
    if (!byUid.size) continue;
    const order = [...byUid.entries()].sort((a, b) => b[1].length - a[1].length);
    const first = order[0][1][0];
    out.projects.push({ ...p, uid: order[0][0], craftName: first.snap.source?.craft ?? '' });
    for (const [uid, list] of order.slice(1)) {
      const s0 = list[0].snap;
      const np: Project = { ...newProject(mkId(), boardKeyFromHeader(s0.header), `${p.name} (${uid.slice(-6)})`, now), profile: p.profile ? structuredClone(p.profile) : undefined, notes: p.notes };
      out.projects.push(np);
      const ids = new Set(list.map((s) => s.id));
      for (const s of list) out.sessions.push({ ...s, projectId: np.id });
      for (const i of incidents) if (i.projectId === p.id && ids.has(i.sessionId)) out.incidents.push({ ...i, projectId: np.id });
    }
  }
  return out;
}
