// Разбор вывода CLI Betaflight (B4–B5). Форматы — по cli/cli.c BF 2026.6.1:
//  - `dump all` / `diff all`: строки `set <имя> = <значение>`; секции `profile N`, `rateprofile N`,
//    `battery_profile N` (2026.6); служебные строки `# …` (cliPrintHashLine);
//  - `set x = v` → `x set to v`; ошибка → `###ERROR IN set: INVALID NAME: x###`,
//    `###ERROR IN set: INVALID VALUE###` + `Allowed range: …`;
//  - `get x` → `x = v` (+ диапазон и значение по умолчанию).
// Здесь же — какие строки утилите разрешено посылать в CLI (белый список).

import { paramByName } from '../params/registry';

export interface CliConfig {
  master: Record<string, string>;
  profile: Record<number, Record<string, string>>;
  rate: Record<number, Record<string, string>>;
  battery: Record<number, Record<string, string>>;
}

/** разбор `dump all` / `diff all` по секциям */
export function parseConfig(text: string): CliConfig {
  const cfg: CliConfig = { master: {}, profile: {}, rate: {}, battery: {} };
  let cur = cfg.master;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^profile (\d+)$/))) cur = cfg.profile[+m[1]] ??= {};
    else if ((m = line.match(/^rateprofile (\d+)$/))) cur = cfg.rate[+m[1]] ??= {};
    else if ((m = line.match(/^battery_profile (\d+)$/))) cur = cfg.battery[+m[1]] ??= {};
    else if ((m = line.match(/^set (\S+) = (.*)$/))) cur[m[1]] = m[2].trim();
  }
  return cfg;
}

/** действующие значения: общие + активный PID-профиль + активный профиль рейтов */
export function effectiveValues(c: CliConfig, pidProfile: number, rateProfile: number, batteryProfile = 0): Record<string, string> {
  return { ...c.master, ...(c.profile[pidProfile] ?? {}), ...(c.rate[rateProfile] ?? {}), ...(c.battery[batteryProfile] ?? {}) };
}

/** значение CLI → число, как в справочнике (перечисления — индекс слова) */
export function cliToNumber(name: string, v: string): number | null {
  const p = paramByName.get(name);
  if (p?.options) {
    const i = p.options.findIndex((o) => o.toUpperCase() === v.toUpperCase());
    return i >= 0 ? i : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** известные справочнику параметры с борта — числами (как cliFromHeader для заголовка лога) */
export function boardNumbers(values: Record<string, string>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!paramByName.has(k)) continue;
    const n = cliToNumber(k, v);
    if (n !== null) o[k] = n;
  }
  return o;
}

/** «заголовок лога ↔ борт»: параметры, которые на борту уже не такие, как в логе */
export function headerVsBoard(header: Record<string, number>, board: Record<string, number>): { key: string; log: number; board: number }[] {
  return Object.keys(header)
    .filter((k) => k in board && board[k] !== header[k])
    .sort()
    .map((k) => ({ key: k, log: header[k], board: board[k] }));
}

export type SetResult = { ok: true } | { ok: false; error: string };

/** ответ на `set name = …` */
export function setResult(resp: string, name: string): SetResult {
  const err = resp.match(/###ERROR[^#]*###(?:\s*\r?\n?(Allowed range:[^\r\n]*|Allowed values:[^\r\n]*))?/);
  if (err) return { ok: false, error: err[0].replace(/\s+/g, ' ').trim() };
  if (new RegExp(`^${name} set to `, 'm').test(resp)) return { ok: true };
  return { ok: false, error: resp.trim().split(/\r?\n/)[0] || 'нет ответа' };
}

/** ответ на `get name` → значение */
export function getValue(resp: string, name: string): string | null {
  const m = resp.match(new RegExp(`^${name} = (.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

// --- что можно посылать в CLI ---
const ALLOWED: RegExp[] = [
  /^set [a-z0-9_]+ = [A-Za-z0-9_.\-]+$/,
  /^get [a-z0-9_]+$/,
  /^(diff|dump) all$/,
  /^save$/,
  /^exit( noreboot)?$/,
  /^version$/,
];

/** строка, которую утилита согласна послать в CLI (моторы, загрузчик, defaults и т. п. — нет) */
export function cliAllowed(line: string): boolean {
  return ALLOWED.some((r) => r.test(line));
}

/** имя параметра из `set x = v` */
export function setName(line: string): string | null {
  return line.match(/^set ([a-z0-9_]+) = /)?.[1] ?? null;
}
