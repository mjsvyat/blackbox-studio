// Проекты (борта) и сессии: IndexedDB в браузере, память — если IndexedDB недоступен
// (приватный режим) или в тестах. Экспорт/импорт проекта — один JSON-файл.

import type { SessionSnapshot } from './snapshot';
import type { Incident } from '../incidents/incidents';

export interface Project {
  id: string;
  name: string;
  /** ключ борта из заголовка: Craft name или плата */
  craftKey: string;
  createdAt: string;
  notes: string;
  /** профиль борта: что знаем о нём (правила читают dSensitive и disabledRules) */
  profile?: BoardProfile;
}

export interface BoardProfile {
  props?: string;
  kv?: string;
  weight?: string;
  frame?: string;
  notes?: string;
  dSensitive?: boolean;
  disabledRules?: string[];
}

export interface SessionRecord {
  id: string;
  projectId: string;
  savedAt: string;
  notes: string;
  snap: SessionSnapshot;
}

export type StoreName = 'projects' | 'sessions' | 'incidents';

export interface Backend {
  all<T>(store: StoreName): Promise<T[]>;
  put<T extends { id: string }>(store: StoreName, v: T): Promise<void>;
  del(store: StoreName, id: string): Promise<void>;
}

export function memoryBackend(): Backend {
  const m = { projects: new Map<string, unknown>(), sessions: new Map<string, unknown>(), incidents: new Map<string, unknown>() };
  return {
    async all<T>(s: StoreName) { return [...m[s].values()].map((v) => structuredClone(v)) as T[]; },
    async put(s, v) { m[s].set(v.id, structuredClone(v)); },
    async del(s, id) { m[s].delete(id); },
  };
}

export function idbBackend(name = 'blackbox-studio'): Promise<Backend> {
  return new Promise((res, rej) => {
    // версия 2 — добавлен журнал инцидентов
    const rq = indexedDB.open(name, 2);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      for (const st of ['projects', 'sessions', 'incidents']) if (!db.objectStoreNames.contains(st)) db.createObjectStore(st, { keyPath: 'id' });
    };
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = <T>(s: string, mode: IDBTransactionMode, f: (st: IDBObjectStore) => IDBRequest): Promise<T> =>
        new Promise((ok, bad) => {
          const r = f(db.transaction(s, mode).objectStore(s));
          r.onsuccess = () => ok(r.result as T);
          r.onerror = () => bad(r.error);
        });
      res({
        all: (s) => tx(s, 'readonly', (st) => st.getAll()),
        put: async (s, v) => { await tx(s, 'readwrite', (st) => st.put(v)); },
        del: async (s, id) => { await tx(s, 'readwrite', (st) => st.delete(id)); },
      });
    };
  });
}

export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class SessionStore {
  constructor(private b: Backend) {}

  async projects(): Promise<Project[]> {
    return (await this.b.all<Project>('projects')).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  }

  async sessions(projectId?: string): Promise<SessionRecord[]> {
    const all = await this.b.all<SessionRecord>('sessions');
    return all.filter((s) => !projectId || s.projectId === projectId).sort((x, y) => (x.snap.source.datetime || x.savedAt).localeCompare(y.snap.source.datetime || y.savedAt));
  }

  /** проект борта по ключу из заголовка; нет — создаём */
  async projectFor(craftKey: string, name?: string): Promise<Project> {
    const p = (await this.projects()).find((x) => x.craftKey === craftKey);
    if (p) return p;
    const np: Project = { id: newId('prj'), name: name || craftKey || 'Борт', craftKey, createdAt: new Date().toISOString(), notes: '' };
    await this.b.put('projects', np);
    return np;
  }

  async saveProject(p: Project): Promise<void> { await this.b.put('projects', p); }

  async deleteProject(id: string): Promise<void> {
    for (const s of await this.sessions(id)) await this.b.del('sessions', s.id);
    for (const i of await this.incidents(id)) await this.b.del('incidents', i.id);
    await this.b.del('projects', id);
  }

  async saveSession(projectId: string, snap: SessionSnapshot, notes = ''): Promise<SessionRecord> {
    const r: SessionRecord = { id: newId('ses'), projectId, savedAt: new Date().toISOString(), notes, snap };
    await this.b.put('sessions', r);
    return r;
  }

  async updateSession(r: SessionRecord): Promise<void> { await this.b.put('sessions', r); }
  async deleteSession(id: string): Promise<void> { await this.b.del('sessions', id); }

  /** тот же лог уже сохранён (файл, номер, время начала) */
  async findSame(snap: SessionSnapshot): Promise<SessionRecord | null> {
    const s = snap.source;
    return (await this.sessions()).find((r) => r.snap.source.fileName === s.fileName && r.snap.source.logIndex === s.logIndex && r.snap.source.datetime === s.datetime) ?? null;
  }

  async incidents(projectId?: string): Promise<Incident[]> {
    return (await this.b.all<Incident>('incidents')).filter((i) => !projectId || i.projectId === projectId).sort((x, y) => x.id.localeCompare(y.id));
  }

  /** сквозная нумерация INC-0001… по всей базе */
  async nextIncidentId(): Promise<string> {
    const n = (await this.incidents()).reduce((m, i) => Math.max(m, Number(i.id.replace(/\D/g, '')) || 0), 0);
    return `INC-${String(n + 1).padStart(4, '0')}`;
  }

  async saveIncident(i: Incident): Promise<void> { await this.b.put('incidents', i); }
  async deleteIncident(id: string): Promise<void> { await this.b.del('incidents', id); }

  async exportProject(id: string): Promise<string> {
    const p = (await this.projects()).find((x) => x.id === id);
    if (!p) throw new Error('Нет такого проекта');
    return JSON.stringify({ format: 'blackbox-studio-project', v: 1, exportedAt: new Date().toISOString(), project: p, sessions: await this.sessions(id), incidents: await this.incidents(id) });
  }

  /** импорт: проект с тем же id дополняется, сессии с существующими id пропускаются */
  async importProject(json: string): Promise<{ project: Project; added: number; skipped: number }> {
    const d = JSON.parse(json);
    if (d?.format !== 'blackbox-studio-project' || !d.project || !Array.isArray(d.sessions)) throw new Error('Это не файл проекта Blackbox Studio');
    const have = new Set((await this.b.all<SessionRecord>('sessions')).map((s) => s.id));
    const proj = d.project as Project;
    if (!(await this.projects()).some((p) => p.id === proj.id)) await this.b.put('projects', proj);
    let added = 0, skipped = 0;
    for (const s of d.sessions as SessionRecord[]) {
      if (have.has(s.id)) { skipped++; continue; }
      await this.b.put('sessions', { ...s, projectId: proj.id });
      added++;
    }
    const haveInc = new Set((await this.incidents()).map((i) => i.id));
    for (const i of (d.incidents ?? []) as Incident[]) if (!haveInc.has(i.id)) await this.b.put('incidents', { ...i, projectId: proj.id });
    return { project: proj, added, skipped };
  }
}
