// «Что внутри файла»: поиск логов в дампе флешки, заворот адреса, дубли, стёртые
// области, быстрая оценка длительности каждого лога. Читает файл кусками через
// ByteReader — весь дамп в память не грузится. Порт идей bb-tools/struct.js.

import { LOG_START_MARKER } from './constants';
import { decodeLog } from './decoder';
import { FirmwareInfo, loopTiming, parseFirmware, parseHeader } from './header';

export interface ByteReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const MiB = 1024 * 1024;

export interface LogEntry {
  /** порядковый номер среди всех найденных маркеров */
  index: number;
  start: number;
  /** конец данных лога (следующий маркер, стёртая область или конец файла) */
  end: number;
  size: number;
  datetime: string;
  firmware: FirmwareInfo;
  board: string;
  craft: string;
  logHz: number;
  /** оценка длительности по первому и последнему кадру, с; null — не удалось */
  durationS: number | null;
  /** дубль другого лога (заворот адреса или повтор) — номер оригинала */
  duplicateOf: number | null;
  /** лог пересекает границу заворота: всё после wrapBoundary — мусор поверх старых данных */
  crossesWrap: boolean;
  wrapBoundary: number | null;
  /** доля потерянных байт в проверенных кусках (начало и конец), 0..1; null — не проверяли */
  damage: number | null;
  /** пустой лог (0000-01-01 или < 1 с) */
  empty: boolean;
  headerOk: boolean;
}

export interface Region {
  start: number;
  end: number;
}

export interface FileStructure {
  size: number;
  logs: LogEntry[];
  /** период повтора данных (заворот адреса флешки), байт; null — не обнаружен */
  wrapPeriod: number | null;
  /** доля совпавших блоков при проверке периода */
  wrapMatch: number;
  /** стёртые (0xFF) области крупнее 64 КиБ */
  erased: Region[];
  /** последний байт с данными (дальше только 0xFF) */
  dataEnd: number;
}

const enc = (s: string): Uint8Array => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};

function indexOfAll(hay: Uint8Array, needle: Uint8Array, from: number, to: number, out: number[], base: number): void {
  const n0 = needle[0];
  const nl = needle.length;
  for (let i = from; i <= to - nl; i++) {
    if (hay[i] !== n0) continue;
    let k = 1;
    while (k < nl && hay[i + k] === needle[k]) k++;
    if (k === nl) out.push(base + i);
  }
}

const CHUNK = 8 * MiB;
const ERASE_BLOCK = 64 * 1024;

