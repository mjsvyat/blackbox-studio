// Прогон анализа на всех настоящих логах: печать метрик (для калибровки порогов)
// и проверки здравого смысла.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { buildFlightMask } from '../src/analysis/flightMask';
import { analyzeHealth } from '../src/analysis/health';
import { analyzeNoise } from '../src/analysis/noise';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const rows: string[] = [];
async function runFile(file: string) {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  for (const L of st.logs) {
    if (L.duplicateOf !== null || L.empty || !L.headerOk) continue;
    const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
    const log = decodeLog(readRange(file, L.start, end - L.start));
    const ctx = buildContext(log);
    const fm = buildFlightMask(ctx);
    const nz = analyzeNoise(ctx, fm);
    const h = analyzeHealth(ctx, fm);
    const f = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
    rows.push(`${file.endsWith('blackbox.txt') ? 'big' : 'small'}#${L.index} ${L.firmware.version} ${ctx.fs.toFixed(0)}Hz dur=${f(L.durationS)}s mask=${f(fm.seconds)}s seg=${nz.segments} motorHz=${f(nz.motorHzMedian, 0)}`);
    for (const a of nz.axes) {
      rows.push(`   ax${a.axis} unf=${f(a.rmsUnfilt, 2)} filt=${f(a.rmsFilt, 2)} red=${f(a.reductionDb)}dB D=${f(a.rmsDterm, 2)} peaks: ${a.peaks.slice(0, 4).map((p) => `${p.hz.toFixed(0)}Hz/${p.prominenceDb.toFixed(0)}dB/${p.kind}${p.harmonic ?? ''}(fcv ${f(p.freqCv, 2)} rcv ${f(p.ratioCv, 2)})`).join('  ')}`);
    }
    rows.push(`   motors sat=${f(h.motors.satPct, 2)}% allSat=${f(h.motors.allSatPct, 2)}% spread=${f(h.motors.spreadPct)}% heavy=${h.motors.heaviest} desync=${h.motors.desyncs} | power cells=${h.power.cells} minCell=${f(h.power.minCell, 2)} ripP99=${f(h.power.rippleP99, 2)} R=${f(h.power.resistanceMOhm)}mΩ maxA=${f(h.power.maxAmp, 0)} | rssi avg=${f(h.link.rssiAvgPct, 0)} low=${f(h.link.lowSharePct, 2)}% rxLoss=${h.link.rxLossCount} fs=${h.link.failsafeCount} | holes=${log.holes.length} lost=${f((100 * log.lostBytes) / log.dataBytes, 2)}% crashes=${fm.crashes.length} excl=${JSON.stringify(Object.fromEntries(Object.entries(fm.excluded).map(([k, v]) => [k, +v.toFixed(1)])))}`);
    expect(nz.axes.length).toBe(3);
    for (const a of nz.axes) expect(Number.isFinite(a.rmsFilt)).toBe(true);
  }
}

describe('метрики на реальных логах', () => {
  it.skipIf(!hasFixture(SMALL_DUMP))('маленький дамп', async () => { await runFile(SMALL_DUMP); });
  it.skipIf(!hasFixture(BIG_DUMP))('большой дамп (нужен Git LFS)', async () => { await runFile(BIG_DUMP); });
  it('печать', () => { console.log(rows.join('\n')); });
});
