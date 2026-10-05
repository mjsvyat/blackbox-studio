// Этап 4: советчик. Правила — на подставных цифрах (условие → изменение → выбор
// итерации) и на настоящих логах (тот же путь, что в воркере).
import { describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import { AdvisorInput, runAdvisor } from '../src/advisor/advisor';
import { buildContext } from '../src/analysis/context';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { applySimplified } from '../src/filters/settings';
import { T } from '../src/i18n/ru';
import type { PidResult } from '../src/pid/analyze';
import { adviseLog, analyzeLog } from '../src/analysis/pipeline';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const FW = 2_026_006_001;
const FILTERS = { simplified_gyro_filter: 1, simplified_gyro_filter_multiplier: 100, gyro_lpf1_dyn_min_hz: 250, gyro_lpf1_dyn_max_hz: 500, gyro_lpf1_static_hz: 250, gyro_lpf2_static_hz: 500, simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 100, dterm_lpf1_dyn_min_hz: 75, dterm_lpf1_dyn_max_hz: 150, dterm_lpf1_static_hz: 75, dterm_lpf2_static_hz: 150, dyn_notch_count: 3, dyn_notch_min_hz: 150, dyn_notch_max_hz: 600 };
const SIMPL = { s: { mode: 2, master: 100, pi: 100, i: 100, d: 100, dExtra: 100, ff: 100, pitchD: 100, pitchPi: 100 }, dExtraName: 'simplified_d_max_gain' };

function pidWith(os: number, settle: number, enough = true, delay = 12): PidResult {
  const ax = (axis: number) => ({
    axis, step: { t: new Float32Array(1), mean: new Float32Array(1), std: new Float32Array(1), parts: [], activeS: enough ? 60 : 5, usedS: 60 },
    metrics: { overshootPct: os, peak: 1 + os / 100, peakMs: 40, delayMs: delay, riseMs: 15, settle }, enough, stdAtPeak: 0.02,
    trackRms: 5, spRms: 50, contrib: { P: 10, I: 10, D: 10, F: 5 }, ffJitter: 0.2,
  });
  return { axes: [ax(0), ax(1), ax(2)], gains: { P: [45, 47, 45], I: [80, 84, 80], D: [30, 34, 0], F: [120, 125, 120], dExtra: [40, 46, 0], dExtraKind: 'd_max' }, seconds: 60, satS: 0 };
}

function input(over: Partial<AdvisorInput> = {}, noise: Partial<NonNullable<AdvisorInput['noise']>> = {}): AdvisorInput {
  return {
    fwCode: FW, logHz: 2000, hasUnfilt: true,
    noise: { unfilt: [6, 5, 4], filt: [0.5, 0.4, 0.3], dterm: [3, 2, null], peaks: [], ...noise },
    filters: { params: { ...FILTERS }, status: 'green', reason: 'ok' },
    pid: pidWith(5, 1.0), simplified: SIMPL, dKind: 'd_max',
    motors: { satPct: 0.2, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 6 },
    ...over,
  };
}

const ids = (r: ReturnType<typeof runAdvisor>) => r.advice.map((a) => a.id);
const sel = (r: ReturnType<typeof runAdvisor>) => r.advice.filter((a) => a.kind === 'tune' && a.selected).map((a) => a.id);

describe('правила советчика', () => {
  it('чистый борт, модель зелёная → можно ослабить фильтры, с предупреждением «потрогай моторы»', () => {
    const r = runAdvisor(input());
    // два «рискованных» изменения за раз нельзя — второе отложено
    expect(sel(r)).toEqual(['R-FLT-GYRO-RAISE-01']);
    expect(r.advice.find((x) => x.id === 'R-FLT-DTERM-RAISE-01')!.deferred).toBe('one-risky');
    const a = r.advice.find((x) => x.id === 'R-FLT-GYRO-RAISE-01')!;
    expect(a.safety).toBe(true);
    expect(a.changes.simplified_gyro_filter_multiplier).toBe(110);
    // срезы — как дал бы simplified_tuning.c
    const q = applySimplified({ ...FILTERS, simplified_gyro_filter_multiplier: 110 });
    expect(a.changes.gyro_lpf2_static_hz).toBe(q.gyro_lpf2_static_hz);
    expect(T.adv.safety).toMatch(/20–30 с/);
    expect(T.adv.safety).toMatch(/потрогай моторы/);
  });

  it('модель не зелёная → фильтры не ослабляем', () => {
    const r = runAdvisor(input({ filters: { params: { ...FILTERS }, status: 'yellow', reason: 'low-rate' } }));
    expect(ids(r)).not.toContain('R-FLT-GYRO-RAISE-01');
  });

  it('срыв в воздухе → настройки отложены', () => {
    const r = runAdvisor(input({ motors: { satPct: 0.2, spreadPct: 5, desyncs: 0, airClips: 1, clipT: [21.8] } }));
    expect(ids(r)[0]).toBe('R-MECH-DESYNC-01');
    expect(sel(r)).toEqual([]);
  });

  it('механика шумит → все настройки отложены', () => {
    const r = runAdvisor(input({}, { unfilt: [cfg.noise.unfiltRms.red + 5, 5, 4], filt: [5, 1, 1], dterm: [30, 5, null] }));
    expect(ids(r)[0]).toBe('R-MECH-NOISE-01');
    for (const a of r.advice.filter((x) => x.kind === 'tune')) expect(a.deferred).toBe('mechanics-first');
    expect(Object.keys(r.to)).toEqual([]);
  });

  it('D-term горячий → фильтр D-term сильнее, даже на 1 кГц-логе', () => {
    const r = runAdvisor(input({ logHz: 1000, filters: { params: { ...FILTERS, simplified_dterm_filter_multiplier: 140 }, status: 'red', reason: 'low-rate' } }, { dterm: [25, 9, null], filt: [2, 1, 1] }));
    expect(ids(r)).toContain('R-LOG-RATE-01');
    const a = r.advice.find((x) => x.id === 'R-FLT-DTERM-HOT-01')!;
    expect(a.selected).toBe(true);
    expect(a.changes.simplified_dterm_filter_multiplier).toBe(125); // −10 % от 140, кратно 5
    expect(a.safety).toBe(false);
  });

  it('перерегулирование, D-term чистый → D выше через слайдер (PID готовыми числами)', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 1.0) }));
    const a = r.advice.find((x) => x.id === 'R-PID-OVERSHOOT-01')!;
    expect(a.inputs.way).toBe('d');
    expect(a.safety).toBe(true);
    expect(a.changes.simplified_d_gain).toBe(110);
    expect(a.changes.d_roll).toBe(33); // trunc(30 × 1.1)
    expect(a.changes.d_max_roll).toBe(44);
    expect(a.changes.p_roll).toBeUndefined();
  });

  it('запас по фазе мал (C) → P/D не поднимаем: подъём D отложен, ослабление фильтров (меньше задержки) — можно', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 1.0), stability: [{ axis: 0, pmDeg: 24, gmDb: 8, crossHz: 45, source: 'chirp' }] }));
    const pm = r.advice.find((x) => x.id === 'R-STAB-PM-LOW-01')!;
    expect(pm.severity).toBe('red');
    expect(pm.inputs).toMatchObject({ pm: 24, axis: 0, src: 'chirp' });
    const os = r.advice.find((x) => x.id === 'R-PID-OVERSHOOT-01')!;
    expect(os.inputs.way).toBe('d');
    expect(os.deferred).toBe('stability');
    expect(Object.keys(r.to).some((k) => /^d_|simplified_d_gain/.test(k))).toBe(false);
    expect(r.advice.find((x) => x.id === 'R-FLT-GYRO-RAISE-01')!.selected).toBe(true);
    expect(T.adv.rules['R-STAB-PM-LOW-01'].risk).toMatch(/20–30 с/);
  });

  it('запас по амплитуде мал (C) → P и I на шаг ниже, подъём D отложен', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 1.0), stability: [{ axis: 1, pmDeg: 50, gmDb: 2, crossHz: 40, source: 'chirp' }] }));
    const gm = r.advice.find((x) => x.id === 'R-STAB-GM-LOW-01')!;
    expect(gm.selected).toBe(true);
    expect(gm.changes.simplified_pi_gain).toBe(90);
    expect(r.advice.find((x) => x.id === 'R-PID-OVERSHOOT-01')!.deferred).toBe('stability');
  });

  it('запасы в норме — правила не срабатывают, D поднимается как обычно', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 1.0), stability: [{ axis: 0, pmDeg: 55, gmDb: 9, crossHz: 45, source: 'chirp' }] }));
    expect(r.advice.some((x) => x.id.startsWith('R-STAB'))).toBe(false);
    expect(r.advice.find((x) => x.id === 'R-PID-OVERSHOOT-01')!.selected).toBe(true);
  });

  it('перерегулирование, D-term шумный → не D, а меньше P и I', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 1.0) }, { dterm: [12, 9, null] }));
    const a = r.advice.find((x) => x.id === 'R-PID-OVERSHOOT-01')!;
    expect(a.inputs.way).toBe('p');
    expect(a.safety).toBe(false);
    expect(a.changes.simplified_pi_gain).toBe(90);
    expect(a.changes.d_roll).toBeUndefined();
  });

  it('Simplified выключен → меняем p_/d_ напрямую на 10 %', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 1.0), simplified: { ...SIMPL, s: { ...SIMPL.s, mode: 0 } } }));
    const a = r.advice.find((x) => x.id === 'R-PID-OVERSHOOT-01')!;
    expect(a.changes).toEqual({ d_roll: 33, d_pitch: 37 });
  });

  it('проседание → I; вялость → FF; мало данных → тестовый полёт, без советов по PID', () => {
    expect(runAdvisor(input({ pid: pidWith(5, 0.85) })).advice.find((x) => x.id === 'R-PID-SAG-01')!.changes.simplified_i_gain).toBe(110);
    expect(runAdvisor(input({ pid: pidWith(1, 1.0, true, 40) })).advice.find((x) => x.id === 'R-PID-SLUGGISH-01')!.changes.simplified_feedforward_gain).toBe(110);
    const r = runAdvisor(input({ pid: pidWith(30, 0.8, false) }));
    expect(ids(r)).toContain('R-STEP-DATA-01');
    expect(ids(r).filter((x) => x.startsWith('R-PID-'))).toEqual([]);
  });

  it('насыщение моторов → проблема авторитета, PID не трогаем', () => {
    const r = runAdvisor(input({ pid: pidWith(30, 1.0), motors: { satPct: 10, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] } }));
    expect(ids(r)).toContain('R-AUTH-SAT-01');
    expect(ids(r).filter((x) => x.startsWith('R-PID-'))).toEqual([]);
  });

  it('не больше двух параметрических советов за итерацию', () => {
    const r = runAdvisor(input({ pid: pidWith(25, 0.85) }, { dterm: [25, 9, null], filt: [5, 1, 1] }));
    expect(sel(r).length).toBeLessThanOrEqual(cfg.advisor.maxChanges);
    expect(r.advice.some((a) => a.deferred === 'max-changes' || a.deferred === 'same-param')).toBe(true);
  });

  it('резонанс рамы вне диапазона дин. нотча → расширить диапазон', () => {
    const r = runAdvisor(input({}, { peaks: [{ axis: 1, kind: 'frame', hz: 120, prominenceDb: 20 }] }));
    const a = r.advice.find((x) => x.id === 'R-DYN-NOTCH-RANGE-01')!;
    expect(a.changes.dyn_notch_min_hz).toBe(100);
  });

  it('параметр, которого нет в версии прошивки, не советуем', () => {
    const r = runAdvisor(input({ fwCode: 4_002_000 }));
    for (const a of r.advice) for (const k of Object.keys(a.changes)) expect(k.startsWith('simplified_')).toBe(false);
  });

  it('у каждого сработавшего правила есть тексты', () => {
    const all = [input(), input({ pid: pidWith(25, 0.85) }, { dterm: [25, 9, null], unfilt: [50, 5, 4] }), input({ hasUnfilt: false, logHz: 1000, motors: { satPct: 10, spreadPct: 30, desyncs: 1, airClips: 2, clipT: [21.8, 26.1] }, power: { resistanceMOhm: 80, rippleP99: 5, cells: 6 }, pid: pidWith(1, 1, false) })];
    for (const inp of all) for (const a of runAdvisor(inp).advice) {
      const t = T.adv.rules[a.id];
      expect(t, a.id).toBeDefined();
      expect(t.seen(a.inputs)).not.toMatch(/undefined/);
    }
  });
});

