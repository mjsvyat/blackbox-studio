// Этап 6: журнал инцидентов — разбор, подозреваемые, статистика правил, откат, папка случая.
import { describe, expect, it } from 'vitest';
import { runAdvisor } from '../src/advisor/advisor';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { buildCaseFiles, caseFolderName } from '../src/incidents/caseExport';
import { Incident, autoAnalyze, boardKnowledge, isSevere, lastGood, rollbackCli, ruleStats } from '../src/incidents/incidents';
import { crc32, unzip, zip } from '../src/incidents/zip';
import { SessionStore, memoryBackend, SessionRecord } from '../src/sessions/db';
import type { SessionSnapshot } from '../src/sessions/snapshot';
import { BIG_DUMP, fileReader, hasFixture, readRange } from './helpers';

describe('zip', () => {
  it('crc32 эталон и круговой путь', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = zip({ 'cases/INC-0001-x/case.md': '# привет', 'cases/INC-0001-x/b.bin': new Uint8Array([1, 2, 3]) });
    const u = unzip(z);
    expect(new TextDecoder().decode(u['cases/INC-0001-x/case.md'])).toBe('# привет');
    expect(Array.from(u['cases/INC-0001-x/b.bin'])).toEqual([1, 2, 3]);
  });
});

const inc = (o: Partial<Incident> = {}): Incident => ({
  id: 'INC-0001', projectId: 'p', sessionId: 'b', beforeId: 'a', createdAt: '2026-10-04', symptoms: ['propwash'], text: '', tLog: null,
  severity: 2, motorTemp: 1, media: '', status: 'open', resolution: '', ...o,
});

describe('серьёзность и номера', () => {
  it('краш / сила 3 / сильные осцилляции — откат первым', () => {
    expect(isSevere(inc({ symptoms: ['crash'], severity: 1 }))).toBe(true);
    expect(isSevere(inc({ severity: 3 }))).toBe(true);
    expect(isSevere(inc({ symptoms: ['hover-oscillation'], severity: 2 }))).toBe(true);
    expect(isSevere(inc({ symptoms: ['propwash'], severity: 2 }))).toBe(false);
  });

  it('сквозная нумерация INC-0001, INC-0002…', async () => {
    const st = new SessionStore(memoryBackend());
    expect(await st.nextIncidentId()).toBe('INC-0001');
    await st.saveIncident(inc());
    expect(await st.nextIncidentId()).toBe('INC-0002');
  });
});

const memo = new Map<number, Promise<SessionSnapshot>>();
/** снимок лога (кэш на файл тестов; каждый вызов — своя копия) */
async function snap(index: number): Promise<SessionSnapshot> {
  if (!memo.has(index)) memo.set(index, build(index));
  return structuredClone(await memo.get(index)!);
}

async function build(index: number): Promise<SessionSnapshot> {
  const r = fileReader(BIG_DUMP);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const a = analyzeLog(buildContext(decodeLog(readRange(BIG_DUMP, L.start, end - L.start))));
  return snapshotLog(a, adviseLog(a), { fileName: 'blackbox.txt', logIndex: index, byteStart: L.start, byteEnd: end });
}

/** «стало»: план применён (настройки из плана), D-term вырос, задержка выросла */
function applied(a: SessionSnapshot, b: SessionSnapshot): SessionSnapshot {
  const x: SessionSnapshot = structuredClone(b);
  Object.assign(x.cli, a.plan!.to);
  x.noise.axes[0].rmsDterm = (a.noise.axes[0].rmsDterm ?? 0) * 1.3;
  x.filters!.delayD100 = a.filters!.delayD100 + 0.5;
  return x;
}

const rec = (id: string, s: SessionSnapshot): SessionRecord => ({ id, projectId: 'p', savedAt: s.source.datetime, notes: '', snap: s });

