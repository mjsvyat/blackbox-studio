// Перенос настроек между бортами (E2.5): «взять фильтры / рейты / PID с борта X как старт для Y».
// Значения — из заголовка последнего лога X; CLI считается от заголовка последнего лога Y и
// проходит проверку диапазонов и версии прошивки Y (cliDiff: нет параметра в версии — пропуск
// с причиной, вне диапазона — к границе). Механика у бортов разная — это старт, не настройка.

import { paramsFromHeader } from '../filters/settings';
import { CliResult, cliDiff } from '../params/registry';
import { gainsFromHeader, gainsToCli, simplifiedFromHeader, simplifiedToCli } from '../pid/gains';
import { profileToCli, ratesFromHeader } from '../rates/rates';
import type { SessionSnapshot } from './snapshot';

export type TransferGroup = 'filters' | 'rates' | 'pid';
export const TRANSFER_GROUPS: TransferGroup[] = ['filters', 'rates', 'pid'];

/** параметры группы по заголовку лога (имена CLI) */
export function groupKeys(H: Record<string, string>, g: TransferGroup): string[] {
  if (g === 'filters') return Object.keys(paramsFromHeader(H));
  if (g === 'rates') {
    const r = ratesFromHeader(H);
    if (!r) return [];
    const k = profileToCli(r);
    delete k.quickrates_rc_expo; // в заголовок не пишется
    return Object.keys(k);
  }
  const keys = Object.keys(gainsToCli(gainsFromHeader(H)));
  const s = simplifiedFromHeader(H);
  if (s) keys.push(...Object.keys(simplifiedToCli(s.s, s.dExtraName)).filter((k) => !/filter/.test(k)));
  return keys;
}

export interface Transfer extends CliResult {
  from: Record<string, number>;
  to: Record<string, number>;
  /** в источнике есть, у получателя под этим именем нет (например, d_min в 4.5 → d_max в 2025.12+) */
  notInTarget: string[];
}

export function transferCli(src: SessionSnapshot, dst: SessionSnapshot, groups: TransferGroup[]): Transfer {
  const keys = new Set(groups.flatMap((g) => groupKeys(src.header, g)));
  const to: Record<string, number> = {};
  const from: Record<string, number> = {};
  const notInTarget: string[] = [];
  for (const k of keys) {
    if (!(k in src.cli)) continue;
    if (!(k in dst.cli)) notInTarget.push(k);
    to[k] = src.cli[k];
    if (k in dst.cli) from[k] = dst.cli[k];
  }
  const r = cliDiff(from, to, dst.source.fwCode);
  return { ...r, from, to, notInTarget };
}
