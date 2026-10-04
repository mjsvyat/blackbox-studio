// Этап 5: сессии и сравнение. Снимки строятся тем же конвейером, что в воркере;
// хранилище — память (IndexedDB в node нет, логика одна).
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { binNoise, comparability, headerDiff, metricRows, planCheck, predictedSpectrum, predictionAccuracy } from '../src/sessions/compare';
import { SessionStore, memoryBackend } from '../src/sessions/db';
import { SessionSnapshot, cliFromHeader, decimateDb } from '../src/sessions/snapshot';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

async function snap(file: string, index: number): Promise<SessionSnapshot> {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const c = buildContext(decodeLog(readRange(file, L.start, end - L.start)));
  const a = analyzeLog(c);
  return snapshotLog(a, adviseLog(a), { fileName: file.split('/').pop()!, logIndex: index });
}

describe('снимок и хранилище', () => {
  it('прореживание спектра сохраняет мощность', () => {
    const db = Array.from({ length: 100 }, (_, i) => -20 + (i % 7));
    const d = decimateDb(db, 0.5, 1);
    expect(d.df).toBe(1);
    const p0 = db.reduce((s, v) => s + 10 ** (v / 10), 0) / db.length;
    const p1 = d.db.reduce((s, v) => s + 10 ** (v / 10), 0) / d.db.length;
    expect(Math.abs(10 * Math.log10(p1 / p0))).toBeLessThan(0.05);
  });

  it('хранилище: проект по борту, сохранение, экспорт → импорт в чистую базу', async () => {
    const st = new SessionStore(memoryBackend());
    const fake = { v: 1, source: { fileName: 'a.txt', logIndex: 1, datetime: '2026-01-01', craft: 'X' } } as unknown as SessionSnapshot;
    const p = await st.projectFor('X');
    expect((await st.projectFor('X')).id).toBe(p.id);
    await st.saveSession(p.id, fake, 'первый');
    expect(await st.findSame(fake)).not.toBeNull();
    const json = await st.exportProject(p.id);
    const st2 = new SessionStore(memoryBackend());
    const res = await st2.importProject(json);
    expect(res.added).toBe(1);
    expect((await st2.importProject(json)).skipped).toBe(1);
    expect((await st2.sessions())[0].notes).toBe('первый');
    await expect(st2.importProject('{"a":1}')).rejects.toThrow();
  });
});

describe.skipIf(!hasFixture(SMALL_DUMP) || !hasFixture(BIG_DUMP))('сравнение на настоящих логах', () => {
  it('2026.6.1 №4: снимок компактный, CLI-значения из заголовка', async () => {
    const s = await snap(SMALL_DUMP, 4);
    expect(JSON.stringify(s).length).toBeLessThan(400_000);
    expect(s.cli.rates_type).toBe(3);
    expect(s.cli.p_roll).toBe(45);
    expect(s.cli.d_max_roll).toBe(40);
    expect(s.cli.simplified_gyro_filter_multiplier).toBe(100);
    expect(s.flight.thrHist.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    // советы с ID/версиями сохранены для трекинга
    expect(s.advice.some((a) => a.id === 'R-MECH-DESYNC-01')).toBe(true);
  });

  it('4.5.2 №3 → №5 (тот же борт и настройки): настройки не менялись, план не применён', async () => {
    const a = await snap(BIG_DUMP, 3), b = await snap(BIG_DUMP, 5);
    expect(headerDiff(a.header, b.header)).toEqual([]);
    // в №3 советчик предложил фильтр D-term 140 → 125; в №5 его нет
    expect(a.plan?.to.simplified_dterm_filter_multiplier).toBe(125);
    const pc = planCheck(a, b);
    expect(pc.state).toBe('not');
    expect(pc.rules[0]).toEqual({ rule: 'R-FLT-DTERM-HOT-01@1', state: 'not' });
    expect(pc.extra).toEqual([]);
    const cmp = comparability(a, b);
    expect(cmp.warnings).not.toContain('firmware');
    expect(cmp.thrOverlap).toBeGreaterThan(50);
    // план не применён → прогноз не показываем и не считаем его точность
    const rows = metricRows(a, b);
    expect(rows.find((r) => r.id === 'dterm' && r.axis === 0)!.pred).toBeUndefined();
    expect(predictionAccuracy(rows).n).toBe(0);
    // «применили» план (подменяем настройки в снимке «стало») → прогноз есть: D-term ниже
    const b2 = { ...b, cli: { ...b.cli, ...a.plan!.to } };
    const rows2 = metricRows(a, b2);
    const d = rows2.find((r) => r.id === 'dterm' && r.axis === 0)!;
    expect(d.pred).toBeLessThan(d.a);
    expect(predictionAccuracy(rows2).n).toBeGreaterThan(0);
    // разница в пределах погрешности step response — «≈»
    for (const r of rows.filter((x) => x.id === 'settle')) expect(r.verdict).toBe('same');
    expect(predictedSpectrum(a, 0, 'dterm')!.length).toBe(a.noise.axes[0].dtermDb!.length);
    expect(binNoise(a, b, 0).length).toBeGreaterThan(0);
  });

  it('4.5.2 → 2026.6.1: разные прошивки и настройки — предупреждение и diff заголовков', async () => {
    const a = await snap(BIG_DUMP, 3), b = await snap(SMALL_DUMP, 4);
    const cmp = comparability(a, b);
    expect(cmp.warnings).toEqual(expect.arrayContaining(['firmware', 'log-rate']));
    const diff = headerDiff(a.header, b.header).map((x) => x.key);
    expect(diff).toEqual(expect.arrayContaining(['simplified_gyro_filter_multiplier', 'rollPID']));
    // план №3 (D-term 125) в №4 не применён; зато изменено много вне плана
    const pc = planCheck(a, b);
    expect(pc.extra.some((x) => x.key === 'simplified_gyro_filter_multiplier')).toBe(true);
    expect(pc.items.find((i) => i.key === 'simplified_dterm_filter_multiplier')!.state).toBe('other');
  });

  it('cliFromHeader понимает пары и массивы заголовка', () => {
    const c = cliFromHeader({ gyro_lpf1_dyn_hz: '250,500', rollPID: '45,80,30', d_max: '40,46,0', ff_weight: '120,125,120', rates: '67,67,67', rc_rates: '7,7,7', rc_expo: '0,0,0', rates_type: '3' });
    expect(c).toMatchObject({ gyro_lpf1_dyn_min_hz: 250, gyro_lpf1_dyn_max_hz: 500, p_roll: 45, d_roll: 30, d_max_roll: 40, f_roll: 120, roll_srate: 67, rates_type: 3 });
  });
});
