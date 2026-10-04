// Большой дамп 132 МБ (4.5.2, заворот адреса на 64 МиБ). Читается кусками,
// без --max-old-space-size. Сверка всех уникальных логов с bbdec.js.
import { describe, expect, it } from 'vitest';
import { decodeLog } from '../src/decoder/decoder';
import { MiB, scanFile } from '../src/decoder/scan';
import { BIG_DUMP, fileReader, hasFixture, legacyDecoder, readRange } from './helpers';

const HAS = hasFixture(BIG_DUMP);

// смещения из bb-tools (найдены вручную) — утилита должна найти их сама
const LOGS = [
  [13692928, 23056384], [36749312, 7686144], [44435456, 5816320], [50251776, 5885952],
  [56137728, 23552], [56161280, 7816192], [63977472, 933888], [64911360, 15890432],
];

describe.skipIf(!HAS)('большой дамп с заворотом 64 МиБ (нужен Git LFS)', async () => {
  if (!HAS) return;
  const r = fileReader(BIG_DUMP);
  const t0 = Date.now();
  const fs = await scanFile(r);
  const scanMs = Date.now() - t0;
  r.close();
  const uniq = fs.logs.filter((l) => l.duplicateOf === null);

  it('находит период 64 МиБ и 8 уникальных логов', () => {
    expect(fs.wrapPeriod).toBe(64 * MiB);
    expect(fs.logs.length).toBe(16);
    expect(uniq.length).toBe(8);
    expect(uniq.map((l) => [l.start, l.size])).toEqual(LOGS);
    expect(scanMs).toBeLessThan(20000);
  });

  it('лог 7 пересекает границу заворота', () => {
    const l7 = uniq[7];
    expect(l7.crossesWrap).toBe(true);
    expect(l7.wrapBoundary).toBe(64 * MiB);
    expect(uniq.slice(0, 7).every((l) => !l.crossesWrap)).toBe(true);
  });

  it('лог 4 — пустой', () => {
    expect(uniq[4].empty).toBe(true);
  });

  for (const k of [0, 1, 2, 3, 5, 6, 7]) {
    it(`лог ${k}: совпадает с bbdec.js`, () => {
      const [s, len] = LOGS[k];
      const buf = readRange(BIG_DUMP, s, len);
      const legacy = legacyDecoder();
      let nRef = 0, hRef = 0;
      const ref = legacy.decodeLog(Buffer.from(buf.buffer, buf.byteOffset, buf.length), 0, buf.length, {
        decimate: 1e9,
        onFrame: (c: Int32Array) => {
          nRef++;
          for (let i = 1; i < c.length; i++) hRef = (Math.imul(hRef ^ c[i], 16777619) + i) >>> 0;
        },
      });
      let nMine = 0, hMine = 0;
      const mine = decodeLog(buf, 0, buf.length, {
        store: k !== 0, // самый длинный (670 с) проверяем без хранения колонок
        onFrame: (c) => {
          nMine++;
          for (let i = 1; i < c.length; i++) hMine = (Math.imul(hMine ^ c[i], 16777619) + i) >>> 0;
        },
      });
      expect(nMine).toBe(nRef);
      expect(hMine).toBe(hRef);
      expect(mine.frames.bad).toBe(ref.frames.bad);
      expect(mine.end).toBe(ref.end);
      if (uniq[k].durationS !== null && mine.time.length > 0 && k !== 7) {
        const full = (mine.time[mine.n - 1] - mine.time[0]) / 1e6;
        expect(Math.abs(full - uniq[k].durationS!)).toBeLessThan(0.5);
      }
    });
  }

  it('самый длинный лог (670 с, 1 кГц) с колонками укладывается в разумную память', () => {
    const [s, len] = LOGS[0];
    const before = process.memoryUsage().arrayBuffers;
    const mine = decodeLog(readRange(BIG_DUMP, s, len));
    let bytes = mine.time.byteLength;
    for (const c of mine.cols) bytes += c.byteLength;
    expect(mine.n).toBe(674038);
    expect(bytes / MiB).toBeLessThan(80);
    void before;
  });
});
