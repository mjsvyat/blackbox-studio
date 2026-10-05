// Кампания и протокол тестового полёта (A1–A2): манёвры, сопоставимость полётов на настоящих
// логах, лента итераций на синтетике, «лучше/хуже» не выдаётся для несравнимых полётов.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { Campaign, checkProtocol, iterations, metricSeries, openCampaign, protocolNeeds } from '../src/campaigns/campaign';
import { comparability, metricRows } from '../src/sessions/compare';
import type { SessionRecord } from '../src/sessions/db';
import type { SessionSnapshot } from '../src/sessions/snapshot';
import type { ManeuverCount } from '../src/analysis/maneuvers';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const cache = new Map<string, SessionSnapshot>();
async function real(file: string, index: number): Promise<SessionSnapshot> {
  const k = `${file}#${index}`;
  if (cache.has(k)) return cache.get(k)!;
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const a = analyzeLog(buildContext(decodeLog(readRange(file, L.start, end - L.start))));
  const s = snapshotLog(a, adviseLog(a), { fileName: file.split('/').pop()!, logIndex: index });
  cache.set(k, s);
  return s;
}

describe.skipIf(!hasFixture(BIG_DUMP))('сопоставимость полётов на логах 4.5.2', () => {
  it('«висение против фристайла» (№7 спокойный → №3 флипы) — красный, ругается на стики', async () => {
    const c = comparability(await real(BIG_DUMP, 7), await real(BIG_DUMP, 3));
    expect(c.status).toBe('red');
    expect(c.warnings).toContain('sticks');
    const rows = metricRows(await real(BIG_DUMP, 7), await real(BIG_DUMP, 3));
    for (const r of rows.filter((x) => x.flightDependent)) expect(r.verdict).toBe('na');
  });

  it('«два похожих полёта» (фристайл №1 → №2) — зелёный, без предупреждений', async () => {
    const c = comparability(await real(BIG_DUMP, 1), await real(BIG_DUMP, 2));
    expect(c.status).toBe('green');
    expect(c.warnings).toEqual([]);
    expect(c.thrOverlap).toBeGreaterThan(85);
  });

  it('манёвры в снимке и протокол: фристайл без висения, лог 1 кГц', async () => {
    const s = await real(BIG_DUMP, 3);
    expect(s.v).toBe(2);
    const m = s.flight.maneuvers!;
    expect(m.flips[0] + m.flips[1]).toBeGreaterThanOrEqual(6); // анализ рейтов видит 8 флипов/роллов
    expect(m.chops).toBeGreaterThanOrEqual(10);
    const pc = checkProtocol(s, await real(BIG_DUMP, 1), 'other');
    expect(pc.todo).toContain('hover');
    expect(pc.todo).toContain('logRate');
    expect(pc.todo).not.toContain('flipsRoll');
    expect(pc.items.find((i) => i.id === 'comparable')!.state).toBe('ok');
  });
});

describe.skipIf(!hasFixture(SMALL_DUMP))('протокол на логе 2026.6.1 №4', () => {
  it('2 кГц и gyroUnfilt — ок; флипов нет — дослетать', async () => {
    const pc = checkProtocol(await real(SMALL_DUMP, 4), null, 'propwash');
    const st = Object.fromEntries(pc.items.map((i) => [i.id, i.state]));
    expect(st).toMatchObject({ logRate: 'ok', unfilt: 'ok', flipsRoll: 'bad', chops: 'bad' });
    expect(pc.items.find((i) => i.id === 'chops')!.need).toBe(protocolNeeds('propwash').chops);
    expect(protocolNeeds('propwash').chops).toBeGreaterThan(protocolNeeds('other').chops);
  });

  it('полёт на земле (№2, 1 с) против полёта: «лучше» по шуму не выдаётся', async () => {
    const a = await real(SMALL_DUMP, 4);
    const b = await real(SMALL_DUMP, 2);
    const c = comparability(a, b);
    expect(c.status).toBe('red');
    expect(c.warnings).toContain('short');
    expect(metricRows(a, b).filter((r) => r.id === 'noiseFilt').every((r) => r.verdict === 'na')).toBe(true);
  });
});

