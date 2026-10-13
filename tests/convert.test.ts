// Перенос diff между версиями Betaflight (как конвертер имён у fpvpidtune.com).
import { describe, expect, it } from 'vitest';
import { RENAMES, convertDiff } from '../src/params/convert';
import names from '../src/params/bf-names.json';

const V = names.versions as Record<string, string[]>;

describe('перенос настроек между версиями', () => {
  it('каждая пара переименования проверена по исходникам: старое имя — в старой версии, новое — в новой', () => {
    const vers = Object.keys(V);
    for (const r of RENAMES) {
      const before = vers[vers.indexOf(r.at) - 1];
      expect(V[before], r.old).toContain(r.old);
      expect(V[r.at], r.new).toContain(r.new);
    }
  });

  it('4.2 → 2026.6: фильтры переименованы, смысл изменился — комментарий, D min/D max переставлены', () => {
    const r = convertDiff(['# profile 0', 'set gyro_lowpass2_hz = 300', 'set dyn_lpf_dterm_min_hz = 80', 'set ff_spike_limit = 60', 'set d_roll = 40', 'set d_min_roll = 28', 'set tpa_rate = 65', 'set no_such_thing = 1'].join('\n'), '4.2.11', '2026.6.1');
    expect(r.lines).toContain('set gyro_lpf2_static_hz = 300');
    expect(r.lines).toContain('set dterm_lpf1_dyn_min_hz = 80');
    expect(r.lines.some((l) => l.startsWith('# feedforward_jitter_factor: было 60'))).toBe(true);
    expect(r.lines).toContain('set d_roll = 28');
    expect(r.lines).toContain('set d_max_roll = 40');
    expect(r.lines).toContain('set tpa_rate = 65');
    expect(r.lines.some((l) => l.startsWith('# set no_such_thing = 1'))).toBe(true);
    expect(r.lines[0]).toBe('# profile 0');
  });

  it('в пределах одной ветки ничего не трогаем', () => {
    const r = convertDiff('set d_roll = 40\nset d_min_roll = 28', '4.5.0', '4.5.0');
    expect(r.lines).toEqual(['set d_roll = 40', 'set d_min_roll = 28']);
    expect(r.notes).toEqual([]);
  });
});
