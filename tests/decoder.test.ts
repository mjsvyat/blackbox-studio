// Сверка TS-декодера с рабочим bb-tools/bbdec.js на маленьком дампе (2026.6.1, 2 кГц).
import { describe, expect, it } from 'vitest';
import { decodeLog } from '../src/decoder/decoder';
import { loopTiming } from '../src/decoder/header';
import { scanFile } from '../src/decoder/scan';
import { SMALL_DUMP, fileReader, hasFixture, legacyDecoder, readRange } from './helpers';

const HAS = hasFixture(SMALL_DUMP);

/** хеш всех полей кадра, кроме loopIteration (у нас predictor INC учитывает P interval) */
function frameHasher(skip: number) {
  const st = { n: 0, h: 0 >>> 0, times: [] as number[] };
  const fn = (cur: Int32Array, t: number) => {
    let h = st.h;
    for (let i = 0; i < cur.length; i++) {
      if (i === skip) continue;
      h = (Math.imul(h ^ cur[i], 16777619) + i) >>> 0;
    }
    st.h = h;
    st.n++;
    if (st.n % 997 === 0) st.times.push(t | 0);
  };
  return { st, fn };
}

describe.skipIf(!HAS)('маленький дамп 2026.6.1', async () => {
  if (!HAS) return;
  const r = fileReader(SMALL_DUMP);
  const fs = await scanFile(r);
  r.close();

  it('находит 5 логов без заворота и дублей', () => {
    expect(fs.logs.length).toBe(5);
    expect(fs.wrapPeriod).toBeNull();
    expect(fs.logs.map((l) => l.start)).toEqual([0, 20480, 262144, 346112, 1040384]);
    expect(fs.logs.every((l) => l.duplicateOf === null)).toBe(true);
    expect(fs.logs[0].firmware.version).toBe('2026.6.1');
  });

  it('частота логирования 2 кГц по заголовку', () => {
    const b = readRange(SMALL_DUMP, 0, 20480);
    const log = decodeLog(b);
    const t = loopTiming(log.header);
    expect(t.logHz).toBe(2000);
    expect(t.nyquistHz).toBe(1000);
  });

  for (let i = 0; i < 5; i++) {
    it(`лог ${i}: кадры и значения совпадают с bbdec.js`, () => {
      const L = fs.logs[i];
      const buf = readRange(SMALL_DUMP, L.start, L.size);
      const legacy = legacyDecoder();
      const a = frameHasher(0);
      const ref = legacy.decodeLog(Buffer.from(buf), 0, buf.length, { decimate: 1e9, onFrame: a.fn });
      const b = frameHasher(0);
      const mine = decodeLog(buf, 0, buf.length, { onFrame: b.fn });
      expect(mine.frames.I).toBe(ref.frames.I);
      expect(mine.frames.P).toBe(ref.frames.P);
      expect(mine.frames.bad).toBe(ref.frames.bad);
      expect(mine.frames.S).toBe(ref.frames.S);
      expect(mine.frames.G).toBe(ref.frames.G);
      expect(mine.end).toBe(ref.end);
      expect(b.st.n).toBe(a.st.n);
      expect(b.st.h).toBe(a.st.h);
      expect(b.st.times).toEqual(a.st.times);
      expect(mine.events.map((e) => e.name)).toEqual(ref.events.map((e: any) => e.name));
      // колонки = то, что отдавал onFrame
      expect(mine.n).toBe(a.st.n);
      const gi = mine.index['gyroADC[0]'];
      expect(mine.cols[gi].length).toBe(mine.n);
      // длительность из быстрой оценки сканера ≈ полной
      if (mine.n > 10 && L.durationS !== null) {
        const full = (mine.time[mine.n - 1] - mine.time[0]) / 1e6;
        expect(Math.abs(full - L.durationS)).toBeLessThan(0.05 + full * 0.01);
      }
    });
  }

  it('лог 3 (битый): дыры учтены, процент потерь посчитан', () => {
    const L = fs.logs[3];
    const buf = readRange(SMALL_DUMP, L.start, L.size);
    const mine = decodeLog(buf);
    expect(mine.frames.resync).toBeGreaterThan(100);
    expect(mine.holes.length).toBeGreaterThan(0);
    expect(mine.lostBytes).toBeGreaterThan(0);
    expect(mine.lostBytes).toBeLessThanOrEqual(mine.dataBytes);
  });

  it('loopIteration растёт на P interval (как в официальном декодере)', () => {
    const L = fs.logs[4];
    const mine = decodeLog(readRange(SMALL_DUMP, L.start, L.size));
    const it0 = mine.cols[mine.index['loopIteration']];
    let steps4 = 0;
    for (let k = 1; k < 2000; k++) if (it0[k] - it0[k - 1] === 4) steps4++;
    expect(steps4).toBeGreaterThan(1900);
  });
});

describe.skipIf(!HAS)('оценка повреждения в списке логов', async () => {
  if (!HAS) return;
  const r = fileReader(SMALL_DUMP);
  const st = await scanFile(r);
  r.close();
  it('битый лог 3 помечен, целые — нет', () => {
    expect(st.logs[3].damage!).toBeGreaterThan(0.5);
    for (const i of [1, 2, 4]) expect(st.logs[i].damage!).toBeLessThan(0.01);
  });
});

describe.skipIf(!HAS)('самопроверка гладкости на стыке I→P', () => {
  // Эталонный wasm-парсер blackbox-log 0.2.2 на логах 4.5.x даёт скачки ровно на первых
  // P-кадрах после I-кадра (неверная история для AVERAGE_2). Наш декодер — нет.
  // сравниваем 90-й перцентиль шага, а не среднее: в логе есть срывы до ±2000 °/с,
  // одиночные огромные шаги перекашивают среднее
  it('шаг gyroUnfilt/моторов/акселя после I-кадра такой же, как в остальных местах', () => {
    const L = { start: 1040384, size: 2129920 };
    const isI: boolean[] = [];
    const mine = decodeLog(readRange(SMALL_DUMP, L.start, L.size), 0, L.size, { onFrame: (_c, _t, _i, I) => { isI.push(I); } });
    for (const name of ['gyroUnfilt[0]', 'motor[1]', 'accSmooth[1]']) {
      const c = mine.cols[mine.index[name]];
      const after: number[] = [], other: number[] = [];
      for (let i = 2; i < mine.n; i++) {
        const d = Math.abs(c[i] - c[i - 1]);
        (isI[i - 1] || isI[i - 2] ? after : other).push(d);
      }
      const p90 = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
      expect(p90(after)).toBeLessThanOrEqual(p90(other) * 1.15 + 1);
    }
  });
});