// --- синтетика: лента итераций ---
const MAN = (o: Partial<ManeuverCount> = {}): ManeuverCount => ({ hoverS: 25, hoverLongestS: 10, flips: [3, 3], punches: 3, chops: 3, ...o });
function fake(dt: string, o: { d?: number; dterm?: number; noise?: number; os?: number; man?: ManeuverCount | undefined; plan?: Record<string, number> | null; sticks?: number[] } = {}): SessionSnapshot {
  const d = o.d ?? 40;
  const ax = (k: number) => ({ rmsUnfilt: 6, rmsFilt: (o.noise ?? 0.5) * k, rmsDterm: o.dterm ?? 10, unfiltDb: null, filtDb: [], dtermDb: null });
  const step = { enough: true, activeS: 60, overshootPct: o.os ?? 10, delayMs: 8, settle: 1, trackRms: 10, spRms: 100, t: [], mean: [], std: [] };
  return {
    v: 2,
    source: { fileName: 'f.bbl', logIndex: 0, datetime: dt, durationS: 120, firmware: 'Betaflight 2026.6.1', fwCode: 0, board: 'B', craft: 'C', fs: 2000 },
    header: { DeviceUID: 'aa' },
    cli: { d_roll: d, p_roll: 50 },
    flight: { seconds: 100, thrHist: [0, 10, 30, 30, 20, 10, 0, 0, 0, 0], stickRms: o.sticks ?? [120, 110, 60], cellV: 3.9, maneuvers: 'man' in o ? o.man : MAN() },
    cards: [],
    noise: { df: 1, nyquist: 1000, axes: [ax(1), ax(0.9), ax(0.7)], thr: { pct: [], seconds: [], filtRms: [], unfiltRms: null } },
    filters: { delay100: 2.5, delayD100: 4.5, match: [95, 95, 95], status: 'green' },
    pid: { axes: [step, step, { ...step, enough: false }] },
    advice: [],
    plan: o.plan ? { from: { d_roll: d }, to: o.plan, ruleIds: ['R-PID-OVERSHOOT-01@1.0'], filters: null } : null,
  } as unknown as SessionSnapshot;
}
const rec = (id: string, snap: SessionSnapshot): SessionRecord => ({ id, projectId: 'p', savedAt: snap.source.datetime, notes: '', snap });

describe('лента итераций кампании', () => {
  const ss = [
    rec('s1', fake('2026-10-01T10:00', { os: 20, plan: { d_roll: 44 } })),
    rec('s2', fake('2026-10-02T10:00', { d: 44, os: 12, plan: { d_roll: 48 } })),
    // третий полёт: план не применён, висение вместо фристайла
    rec('s3', fake('2026-10-03T10:00', { d: 44, os: 9, sticks: [20, 20, 10], man: MAN({ flips: [0, 0], punches: 0, chops: 0 }) })),
    // чужая сессия того же борта, не в кампании
    rec('sx', fake('2026-10-02T12:00')),
  ];
  const c: Campaign = { id: 'c', projectId: 'p', goal: 'sharper', title: '', createdAt: '2026-10-01', status: 'open', sessionIds: ['s3', 's1', 's2'], marks: { s2: { motorTemp: 1, feel: '' } }, notes: '' };

  it('предложено → применено (по заголовку) → вышло', () => {
    const its = iterations(c, ss);
    expect(its.map((i) => i.session.id)).toEqual(['s1', 's2', 's3']);
    expect(its[0]).toMatchObject({ prev: null, proposed: null, applied: null, rows: [] });
    expect(its[1].proposed).toEqual({ rules: ['R-PID-OVERSHOOT-01@1.0'], to: { d_roll: 44 } });
    expect(its[1].applied!.state).toBe('applied');
    expect(its[1].rows.find((r) => r.id === 'overshoot' && r.axis === 0)!.verdict).toBe('better');
    expect(its[1].protocol.ok).toBe(true);
    expect(its[1].mark).toEqual({ motorTemp: 1, feel: '' });
    // план №2 (D 48) не применён; полёт — висение: протокол ругается, вердикты по полёту не выдаются
    expect(its[2].applied!.state).toBe('not');
    expect(its[2].protocol.todo).toEqual(expect.arrayContaining(['flipsRoll', 'flipsPitch', 'punches', 'chops', 'comparable']));
    expect(its[2].rows.filter((r) => r.id === 'noiseFilt').every((r) => r.verdict === 'na')).toBe(true);
  });

  it('метрики по итерациям', () => {
    const m = metricSeries(c, ss);
    expect(m.x).toEqual([1, 2, 3]);
    expect(m.overshoot).toEqual([20, 12, 9]);
    expect(m.noiseFilt[0]).toBeCloseTo(0.5);
    expect(m.motorTemp[1]).toBe(1);
    expect(Number.isNaN(m.motorTemp[0])).toBe(true);
  });

  it('снимок старой версии (без манёвров) — пункты «нет данных», не «провал»', () => {
    const pc = checkProtocol(fake('2026-10-01', { man: undefined }), null, 'other');
    expect(pc.items.find((i) => i.id === 'hover')!.state).toBe('na');
    expect(pc.todo).not.toContain('hover');
  });

  it('новые сессии идут в последнюю открытую кампанию борта', () => {
    const cs: Campaign[] = [{ ...c, id: 'old', createdAt: '2026-09-01' }, { ...c, id: 'new', createdAt: '2026-10-01' }, { ...c, id: 'closed', createdAt: '2026-10-05', status: 'closed' }, { ...c, id: 'other', projectId: 'q', createdAt: '2026-10-06' }];
    expect(openCampaign(cs, 'p')!.id).toBe('new');
    expect(openCampaign(cs, 'z')).toBeNull();
  });
});
