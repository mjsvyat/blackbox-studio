// Обучение по истории (A3–A4): синтетическая кампания из 6 сессий — одно правило стабильно помогает
// (D-term фильтр), другое дважды ухудшило (D вверх → перерегулирование выросло). Ожидаем: второе
// «с осторожностью» и предложение отключить его для класса; моторы горячие при «зелёном» D-term —
// предложение опустить красный порог D-term со ссылками на нужные сессии.
import { describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import type { Campaign } from '../src/campaigns/campaign';
import { accuracy, historyEntry, proposeThresholds } from '../src/campaigns/learning';
import { CAMPAIGN_FORMAT, campaignExport, campaignHtml, readCampaignHtml } from '../src/report/campaignReport';
import type { Incident } from '../src/incidents/incidents';
import type { SessionRecord } from '../src/sessions/db';
import { SNAPSHOT_VERSION, type SessionSnapshot } from '../src/sessions/snapshot';

const DT = 'R-FLT-DTERM-HOT-01', OS = 'R-PID-OVERSHOOT-01';
interface Plan { rule: string; to: Record<string, number> }
function snap(dt: string, cli: Record<string, number>, o: { dterm: number; os: number; plan?: Plan; delayD?: number }): SessionSnapshot {
  const ax = { rmsUnfilt: 6, rmsFilt: 0.5, rmsDterm: o.dterm, unfiltDb: null, filtDb: [], dtermDb: null };
  const step = { enough: true, activeS: 60, overshootPct: o.os, delayMs: 8, settle: 1, trackRms: 10, spRms: 100, t: [], mean: [], std: [] };
  const from = o.plan ? Object.fromEntries(Object.keys(o.plan.to).map((k) => [k, cli[k]])) : {};
  return {
    v: SNAPSHOT_VERSION,
    source: { fileName: 'f.bbl', logIndex: +dt.slice(8, 10), datetime: dt, durationS: 120, firmware: 'Betaflight 2026.6.1', fwCode: 0, board: 'B', craft: 'C', fs: 2000 },
    header: { DeviceUID: 'aa' },
    cli,
    flight: { seconds: 100, thrHist: [0, 10, 30, 30, 20, 10, 0, 0, 0, 0], stickRms: [120, 110, 60], cellV: 3.9, maneuvers: { hoverS: 25, hoverLongestS: 10, flips: [3, 3], punches: 3, chops: 3 } },
    cards: [],
    noise: { df: 1, nyquist: 1000, axes: [ax, ax, ax], thr: { pct: [], seconds: [], filtRms: [], unfiltRms: null } },
    filters: { delay100: 2.5, delayD100: o.delayD ?? 4.5, match: [95, 95, 95], status: 'green' },
    pid: { axes: [step, step, { ...step, enough: false }] },
    advice: o.plan ? [{ id: o.plan.rule, version: '1.0', kind: 'tune', severity: 'warn', selected: true, deferred: null, inputs: {}, changes: o.plan.to, from }] : [],
    plan: o.plan ? { from, to: o.plan.to, ruleIds: [`${o.plan.rule}@1.0`], filters: null } : null,
  } as unknown as SessionSnapshot;
}
const rec = (id: string, s: SessionSnapshot): SessionRecord => ({ id, projectId: 'p', savedAt: s.source.datetime, notes: '', snap: s });

const M = 'simplified_dterm_filter_multiplier';
const ss = [
  rec('s1', snap('2026-10-01T10:00', { [M]: 100, d_roll: 30 }, { dterm: 25, os: 12, plan: { rule: DT, to: { [M]: 90 } } })),
  rec('s2', snap('2026-10-02T10:00', { [M]: 90, d_roll: 30 }, { dterm: 18, os: 12, plan: { rule: OS, to: { d_roll: 33 } } })),
  rec('s3', snap('2026-10-03T10:00', { [M]: 90, d_roll: 33 }, { dterm: 18, os: 18, plan: { rule: DT, to: { [M]: 80 } } })),
  rec('s4', snap('2026-10-04T10:00', { [M]: 80, d_roll: 33 }, { dterm: 12, os: 18, plan: { rule: OS, to: { d_roll: 36 } } })),
  rec('s5', snap('2026-10-05T10:00', { [M]: 80, d_roll: 36 }, { dterm: 12, os: 25 })),
  rec('s6', snap('2026-10-06T10:00', { [M]: 80, d_roll: 36 }, { dterm: 14, os: 25 })),
  // чужой борт — не учитывается ни в точности, ни в предложениях
  { ...rec('x1', snap('2026-10-02T11:00', { [M]: 100, d_roll: 30 }, { dterm: 30, os: 5 })), projectId: 'q' },
];
const c: Campaign = {
  id: 'c', projectId: 'p', goal: 'cooler', title: 'Горячие моторы', createdAt: '2026-10-01', status: 'open',
  sessionIds: ['s1', 's2', 's3', 's4', 's5', 's6'], notes: '',
  marks: { s2: { motorTemp: 1, feel: '' }, s4: { motorTemp: 1, feel: '' }, s5: { motorTemp: 2, feel: '' }, s6: { motorTemp: 3, feel: 'обжигают' } },
};
const inc: Incident = { id: 'INC-0007', projectId: 'p', sessionId: 's6', beforeId: 's5', createdAt: '2026-10-06', symptoms: ['hot-motors'], text: '', tLog: null, severity: 2, motorTemp: 3, media: '', status: 'open', resolution: '' };

describe('точность правил по кампании (A3)', () => {
  it('D-term фильтр помог 2/2, D вверх ухудшил 2/2 → «с осторожностью»', () => {
    const a = accuracy(ss, []);
    expect(a.pairs).toBe(4);
    const dt = a.rules.find((r) => r.rule === DT)!;
    expect(dt).toMatchObject({ applied: 2, better: 2, worse: 0, caution: false });
    const os = a.rules.find((r) => r.rule === OS)!;
    expect(os).toMatchObject({ applied: 2, better: 0, worse: 2, caution: true });
  });

  it('пары без применённого плана и чужой борт не считаются', () => {
    const notApplied = ss.map((s) => (s.id === 's2' ? rec('s2', snap('2026-10-02T10:00', { [M]: 100, d_roll: 30 }, { dterm: 18, os: 12, plan: { rule: OS, to: { d_roll: 33 } } })) : s));
    const a = accuracy(notApplied, []);
    expect(a.rules.find((r) => r.rule === DT)!.applied).toBe(1);
  });

  it('ослабление фильтра оценивается по задержке: задержка вниз, D-term на месте — «лучше»', () => {
    const R = 'R-FLT-DTERM-RAISE-01';
    const a = accuracy([
      rec('r1', snap('2026-10-01T10:00', { [M]: 100 }, { dterm: 10, os: 12, plan: { rule: R, to: { [M]: 120 } } })),
      rec('r2', snap('2026-10-02T10:00', { [M]: 120 }, { dterm: 10.5, os: 12, delayD: 3.5 })),
    ], []);
    expect(a.rules.find((r) => r.rule === R)).toMatchObject({ applied: 1, better: 1, worse: 0 });
  });
});

describe('предложения порогов (A4)', () => {
  const ps = proposeThresholds(c, ss, [inc], '5in');

  it('моторы горячие при «зелёном» D-term → красный порог ниже, доказательства s5, s6', () => {
    const p = ps.find((x) => x.id === 'dterm-red-down')!;
    expect(p.path).toBe('classes.list.5in.overrides.advisor.dtermRms.red');
    expect(p.was).toBe(cfg.advisor.dtermRms.red);
    expect(p.now).toBe(Math.floor(12 * (1 - cfg.learning.marginPct / 100)));
    expect(p.evidence.map((e) => e.sessionId)).toEqual(['s5', 's6']);
    expect(p.evidence.map((e) => e.value)).toEqual([12, 14]);
    expect(p.evidence.map((e) => e.motorTemp)).toEqual([2, 3]);
    expect(p.incidents).toEqual(['INC-0007']);
    expect(p.rules).toContain(DT);
    // прошлые сессии, где светофор D-term станет красным (кроме самих доказательств)
    expect(p.affected.map((e) => e.sessionId)).toEqual(['s2', 's3', 's4']);
  });

  it('правило, дважды ухудшившее, — отключить для класса борта; доказательства s3, s5', () => {
    const p = ps.find((x) => x.id === 'rule-disable')!;
    expect(p.path).toBe('classes.list.5in.overrides.advisor.disabledRules');
    expect(p.now).toEqual([...(p.was as string[]), OS]);
    expect(p.rules).toEqual([OS]);
    expect(p.evidence.map((e) => e.sessionId)).toEqual(['s3', 's5']);
    expect(p.evidence.map((e) => e.value)).toEqual([18, 25]);
    expect(p.affected.map((e) => e.sessionId)).toEqual(['s2', 's4']);
    // помогающее правило не предлагается к отключению, «красный выше» — не предлагается
    expect(ps.filter((x) => x.id === 'rule-disable')).toHaveLength(1);
    expect(ps.find((x) => x.id === 'dterm-red-up')).toBeUndefined();
  });

  it('мало доказательств — предложений нет (порог не двигается по одному полёту)', () => {
    const one: Campaign = { ...c, marks: { s6: { motorTemp: 3, feel: '' } }, sessionIds: ['s1', 's2', 's3', 's6'] };
    expect(proposeThresholds(one, ss, [], '5in')).toEqual([]);
  });

  it('запись для _history: версия +1, кто и почему', () => {
    const h = historyEntry(ps[0], c.title, '1.3');
    expect(h).toMatchObject({ version: '1.4', was: ps[0].was, now: ps[0].now, by: expect.stringContaining('A4') });
    expect(String(h.why)).toContain('2026-10-05');
  });
});

describe('экспорт кампании одним файлом (A5)', () => {
  const project = { id: 'p', name: 'Velox 5"', craftKey: 'C', uid: 'aa', createdAt: '2026-10-01', notes: '' };
  const x = campaignExport(c, project, ss, [inc], '5in');
  const html = campaignHtml(x);

  it('HTML самодостаточный: итерации, точность, предложения, без внешних ссылок и undefined', () => {
    for (const part of ['<!doctype html>', 'Горячие моторы', 'Итерации', 'Точность прогнозов и правил', OS, 'с осторожностью', 'Предложения по порогам', 'classes.list.5in.overrides.advisor.dtermRms.red', 'INC-0007', '_history']) expect(html).toContain(part);
    expect(html).not.toMatch(/undefined|NaN/);
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('JSON внутри читается обратно; чужой борт не попал; предложения с записью для _history', () => {
    const back = readCampaignHtml(html)!;
    expect(back.format).toBe(CAMPAIGN_FORMAT);
    expect(back.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(back.incidents.map((i) => i.id)).toEqual(['INC-0007']);
    expect(back.proposals.map((p) => p.id).sort()).toEqual(['dterm-red-down', 'rule-disable']);
    expect(back.proposals[0].history).toMatchObject({ version: expect.any(String), by: expect.stringContaining('A4') });
    expect(back.accuracy.rules.find((r) => r.rule === OS)!.caution).toBe(true);
  });

  it('«</script>» в заметке не ломает встроенный JSON', () => {
    const h2 = campaignHtml(campaignExport({ ...c, notes: 'x</script><b>y' }, project, ss, [], '5in'));
    expect(readCampaignHtml(h2)!.campaign.notes).toBe('x</script><b>y');
  });
});
