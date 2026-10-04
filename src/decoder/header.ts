// Разбор заголовка лога ("H ..." строки) и описаний кадров.

export interface FieldDef {
  names: string[];
  count: number;
  signed: number[];
  pred: number[];
  enc: number[];
  /** true, если имя полей пришлось лечить (баг дубля 64 байт, BF ≤ 2026.6, PR #15525) */
  repairedNames: boolean;
}

export interface ParsedHeader {
  H: Record<string, string>;
  /** смещение первого байта данных относительно начала буфера */
  dataStart: number;
}

const latin1 = (b: Uint8Array, a: number, z: number): string => {
  let s = '';
  for (let i = a; i < z; i++) s += String.fromCharCode(b[i]);
  return s;
};

export function parseHeader(buf: Uint8Array, start = 0): ParsedHeader {
  const H: Record<string, string> = {};
  let p = start;
  while (p < buf.length - 2 && buf[p] === 0x48 && buf[p + 1] === 0x20) {
    let nl = p;
    while (nl < buf.length && buf[nl] !== 0x0a) nl++;
    if (nl >= buf.length) break;
    const line = latin1(buf, p + 2, nl);
    const c = line.indexOf(':');
    if (c > 0) H[line.slice(0, c)] = line.slice(c + 1);
    p = nl + 1;
  }
  return { H, dataStart: p };
}

export function frameDef(H: Record<string, string>, letter: string, namesFrom?: string): FieldDef | null {
  let names = H[`Field ${letter} name`] ?? (namesFrom ? H[`Field ${namesFrom} name`] : undefined);
  if (!names) return null;
  let repaired = false;
  // Betaflight ≤ 2026.6 может продублировать 64-байтный кусок внутри строки заголовка
  // (исправлено в PR #15525) — список имён склеен из обрывков через ":". Берём сегмент,
  // у которого число полей совпадает со строками signed/predictor/encoding.
  if (names.includes(':')) {
    const want = (H[`Field ${letter} signed`] || H[`Field ${letter} encoding`] || '').split(',').length;
    const segs = names.split(':');
    const good = segs.filter((s) => s.split(',').length === want);
    names = good.length ? good[good.length - 1] : segs[segs.length - 1];
    repaired = true;
  }
  const n = names.split(',');
  const num = (k: string, def: number): number[] => {
    const v = H[`Field ${letter} ${k}`];
    return v ? v.split(',').map(Number) : n.map(() => def);
  };
  return { names: n, count: n.length, signed: num('signed', 0), pred: num('predictor', 0), enc: num('encoding', 0), repairedNames: repaired };
}

export interface FirmwareInfo {
  type: string;
  /** "4.5.2", "2026.6.1" */
  version: string;
  major: number;
  minor: number;
  patch: number;
  /** сравнимое число: major*1e6 + minor*1e3 + patch */
  code: number;
  target: string;
  raw: string;
}

export function parseFirmware(H: Record<string, string>): FirmwareInfo {
  const raw = H['Firmware revision'] || '';
  const m = raw.match(/^(\S+)\s+(\d+)\.(\d+)(?:\.(\d+))?(?:\s+\(([^)]*)\))?\s*(\S*)/);
  if (!m) return { type: H['Firmware type'] || '?', version: '?', major: 0, minor: 0, patch: 0, code: 0, target: '', raw };
  const major = +m[2], minor = +m[3], patch = +(m[4] || 0);
  return {
    type: m[1],
    version: `${major}.${minor}.${patch}`,
    major, minor, patch,
    code: major * 1e6 + minor * 1e3 + patch,
    target: m[6] || '',
    raw,
  };
}

export interface LoopTiming {
  /** период гироцикла, мкс (H looptime) */
  gyroLooptimeUs: number;
  pidDenom: number;
  /** частота PID-цикла, Гц */
  pidHz: number;
  /** логируется каждый N-й PID-цикл (может быть дробным для формата "1/2") */
  pInterval: number;
  /** частота логирования по заголовку, Гц */
  logHz: number;
  nyquistHz: number;
}

/**
 * Частота логирования = 1e6 / looptime / pid_process_denom / P interval.
 * "P interval" бывает "4" (BF ≥ 4.x) или "1/4" (старый формат: логируем 1 из 4).
 */
export function loopTiming(H: Record<string, string>): LoopTiming {
  const gyroLooptimeUs = Number(H['looptime'] || 125);
  const pidDenom = Number(H['pid_process_denom'] || 1) || 1;
  const pidHz = 1e6 / gyroLooptimeUs / pidDenom;
  let pInterval = 1;
  const pi = (H['P interval'] || '1').trim();
  if (pi.includes('/')) {
    const [a, b] = pi.split('/').map(Number);
    pInterval = b / (a || 1);
  } else pInterval = Number(pi) || 1;
  const logHz = pidHz / pInterval;
  return { gyroLooptimeUs, pidDenom, pidHz, pInterval, logHz, nyquistHz: logHz / 2 };
}

export const num = (H: Record<string, string>, key: string, def = 0): number => {
  const v = H[key];
  if (v === undefined || v === '') return def;
  const x = Number(v.split(',')[0]);
  return Number.isFinite(x) ? x : def;
};

export const nums = (H: Record<string, string>, key: string): number[] =>
  (H[key] || '').split(',').filter((s) => s !== '').map(Number);
