// Перенос настроек между бортами (E2.5) на настоящих заголовках: группы параметров, только
// различающиеся, проверка под версию прошивки получателя.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import type { SessionSnapshot } from '../src/sessions/snapshot';
import { groupKeys, transferCli } from '../src/sessions/transfer';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

async function snap(file: string, index: number): Promise<SessionSnapshot> {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const a = analyzeLog(buildContext(decodeLog(readRange(file, L.start, end - L.start))));
  return snapshotLog(a, adviseLog(a), { fileName: 'x', logIndex: index });
}

describe.skipIf(!hasFixture(SMALL_DUMP))('перенос: группы и только различающиеся', () => {
  it('тот же борт — переносить нечего; изменённый получатель — только изменённые параметры', async () => {
    const s = await snap(SMALL_DUMP, 4);
    expect(groupKeys(s.header, 'filters')).toContain('gyro_lpf2_static_hz');
    expect(groupKeys(s.header, 'rates')).toContain('rates_type');
    expect(groupKeys(s.header, 'pid')).toContain('d_roll');
    expect(groupKeys(s.header, 'pid').some((k) => /filter/.test(k))).toBe(false);
    expect(transferCli(s, s, ['filters', 'rates', 'pid']).lines).toEqual([]);
    const dst = structuredClone(s);
    dst.cli.dterm_lpf1_static_hz = 60;
    dst.cli.roll_srate = 50;
    dst.cli.d_roll = 99;
    const t = transferCli(s, dst, ['filters']);
    expect(t.lines).toEqual([`set dterm_lpf1_static_hz = ${s.cli.dterm_lpf1_static_hz}`, 'save']);
    expect(transferCli(s, dst, ['rates', 'pid']).lines).toEqual(expect.arrayContaining([`set roll_srate = ${s.cli.roll_srate}`, `set d_roll = ${s.cli.d_roll}`]));
  });
});

describe.skipIf(!hasFixture(SMALL_DUMP) || !hasFixture(BIG_DUMP))('перенос между прошивками 4.5.2 ↔ 2026.6.1', () => {
  it('PID с 4.5.2 на 2026.6.1: d_min_* пропущены (в 2025.12+ это d_max_*), остальное — под версию получателя', async () => {
    const old = await snap(BIG_DUMP, 3);
    const neu = await snap(SMALL_DUMP, 4);
    const t = transferCli(old, neu, ['pid']);
    expect(t.skipped.map((s) => s.name)).toEqual(expect.arrayContaining(['d_min_roll', 'd_min_pitch']));
    expect(t.lines.some((l) => l.startsWith('set d_min'))).toBe(false);
    // фильтры 4.5.2 (LPF2 800, LPF1 выкл.) как старт для 2026.6.1
    const f = transferCli(old, neu, ['filters']);
    expect(f.lines).toContain('set gyro_lpf2_static_hz = 800');
    // рейты — словом
    const r = transferCli(old, neu, ['rates']);
    for (const l of r.lines.filter((x) => x.startsWith('set rates_type'))) expect(l).toMatch(/= [A-Z]+$/);
  });
});
