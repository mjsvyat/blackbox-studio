// Видео (D): разбор атомов MOV на синтетическом файле (генерируется здесь же), сдвиг по часам
// с часовым поясом, точный сдвиг по корреляции движения кадра с угловой скоростью.
import { describe, expect, it } from 'vitest';
import { codecMime, readMovMeta } from '../src/video/mov';
import { coarseOffset, fineOffset, logStartMs, rateMagnitude } from '../src/video/sync';

// --- генератор MOV ---
const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u64 = (v: number): number[] => [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...parts: number[][]): number[] => {
  const body = parts.flat();
  return [...u32(8 + body.length), ...str(type), ...body];
};
const T1904 = (iso: string): number => Date.parse(iso) / 1000 + 2082844800;

function mvhd(v: 0 | 1, created: number, ts: number, dur: number): number[] {
  const head = v === 1 ? [1, 0, 0, 0, ...u64(created), ...u64(created), ...u32(ts), ...u64(dur)] : [0, 0, 0, 0, ...u32(created), ...u32(created), ...u32(ts), ...u32(dur)];
  return box('mvhd', head, u32(0x00010000), u16(0x0100), new Array(10).fill(0), new Array(36).fill(0), new Array(24).fill(0), u32(3));
}
function trak(kind: 'vide' | 'soun', codec: string, ts: number, frames: number, delta: number, w = 0, h = 0): number[] {
  const tkhd = box('tkhd', [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0), u32(frames * delta), new Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), new Array(36).fill(0), u32(w * 65536), u32(h * 65536));
  const mdhd = box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(ts), u32(frames * delta), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', [0, 0, 0, 0], u32(0), str(kind), new Array(12).fill(0), [0]);
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box(codec, new Array(78).fill(0)));
  const stts = box('stts', [0, 0, 0, 0], u32(1), u32(frames), u32(delta));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stts))));
}
/** ftyp → mdat (большой, 64-битный размер) → moov в конце, как пишут камеры */
function mov(v: 0 | 1, created: string, durS: number, codec = 'hvc1'): { bytes: Uint8Array; moovSize: number } {
  const ftyp = box('ftyp', str('qt  '), u32(0), str('qt  '));
  const mdatPayload = 3_000_000;
  const mdatHdr = [...u32(1), ...str('mdat'), ...u64(16 + mdatPayload)];
  const moov = box('moov', mvhd(v, T1904(created), 1000, Math.round(durS * 1000)), trak('vide', codec, 30000, Math.round(durS * 29.97), 1001, 1920, 1080), trak('soun', 'mp4a', 48000, Math.round(durS * 46.875), 1024));
  const bytes = new Uint8Array(ftyp.length + mdatHdr.length + mdatPayload + moov.length);
  bytes.set(ftyp, 0);
  bytes.set(mdatHdr, ftyp.length);
  bytes.set(moov, ftyp.length + mdatHdr.length + mdatPayload);
  return { bytes, moovSize: moov.length };
}
function reader(b: Uint8Array) {
  const r = { size: b.length, bytesRead: 0, read: async (o: number, l: number) => { r.bytesRead += Math.min(l, b.length - o); return b.subarray(o, o + l); } };
  return r;
}

describe('метаданные MOV', () => {
  it('moov в конце, mdat с 64-битным размером: время, длительность, кодек, fps — без чтения mdat', async () => {
    const f = mov(0, '2026-09-06T11:12:30Z', 95.5);
    const r = reader(f.bytes);
    const m = await readMovMeta(r);
    expect(new Date(m.createdMs!).toISOString()).toBe('2026-09-06T11:12:30.000Z');
    expect(m.durationS).toBeCloseTo(95.5, 3);
    expect(m.brand).toBe('qt  ');
    expect(m.video).toMatchObject({ kind: 'video', codec: 'hvc1', width: 1920, height: 1080 });
    expect(m.video!.fps).toBeCloseTo(29.97, 2);
    expect(m.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(r.bytesRead).toBeLessThan(f.moovSize + 100); // mdat (3 МБ) не читался
    expect(codecMime('hvc1')).toContain('hvc1');
  });

  it('атомы версии 1 (64-битные времена)', async () => {
    const m = await readMovMeta(reader(mov(1, '2030-01-02T03:04:05Z', 12, 'avc1').bytes));
    expect(new Date(m.createdMs!).toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect(m.durationS).toBeCloseTo(12, 3);
    expect(m.video!.codec).toBe('avc1');
  });

  it('не MOV — понятная ошибка', async () => {
    await expect(readMovMeta(reader(new Uint8Array(box('ftyp', str('isom')).concat(box('free', [1, 2, 3])))))).rejects.toThrow(/moov/);
  });
});

describe('сдвиг времени', () => {
  it('часы не установлены — грубого сдвига нет', () => {
    expect(logStartMs('0000-01-01T00:00:00.000+00:00')).toBeNull();
    expect(coarseOffset(null, 60, Date.now(), 100).offsetS).toBeNull();
  });

  it('очки пишут местное время (+3 ч), полётник — UTC: сдвиг 3 ч найден, остаток — секунды', () => {
    const log = logStartMs('2026-09-06T08:10:05.000+00:00')!;
    const vid = Date.parse('2026-09-06T11:10:00Z'); // местное время, записанное как UTC
    const c = coarseOffset(log, 30, vid, 95);
    expect(c.tzHours).toBe(3);
    expect(c.offsetS).toBeCloseTo(5, 6);
    expect(c.overlap).toBe(1);
    // часы различаются на минуты — пояс 0, сдвиг как есть
    expect(coarseOffset(log, 30, log - 90_000, 300)).toMatchObject({ tzHours: 0, offsetS: 90 });
  });

  it('точный сдвиг по движению кадра: ±1 кадр при ошибке часов 2.6 с', () => {
    // «полёт»: угловая скорость со всплесками (флипы, рывки) 120 с, 50 Гц
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const hz = 50, N = 120 * hz;
    const t = Float64Array.from({ length: N }, (_, i) => i / hz);
    const g = [0, 1, 2].map(() => new Float32Array(N));
    for (let i = 0; i < N; i++) for (const a of g) a[i] = 30 * (rnd() - 0.5);
    for (let e = 0; e < 25; e++) {
      const c = Math.floor(rnd() * N), w = 10 + Math.floor(rnd() * 40), amp = 200 + 600 * rnd();
      for (let i = Math.max(0, c - w); i < Math.min(N, c + w); i++) g[e % 3][i] += amp * Math.exp(-(((i - c) / (w / 2)) ** 2));
    }
    const rate = rateMagnitude(g, N);
    // видео: 29.97 к/с, движение кадра ≈ √|ω| + шум, неравномерные метки времени
    const TRUE = 37.42;
    const vt: number[] = [], vv: number[] = [];
    for (let k = 0; k < 29.97 * 100; k++) {
      const tv = k / 29.97 + 0.002 * (rnd() - 0.5);
      const tl = tv - TRUE;
      const i = Math.round(tl * hz);
      if (i < 0 || i >= N) continue;
      vt.push(tv);
      vv.push(0.5 * Math.sqrt(rate[i]) + 1.5 * rnd());
    }
    const r = fineOffset(t, rate, vt, vv, TRUE + 2.6, 10)!;
    expect(Math.abs(r.offsetS - TRUE)).toBeLessThan(1 / 30);
    expect(r.margin).toBeGreaterThan(1.3);
    expect(r.score).toBeGreaterThan(0.5);
  });
});
