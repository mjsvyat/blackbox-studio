// Метаданные MOV/MP4 (очки DJI пишут MOV, H.264 или H.265) без загрузки файла в память:
// читаются только заголовки атомов верхнего уровня и атом moov целиком (обычно < 1–2 МБ).
// Формат — QuickTime File Format / ISO BMFF (ISO/IEC 14496-12):
//   атом = u32 размер (BE) + 4 символа типа; размер 1 → далее u64; 0 → до конца файла;
//   mvhd: v0 — u32 creation/modification (секунды с 1904-01-01 UTC), u32 timescale, u32 duration;
//         v1 — u64, u64, u32, u64;
//   tkhd: ... ширина/высота 16.16 в конце; mdhd — timescale/duration дорожки; hdlr — тип
//   (vide/soun); stsd — кодек (avc1/hvc1/hev1/mp4a); stts — длительности кадров (fps).
// (Порт bb-tools/movmeta.js из ТЗ: оригинала в репозитории нет — написано по спецификации.)

import type { ByteReader } from '../decoder/scan';

export interface MovTrack {
  kind: 'video' | 'audio' | 'other';
  codec: string;
  width: number;
  height: number;
  timescale: number;
  durationS: number;
  /** кадров в секунду (по stts), 0 — неизвестно */
  fps: number;
  frames: number;
}

export interface MovMeta {
  /** время создания из mvhd, мс Unix (как записано: у разных камер — UTC или местное); null — нет */
  createdMs: number | null;
  durationS: number;
  tracks: MovTrack[];
  video: MovTrack | null;
  brand: string;
}

/** секунд между 1904-01-01 и 1970-01-01 */
const EPOCH_1904 = 2082844800;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

class BE {
  constructor(private b: Uint8Array) {}
  u8(o: number): number {
    return this.b[o];
  }
  u16(o: number): number {
    return (this.b[o] << 8) | this.b[o + 1];
  }
  u32(o: number): number {
    return ((this.b[o] << 24) >>> 0) + (this.b[o + 1] << 16) + (this.b[o + 2] << 8) + this.b[o + 3];
  }
  u64(o: number): number {
    return this.u32(o) * 2 ** 32 + this.u32(o + 4);
  }
}

interface Box {
  type: string;
  /** начало содержимого */
  start: number;
  end: number;
}

/** атомы внутри [start, end) буфера */
function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  const r = new BE(b);
  let o = start;
  while (o + 8 <= end) {
    let size = r.u32(o);
    const type = fourcc(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      size = r.u64(o + 8);
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { type, start: o + hdr, end: o + size };
    o += size;
  }
}

function parseTrak(b: Uint8Array, box: Box): MovTrack {
  const r = new BE(b);
  const t: MovTrack = { kind: 'other', codec: '', width: 0, height: 0, timescale: 0, durationS: 0, fps: 0, frames: 0 };
  const walk = (bx: Box): void => {
    for (const c of boxes(b, bx.start, bx.end)) {
      if (CONTAINERS.has(c.type)) walk(c);
      else if (c.type === 'tkhd') {
        // ширина/высота — последние 8 байт tkhd (16.16), в обеих версиях
        t.width = r.u32(c.end - 8) / 65536;
        t.height = r.u32(c.end - 4) / 65536;
      } else if (c.type === 'mdhd') {
        const v = r.u8(c.start);
        t.timescale = v === 1 ? r.u32(c.start + 20) : r.u32(c.start + 12);
        const dur = v === 1 ? r.u64(c.start + 24) : r.u32(c.start + 16);
        t.durationS = t.timescale ? dur / t.timescale : 0;
      } else if (c.type === 'hdlr') {
        const h = fourcc(b, c.start + 8);
        t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : 'other';
      } else if (c.type === 'stsd') {
        // version/flags (4), entry_count (4), затем запись: size (4) + формат (4)
        if (c.start + 16 <= c.end) t.codec = fourcc(b, c.start + 12);
      } else if (c.type === 'stts') {
        const n = r.u32(c.start + 4);
        let frames = 0, ticks = 0;
        for (let i = 0; i < n && c.start + 8 + i * 8 + 8 <= c.end; i++) {
          const cnt = r.u32(c.start + 8 + i * 8);
          frames += cnt;
          ticks += cnt * r.u32(c.start + 12 + i * 8);
        }
        t.frames = frames;
        if (ticks && t.timescale) t.fps = (frames * t.timescale) / ticks;
      }
    }
  };
  walk(box);
  return t;
}

/** разобрать moov (буфер содержимого атома moov) */
export function parseMoov(moov: Uint8Array, brand = ''): MovMeta {
  const r = new BE(moov);
  const meta: MovMeta = { createdMs: null, durationS: 0, tracks: [], video: null, brand };
  for (const c of boxes(moov, 0, moov.length)) {
    if (c.type === 'mvhd') {
      const v = r.u8(c.start);
      const created = v === 1 ? r.u64(c.start + 4) : r.u32(c.start + 4);
      const ts = v === 1 ? r.u32(c.start + 20) : r.u32(c.start + 12);
      const dur = v === 1 ? r.u64(c.start + 24) : r.u32(c.start + 16);
      meta.createdMs = created ? (created - EPOCH_1904) * 1000 : null;
      meta.durationS = ts ? dur / ts : 0;
    } else if (c.type === 'trak') meta.tracks.push(parseTrak(moov, c));
  }
  meta.video = meta.tracks.find((t) => t.kind === 'video') ?? null;
  return meta;
}

/** метаданные файла: обход атомов верхнего уровня, moov — целиком (не больше maxMoov) */
export async function readMovMeta(r: ByteReader, maxMoov = 64 << 20): Promise<MovMeta> {
  let o = 0;
  let brand = '';
  while (o + 8 <= r.size) {
    const h = await r.read(o, 16);
    const be = new BE(h);
    let size = be.u32(0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1) {
      size = be.u64(8);
      hdr = 16;
    } else if (size === 0) size = r.size - o;
    if (size < hdr) throw new Error('битый атом');
    if (type === 'ftyp') brand = fourcc(await r.read(o + hdr, 4), 0);
    if (type === 'moov') {
      if (size - hdr > maxMoov) throw new Error('moov слишком большой');
      return parseMoov(await r.read(o + hdr, size - hdr), brand);
    }
    o += size;
  }
  throw new Error('нет атома moov — это не MOV/MP4 или файл обрезан');
}

/** ByteReader поверх File (браузер): читаются только запрошенные куски */
export function fileByteReader(f: Blob): ByteReader {
  return { size: f.size, read: async (o, l) => new Uint8Array(await f.slice(o, o + l).arrayBuffer()) };
}

/** строка codecs= для canPlayType по fourcc */
export function codecMime(codec: string): string {
  if (codec === 'hvc1' || codec === 'hev1') return `video/mp4; codecs="${codec}.1.6.L120.90"`;
  if (codec === 'avc1' || codec === 'avc3') return 'video/mp4; codecs="avc1.640028"';
  return 'video/mp4';
}