export async function scanFile(r: ByteReader, onProgress?: (f: number, stage: string) => void): Promise<FileStructure> {
  const marker = enc(LOG_START_MARKER);
  const starts: number[] = [];
  const erasedBlocks: boolean[] = [];

  // 1) маркеры начала логов + карта стёртых блоков
  for (let off = 0; off < r.size; off += CHUNK) {
    const len = Math.min(CHUNK + marker.length - 1, r.size - off);
    const b = await r.read(off, len);
    indexOfAll(b, marker, 0, b.length, starts, off);
    const blockEnd = Math.min(CHUNK, b.length);
    for (let bo = 0; bo < blockEnd; bo += ERASE_BLOCK) {
      const z = Math.min(bo + ERASE_BLOCK, blockEnd);
      let allFF = true;
      for (let i = bo; i < z; i += 7) {
        if (b[i] !== 0xff) {
          allFF = false;
          break;
        }
      }
      erasedBlocks.push(allFF);
    }
    onProgress?.(Math.min(1, (off + CHUNK) / r.size) * 0.5, 'поиск логов');
  }
  const uniqStarts = [...new Set(starts)].sort((a, b) => a - b);

  const erased: Region[] = [];
  let dataEnd = 0;
  for (let i = 0; i < erasedBlocks.length; i++) {
    const a = i * ERASE_BLOCK;
    if (!erasedBlocks[i]) {
      dataEnd = Math.min(r.size, a + ERASE_BLOCK);
      continue;
    }
    const last = erased[erased.length - 1];
    if (last && last.end === a) last.end = Math.min(r.size, a + ERASE_BLOCK);
    else erased.push({ start: a, end: Math.min(r.size, a + ERASE_BLOCK) });
  }

  // 2) заворот адреса: данные повторяются с периодом 2^k МиБ (W25N01GV, BF ≤ 2026.6.1)
  let wrapPeriod: number | null = null;
  let wrapMatch = 0;
  for (const P of [8, 16, 32, 64, 128, 256].map((x) => x * MiB)) {
    if (r.size < P + MiB) continue;
    let same = 0, tot = 0;
    const step = Math.max(256 * 1024, Math.floor((r.size - P) / 48));
    for (let k = P; k + 4096 <= r.size; k += step) {
      const a = await r.read(k - P, 4096);
      const b = await r.read(k, 4096);
      let ff = true;
      for (let i = 0; i < 4096; i += 64) if (b[i] !== 0xff) { ff = false; break; }
      if (ff) continue;
      tot++;
      let eq = true;
      for (let i = 0; i < 4096; i++) if (a[i] !== b[i]) { eq = false; break; }
      if (eq) same++;
    }
    if (tot >= 3 && same / tot >= 0.9) {
      wrapPeriod = P;
      wrapMatch = same / tot;
      break;
    }
  }
  onProgress?.(0.6, 'проверка заворота');

  // 3) заголовки и границы логов
  const logs: LogEntry[] = [];
  const erasedStartAfter = (pos: number): number => {
    for (const e of erased) if (e.start >= pos) return e.start;
    return r.size;
  };
  for (let i = 0; i < uniqStarts.length; i++) {
    const s = uniqStarts[i];
    const nextMarker = i + 1 < uniqStarts.length ? uniqStarts[i + 1] : r.size;
    const end = Math.min(nextMarker, erasedStartAfter(s));
    const hb = await r.read(s, Math.min(64 * 1024, end - s));
    const { H, dataStart } = parseHeader(hb, 0);
    const headerOk = !!H['Field I name'] && dataStart < hb.length;
    const fw = parseFirmware(H);
    const timing = loopTiming(H);
    const entry: LogEntry = {
      index: i,
      start: s,
      end,
      size: end - s,
      datetime: H['Log start datetime'] || '',
      firmware: fw,
      board: H['Board information'] || '',
      craft: H['Craft name'] || '',
      logHz: timing.logHz,
      durationS: null,
      duplicateOf: null,
      damage: null,
      crossesWrap: false,
      wrapBoundary: null,
      empty: false,
      headerOk,
    };
    if (wrapPeriod !== null) {
      const boundary = Math.ceil((s + 1) / wrapPeriod) * wrapPeriod;
      if (s < boundary && end > boundary && s < wrapPeriod) {
        entry.crossesWrap = true;
        entry.wrapBoundary = boundary;
      }
    }
    logs.push(entry);
    onProgress?.(0.6 + (0.4 * (i + 1)) / Math.max(1, uniqStarts.length), 'разбор заголовков');
  }

  // 4) дубли: при завороте всё, что начинается за периодом, — копия лога на (start − P)
  for (const L of logs) {
    if (wrapPeriod !== null && L.start >= wrapPeriod) {
      const orig = logs.find((o) => o.start === L.start % wrapPeriod);
      if (orig) {
        L.duplicateOf = orig.index;
        continue;
      }
    }
    // без периода: одинаковые дата + размер + первые байты
    const same = logs.find((o) => o.index < L.index && o.duplicateOf === null && o.datetime === L.datetime && o.size === L.size && L.datetime !== '' && !L.datetime.startsWith('0000'));
    if (same) L.duplicateOf = same.index;
  }

  // 5) быстрая оценка длительности: первые 96 КиБ + последние 256 КиБ (до границы заворота)
  for (const L of logs) {
    if (!L.headerOk || L.duplicateOf !== null) continue;
    try {
      const realEnd = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
      const head = await r.read(L.start, Math.min(96 * 1024, realEnd - L.start));
      const hT = timeTracker();
      const hd = decodeLog(head, 0, head.length, { store: false, onFrame: hT.onFrame });
      let lost = hd.lostBytes, total = hd.dataBytes;
      let t1 = hT.last;
      if (realEnd - L.start > 96 * 1024) {
        // хвост приклеиваем к заголовку: декодер сам дождётся ближайшего I-кадра
        const { dataStart } = parseHeader(head, 0);
        const tailLen = Math.min(256 * 1024, realEnd - L.start);
        const tail = await r.read(realEnd - tailLen, tailLen);
        const joined = new Uint8Array(dataStart + tail.length);
        joined.set(head.subarray(0, dataStart), 0);
        joined.set(tail, dataStart);
        const tT = timeTracker();
        const td = decodeLog(joined, 0, joined.length, { store: false, onFrame: tT.onFrame });
        t1 = tT.last;
        // хвост начинается с середины кадра: байты до первого целого кадра — не потеря
        const lead = td.holes.length && td.holes[0].t0 === null ? td.holes[0].byteEnd - td.holes[0].byteStart : 0;
        lost += td.lostBytes - lead;
        total += td.dataBytes - lead;
      }
      L.damage = total > 0 ? lost / total : null;
      if (hT.first !== null && t1 !== null) {
        const d = ((t1 - hT.first) >>> 0) / 1e6;
        if (d >= 0 && d < 7200) L.durationS = d;
      }
    } catch {
      /* оценка не удалась — оставляем null */
    }
    // дата 0000-01-01 — просто нет часов (полётник без USB/GPS): по ней «пустой» только если
    // длительность не определить. Иначе такие полёты из чата Blackbox 2.0 выпадали из анализа.
    L.empty = L.durationS !== null ? L.durationS < 1 : L.datetime.startsWith('0000');
  }

  onProgress?.(1, 'готово');
  return { size: r.size, logs, wrapPeriod, wrapMatch, erased, dataEnd };
}

/** запоминает время (uint32, мкс) первого и последнего принятого кадра */
function timeTracker() {
  const tr = {
    first: null as number | null,
    last: null as number | null,
    onFrame: (_c: Int32Array, t: number): void => {
      if (tr.first === null) tr.first = t >>> 0;
      tr.last = t >>> 0;
    },
  };
  return tr;
}

/** ByteReader для браузера (File/Blob) */
export function blobReader(blob: Blob): ByteReader {
  return {
    size: blob.size,
    async read(offset, length) {
      const ab = await blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(ab);
    },
  };
}
