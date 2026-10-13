// Проверка лога «хватает ли данных»: что по нему можно оценить (фильтры, PID) и что долетать.
// Как бесплатная проверка лога у fpvpidtune.com и инструкции чата Blackbox 2.0: фильтрам нужны
// частота записи ≥ 1.6 кГц, гироскоп до фильтров и газ по всему диапазону; PID — резкие снапы
// по осям. Пороги — analysis.json → protocol.

import cfg from '../config/analysis.json';
import { isBenchTest } from './bench';
import type { LogContext } from './context';
import type { ManeuverCount } from './maneuvers';

export type CheckId = 'logRate' | 'unfilt' | 'sweeps' | 'snapsRoll' | 'snapsPitch' | 'snapsYaw' | 'yawSpins' | 'punches';

export interface CheckItem {
  id: CheckId;
  have: number;
  need: number;
  ok: boolean;
  /** необязательный пункт: на вердикт части не влияет */
  optional?: boolean;
}

export interface LogCheck {
  bench: boolean;
  filters: { ok: boolean; items: CheckItem[] };
  pid: { ok: boolean; items: CheckItem[] };
  extra: CheckItem[];
}

export function checkLog(c: Pick<LogContext, 'n' | 'fs' | 'thrPct' | 'motorAvg' | 'hasGyroUnfilt'>, m: ManeuverCount, thrTop: number | null): LogCheck {
  const P = cfg.protocol;
  const it = (id: CheckId, have: number, need: number, optional = false): CheckItem => ({ id, have, need, ok: have >= need, optional });
  // протяжка засчитывается и «по факту»: газ в полёте доходил до верха протяжки
  const sweeps = Math.max(m.sweeps ?? 0, isFinite(thrTop ?? NaN) && thrTop! >= P.sweep.toPct ? 1 : 0);
  const filters = [
    it('logRate', Math.round(c.fs), P.minLogHz),
    it('unfilt', c.hasGyroUnfilt ? 1 : 0, 1),
    it('sweeps', sweeps, P.sweep.need),
  ];
  const sn = m.snaps ?? [0, 0, 0];
  const pid = [
    it('snapsRoll', sn[0], P.snap.need),
    it('snapsPitch', sn[1], P.snap.need),
    it('snapsYaw', sn[2], P.snap.needYaw, true),
  ];
  const extra = [it('yawSpins', m.yawSpins ?? 0, P.yawSpin.need, true), it('punches', m.punches, P.punch.need, true)];
  const ok = (xs: CheckItem[]): boolean => xs.every((x) => x.ok || x.optional);
  return { bench: isBenchTest(c), filters: { ok: ok(filters), items: filters }, pid: { ok: ok(pid), items: pid }, extra };
}
