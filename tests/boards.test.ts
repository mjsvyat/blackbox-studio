// Ключ борта (E2.1): DeviceUID + Craft name, «новый или существующий», переезд полётника,
// миграция проектов и экспорта до E2.1 без потерь.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boardKeyFromHeader, matchBoard } from '../src/sessions/boards';
import { SessionStore, memoryBackend, type SessionRecord } from '../src/sessions/db';
import type { SessionSnapshot } from '../src/sessions/snapshot';
import type { Incident } from '../src/incidents/incidents';
import { scanFile } from '../src/decoder/scan';
import { SMALL_DUMP, fileReader, hasFixture } from './helpers';

const BOARD = 'TMTR TMOTORVELOXF7SE';
const UID_A = '0026003a363250062035394d';
const UID_B = '00410022313351023438384e';

const H = (uid: string | null, craft = ''): Record<string, string> => ({ 'Board information': BOARD, 'Craft name': craft, ...(uid ? { DeviceUID: uid } : {}) });
const snap = (uid: string | null, craft = '', dt = '2026-09-06T10:00:00'): SessionSnapshot =>
  ({ v: 1, header: H(uid, craft), source: { fileName: `${uid ?? 'old'}-${dt}.bbl`, logIndex: 0, datetime: dt, craft, board: BOARD } }) as unknown as SessionSnapshot;

/** сохранить лог «как пилот»: на вопрос отвечаем answer */
async function save(st: SessionStore, s: SessionSnapshot, answer: (r: string) => { kind: 'new'; name: string } | { kind: 'existing'; id: string } | { kind: 'moved'; id: string; name: string }): Promise<{ asked: string | null; projectId: string }> {
  const key = boardKeyFromHeader(s.header);
  const m = matchBoard(await st.projects(), key);
  if (m.kind === 'match') return { asked: null, projectId: (await st.saveSession(m.project.id, s)).projectId };
  const a = answer(m.reason);
  const p = a.kind === 'new' ? await st.createBoard(key, a.name) : a.kind === 'moved' ? await st.adopt(await st.moveFc(a.id, a.name), key) : await st.adopt((await st.projects()).find((x) => x.id === a.id)!, key);
  return { asked: m.reason, projectId: (await st.saveSession(p.id, s)).projectId };
}