/** тот же путь, что в воркере (analysis/pipeline.ts) */
async function run(file: string, index: number) {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const c = buildContext(decodeLog(readRange(file, L.start, end - L.start)));
  return adviseLog(analyzeLog(c));
}

describe.skipIf(!hasFixture(SMALL_DUMP))('советчик на логе 2026.6.1 №4', () => {
  it('два срыва в воздухе → сначала механика, фильтры не ослабляем; мало стиков → тестовый полёт', async () => {
    const r = await run(SMALL_DUMP, 4);
    expect(ids(r)[0]).toBe('R-MECH-DESYNC-01');
    for (const a of r.advice.filter((x) => x.kind === 'tune')) expect(a.selected).toBe(false);
    expect(Object.keys(r.to)).toEqual([]);
    expect(ids(r)).toContain('R-STEP-DATA-01');
    expect(ids(r).filter((x) => x.startsWith('R-PID-'))).toEqual([]);
    expect(ids(r)).not.toContain('R-MECH-NOISE-01');
  });
});

describe.skipIf(!hasFixture(BIG_DUMP))('советчик на логе 4.5.2 №3', () => {
  it('D-term на ролле горячий (gyro ×160, D ×140) → фильтр D-term сильнее; лог 1 кГц — предупреждение', async () => {
    const r = await run(BIG_DUMP, 3);
    expect(ids(r)).toContain('R-LOG-RATE-01');
    const a = r.advice.find((x) => x.id === 'R-FLT-DTERM-HOT-01')!;
    expect(a.selected).toBe(true);
    expect(a.from.simplified_dterm_filter_multiplier).toBe(140);
    expect(a.changes.simplified_dterm_filter_multiplier).toBe(125);
    // фильтры не ослабляем, D не поднимаем
    expect(ids(r)).not.toContain('R-FLT-GYRO-RAISE-01');
    expect(r.advice.some((x) => x.selected && x.safety)).toBe(false);
  });
});