describe.skipIf(!hasFixture(BIG_DUMP))('разбор инцидента на логах 4.5.2', () => {
  it('план применён, D-term вырос, жалоба на propwash → подозреваемое R-FLT-DTERM-HOT-01', async () => {
    const a = await snap(3);
    const b = applied(a, await snap(5));
    const au = autoAnalyze(a, b, inc());
    expect(au.plan.state).toBe('applied');
    expect(au.findings.map((f) => f.sign)).toEqual(expect.arrayContaining(['dterm-up', 'delay-up']));
    expect(au.suspects[0].rule).toBe('R-FLT-DTERM-HOT-01@1');
    expect(au.suspects[0].symptoms).toContain('propwash');
    expect(au.worstPrediction).not.toBeNull();
  });

  it('план не применён → подозреваемых нет', async () => {
    const a = await snap(3), b = await snap(5);
    expect(autoAnalyze(a, b, inc()).suspects).toEqual([]);
  });

  it('правило дважды ухудшало → «с осторожностью», советчик его сам не выбирает', async () => {
    const s3 = await snap(3), s5 = await snap(5);
    // история борта: 3 → 5' (применено, хуже) → 3' (то же «было») → 5'' (применено, хуже)
    const A1 = rec('a1', s3), B1 = rec('b1', applied(s3, s5));
    const A2 = rec('a2', { ...structuredClone(s3), source: { ...s3.source, datetime: '2026-07-06T10:00:00' } });
    const B2 = rec('b2', { ...applied(s3, s5), source: { ...s5.source, datetime: '2026-07-07T10:00:00' } });
    B1.snap.source.datetime = '2026-07-05T10:00:00';
    const incidents = [inc({ id: 'INC-0003', sessionId: 'b1', beforeId: 'a1' })];
    const st = ruleStats([A1, B1, A2, B2], incidents);
    expect(st['R-FLT-DTERM-HOT-01'].n).toBe(2);
    expect(st['R-FLT-DTERM-HOT-01'].worse).toBe(2);
    expect(st['R-FLT-DTERM-HOT-01'].incidents).toEqual(['INC-0003']);
    const bk = boardKnowledge(st);
    expect(bk.caution!['R-FLT-DTERM-HOT-01']).toBeDefined();
    // советчик: правило есть, но не выбрано
    const r = runAdvisor({
      fwCode: 4_005_002, logHz: 1000, hasUnfilt: true,
      noise: { unfilt: [11, 7, 13], filt: [3.4, 1.6, 1.9], dterm: [23, 10, null], peaks: [] },
      filters: { params: { simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 140, dterm_lpf1_static_hz: 105, dterm_lpf2_static_hz: 210 }, status: 'red', reason: 'low-rate' },
      pid: null, simplified: null, dKind: 'd_min',
      motors: { satPct: 1, spreadPct: 10, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 15, rippleP99: 1, cells: 6 }, board: bk,
    });
    const a = r.advice.find((x) => x.id === 'R-FLT-DTERM-HOT-01')!;
    expect(a.selected).toBe(false);
    expect(a.deferred).toBe('caution');
    expect(a.caution!.incidents).toEqual(['INC-0003']);
  });

  it('откат: CLI возвращает значения прошлой удачной сессии', async () => {
    const s3 = await snap(3), s5 = await snap(5);
    const B = rec('b', applied(s3, s5));
    const A = rec('a', s3);
    B.snap.source.datetime = '2026-07-05T10:00:00';
    expect(lastGood(B, [A, B], [inc({ sessionId: 'b' })])!.id).toBe('a');
    const cli = rollbackCli(B.snap, A.snap);
    expect(cli.lines).toContain('set simplified_dterm_filter_multiplier = 140');
    expect(cli.lines.at(-1)).toBe('save');
  });

  it('папка случая: case.md, case.json, resolution.md, логи, заготовка регрессии', async () => {
    const s3 = await snap(3), s5 = await snap(5);
    const A = rec('a', s3), B = rec('b', applied(s3, s5));
    const I = inc({ id: 'INC-0007', symptoms: ['hot-motors'] });
    const files = buildCaseFiles({ incident: I, before: A, after: B, auto: autoAnalyze(s3, B.snap, I), good: A, logs: { before: new Uint8Array([1, 2]), after: new Uint8Array([3]) } });
    const dir = `cases/${caseFolderName(I)}`;
    expect(dir).toBe('cases/INC-0007-hot-motors');
    expect(Object.keys(files)).toEqual(expect.arrayContaining([`${dir}/case.md`, `${dir}/case.json`, `${dir}/resolution.md`, `${dir}/before.bbl`, `${dir}/after.bbl`]));
    const cj = JSON.parse(files[`${dir}/case.json`] as string);
    expect(cj.regression.log).toEqual({ file: 'before.bbl' });
    expect(cj.regression.checks[0].type).toBe('not-selected');
    expect(cj.rollback).toContain('set simplified_dterm_filter_multiplier = 140');
    expect(files[`${dir}/case.md`]).toMatch(/R-FLT-DTERM-HOT-01/);
    // без байтов логов — logs.md со смещениями
    const f2 = buildCaseFiles({ incident: I, before: A, after: B, auto: null, good: null });
    expect(f2[`${dir}/logs.md`]).toMatch(/байты \d+…\d+/);
    expect(Object.keys(unzip(zip(files))).length).toBe(Object.keys(files).length);
  });
});