describe('ключ борта', () => {
  it.skipIf(!hasFixture(SMALL_DUMP))('DeviceUID из заголовка настоящего лога 2026.6.1', async () => {
    const r = fileReader(SMALL_DUMP);
    const st = await scanFile(r);
    r.close();
    const L = st.logs.find((l) => l.index === 4)!;
    const buf = fs.readFileSync(SMALL_DUMP).subarray(L.start, L.start + 20000).toString('latin1');
    const hdr = Object.fromEntries([...buf.matchAll(/^H ([^:\n]+):(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
    expect(boardKeyFromHeader(hdr)).toEqual({ uid: UID_A, craft: '', board: BOARD });
  });

  it('одинаковая плата, разный DeviceUID → два борта; повторный лог — без вопросов', async () => {
    const st = new SessionStore(memoryBackend());
    const a = await save(st, snap(UID_A), () => ({ kind: 'new', name: 'Велокс' }));
    expect(a.asked).toBe('new');
    const b = await save(st, snap(UID_B), (r) => {
      expect(r).toBe('new'); // не «тот же борт по плате»
      return { kind: 'new', name: 'Велокс-2' };
    });
    expect(b.projectId).not.toBe(a.projectId);
    const again = await save(st, snap(UID_A, '', '2026-09-07T10:00:00'), () => { throw new Error('не должен спрашивать'); });
    expect(again).toEqual({ asked: null, projectId: a.projectId });
    expect((await st.projects()).map((p) => p.uid)).toEqual([UID_A, UID_B]);
  });

  it('тот же DeviceUID после «переезда» → новый борт со ссылкой, история старого на месте', async () => {
    const st = new SessionStore(memoryBackend());
    const a = await save(st, snap(UID_A, 'FIVE'), () => ({ kind: 'new', name: '5"' }));
    // переставил полётник в 7" и переименовал: тот же UID, другое имя → вопрос
    const b = await save(st, snap(UID_A, 'SEVEN', '2026-10-01T10:00:00'), (r) => {
      expect(r).toBe('craft-changed');
      return { kind: 'moved', id: a.projectId, name: '7"' };
    });
    const ps = await st.projects();
    const old = ps.find((p) => p.id === a.projectId)!;
    const fresh = ps.find((p) => p.id === b.projectId)!;
    expect(fresh).toMatchObject({ uid: UID_A, sameFcAs: old.id, craftName: 'SEVEN' });
    expect(old.fcMovedTo).toBe(fresh.id);
    expect((await st.sessions(old.id)).length).toBe(1);
    // следующие логи этого полётника — в новый борт, без вопросов
    const c = await save(st, snap(UID_A, 'SEVEN', '2026-10-02T10:00:00'), () => { throw new Error('не должен спрашивать'); });
    expect(c.projectId).toBe(fresh.id);
    // явная операция «переехал» без смены имени — тоже новый борт
    const moved = await st.moveFc(fresh.id, '7" новая рама');
    const d = await save(st, snap(UID_A, 'SEVEN', '2026-10-03T10:00:00'), () => { throw new Error('не должен спрашивать'); });
    expect(d.projectId).toBe(moved.id);
  });

  it('переименовал борт — тот же борт, имя обновлено', async () => {
    const st = new SessionStore(memoryBackend());
    const a = await save(st, snap(UID_A, 'OLD'), () => ({ kind: 'new', name: 'Борт' }));
    const b = await save(st, snap(UID_A, 'NEW', '2026-09-08T00:00:00'), () => ({ kind: 'existing', id: a.projectId }));
    expect(b.projectId).toBe(a.projectId);
    expect((await st.projects())[0].craftName).toBe('NEW');
    expect((await save(st, snap(UID_A, 'NEW', '2026-09-09T00:00:00'), () => { throw new Error('не должен спрашивать'); })).projectId).toBe(a.projectId);
  });

  it('логи без DeviceUID (BF 4.5) — по имени/плате, как раньше; первый лог с UID спрашивает про старый борт', async () => {
    const st = new SessionStore(memoryBackend());
    const a = await save(st, snap(null), () => ({ kind: 'new', name: 'Старый' }));
    const a2 = await save(st, snap(null, '', '2026-06-21T00:00:00'), () => { throw new Error('не должен спрашивать'); });
    expect(a2.projectId).toBe(a.projectId);
    const b = await save(st, snap(UID_A, '', '2026-09-06T00:00:00'), (r) => {
      expect(r).toBe('legacy');
      return { kind: 'existing', id: a.projectId };
    });
    expect(b.projectId).toBe(a.projectId);
    expect((await st.projects())[0].uid).toBe(UID_A);
  });
});

describe('миграция до E2.1', () => {
  // экспорт старого формата: борт по плате, под ним два полётника и лог 4.5 без UID
  const oldExport = (): string => {
    const project = { id: 'prj-old', name: BOARD, craftKey: BOARD, createdAt: '2026-06-01T00:00:00Z', notes: 'заметка', profile: { props: '5"' } };
    const sessions: SessionRecord[] = [
      { id: 's1', projectId: 'prj-old', savedAt: '1', notes: '', snap: snap(UID_A, '', '2026-09-01T00:00:00') },
      { id: 's2', projectId: 'prj-old', savedAt: '2', notes: '', snap: snap(UID_A, '', '2026-09-02T00:00:00') },
      { id: 's3', projectId: 'prj-old', savedAt: '3', notes: 'второй квадрик', snap: snap(UID_B, '', '2026-09-03T00:00:00') },
      { id: 's4', projectId: 'prj-old', savedAt: '4', notes: '4.5.2', snap: snap(null, '', '2026-06-21T00:00:00') },
    ];
    const incidents = [{ id: 'INC-0001', projectId: 'prj-old', sessionId: 's3', beforeId: null } as unknown as Incident, { id: 'INC-0002', projectId: 'prj-old', sessionId: 's2', beforeId: 's1' } as unknown as Incident];
    return JSON.stringify({ format: 'blackbox-studio-project', v: 1, exportedAt: '2026-09-10T00:00:00Z', project, sessions, incidents });
  };

  it('импорт старого JSON: борт делится по UID, ничего не теряется, повтор — без изменений', async () => {
    const st = new SessionStore(memoryBackend());
    const r = await st.importProject(oldExport());
    expect(r.added).toBe(4);
    const ps = await st.projects();
    expect(ps.length).toBe(2);
    const main = ps.find((p) => p.id === 'prj-old')!;
    const split = ps.find((p) => p.id !== 'prj-old')!;
    expect(main.uid).toBe(UID_A);
    expect(split).toMatchObject({ uid: UID_B, craftKey: BOARD, profile: { props: '5"' } });
    expect((await st.sessions(main.id)).map((s) => s.id).sort()).toEqual(['s1', 's2', 's4']);
    expect((await st.sessions(split.id)).map((s) => s.id)).toEqual(['s3']);
    expect((await st.incidents(split.id)).map((i) => i.id)).toEqual(['INC-0001']);
    expect((await st.incidents(main.id)).map((i) => i.id)).toEqual(['INC-0002']);
    expect((await st.sessions()).length).toBe(4);
    expect(await st.migrate()).toEqual({ projects: 0, moved: 0 });
    // после миграции новые логи узнаются без вопросов
    expect(matchBoard(await st.projects(), boardKeyFromHeader(H(UID_B))).kind).toBe('match');
  });

  it('проект с одним UID просто получает его; без UID в сессиях — не трогается', async () => {
    const st = new SessionStore(memoryBackend());
    const p1 = await st.projectFor('ONE');
    const p2 = await st.projectFor('OLD45');
    await st.saveSession(p1.id, snap(UID_A, 'ONE'));
    await st.saveSession(p2.id, snap(null, 'OLD45'));
    await st.migrate();
    const ps = await st.projects();
    expect(ps.find((p) => p.id === p1.id)!.uid).toBe(UID_A);
    expect(ps.find((p) => p.id === p2.id)!.uid).toBeUndefined();
  });
});
