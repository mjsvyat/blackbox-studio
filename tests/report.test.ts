// Этап 8: отчёт HTML — самодостаточный, из снимка; с блоком сравнения.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../src/analysis/pipeline';
import { byThrottle } from '../src/analysis/health';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { reportHtml } from '../src/report/report';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

async function analysis(file: string, index: number) {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  return analyzeLog(buildContext(decodeLog(readRange(file, L.start, end - L.start))));
}

describe.skipIf(!hasFixture(SMALL_DUMP) || !hasFixture(BIG_DUMP))('отчёт и детали этапа 8', () => {
  it('отчёт по логу: все разделы, без «undefined», без внешних ссылок', async () => {
    const a = await analysis(BIG_DUMP, 3);
    const s = snapshotLog(a, adviseLog(a), { fileName: 'blackbox.txt', logIndex: 3 });
    const html = reportHtml(s, { 'spectrum.png': 'data:image/png;base64,AAAA' });
    for (const part of ['<!doctype html>', 'Светофор', 'Шумы', 'Фильтры', 'Отработка PID', 'Советы', 'R-FLT-DTERM-HOT-01', 'set simplified_dterm_filter_multiplier = 125', 'data:image/png']) expect(html).toContain(part);
    expect(html).not.toMatch(/undefined|NaN/);
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('отчёт сравнения: таблица было → стало', async () => {
    const a3 = await analysis(BIG_DUMP, 3), a5 = await analysis(BIG_DUMP, 5);
    const s3 = snapshotLog(a3, adviseLog(a3), { fileName: 'blackbox.txt', logIndex: 3 });
    const s5 = snapshotLog(a5, adviseLog(a5), { fileName: 'blackbox.txt', logIndex: 5 });
    const html = reportHtml(s5, {}, s3);
    expect(html).toContain('Сравнение: было → стало');
    expect(html).toContain('План не применён');
  });

  it('моторы и питание по газу: бины с данными, разброс моторов виден', async () => {
    const a = await analysis(BIG_DUMP, 3);
    const t = byThrottle(a.c, a.fm);
    expect(t.pct.length).toBe(10);
    expect(Math.abs(t.seconds.reduce((x, y) => x + y, 0) - a.fm.seconds)).toBeLessThan(2);
    const ok = t.motorCmd[0].map((_, b) => b).filter((b) => t.seconds[b] > 3);
    expect(ok.length).toBeGreaterThan(2);
    // напряжение на банку падает с газом
    const v = ok.map((b) => t.cellV![b]);
    expect(v[v.length - 1]).toBeLessThan(v[0]);
  });
});
