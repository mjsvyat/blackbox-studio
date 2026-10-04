// «Светофор»: 8 карточек со статусом и одной фразой. Пороги — config/analysis.json.

import cfg from '../config/analysis.json';
import { AXIS_NAMES, AXIS_NAMES_GEN, T } from '../i18n/ru';
import { LogContext } from './context';
import { FlightMask } from './flightMask';
import { HealthResult } from './health';
import { NoiseResult } from './noise';
import type { FilterBaseline } from '../filters/evaluate';

export type Status = 'green' | 'yellow' | 'red' | 'grey';

export interface CardMetric {
  label: string;
  value: string;
  status?: Status;
  help?: string;
}

export interface Card {
  id: 'noise' | 'filters' | 'pid' | 'ff' | 'motors' | 'power' | 'link' | 'integrity';
  title: string;
  status: Status;
  phrase: string;
  extra: string[];
  metrics: CardMetric[];
  help: string;
  tab: string;
}

export interface LogMeta {
  crossesWrap: boolean;
}

const rank: Record<Status, number> = { grey: -1, green: 0, yellow: 1, red: 2 };
const worst = (...s: Status[]): Status => s.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'green' as Status);

/** «меньше — лучше»: green < g ≤ yellow < r ≤ red */
export function lowIsGood(v: number | null | undefined, t: { green: number; red: number }): Status {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'grey';
  return v < t.green ? 'green' : v < t.red ? 'yellow' : 'red';
}
/** «больше — лучше» */
export function highIsGood(v: number | null | undefined, t: { green: number; red: number }): Status {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'grey';
  return v >= t.green ? 'green' : v > t.red ? 'yellow' : 'red';
}

const fx = (v: number | null | undefined, d: number, unit = ''): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`;

export function buildSummary(ctx: LogContext, fm: FlightMask, nz: NoiseResult, h: HealthResult, meta: LogMeta, fb: FilterBaseline | null = null): Card[] {
  const cards: Card[] = [];
  const enough = fm.seconds >= 3 && nz.segments >= 2;

  // --- шумы ---
  {
    const N = cfg.noise;
    let status: Status = 'grey';
    let phrase = T.phrase.noData;
    const extra: string[] = [];
    const metrics: CardMetric[] = [];
    if (enough) {
      const ax = nz.axes;
      const sFilt = ax.map((a) => lowIsGood(a.rmsFilt, N.filtRms));
      const sRaw = ax.map((a) => lowIsGood(a.rmsUnfilt, N.unfiltRms));
      status = worst(...sFilt, ...sRaw.filter((s) => s !== 'grey'));
      const wf = ax.reduce((b, a) => (a.rmsFilt > b.rmsFilt ? a : b));
      const wr = ax.reduce((b, a) => ((a.rmsUnfilt ?? 0) > (b.rmsUnfilt ?? 0) ? a : b));
      if (rank[sFilt[wf.axis]] >= 1) phrase = T.phrase.noiseHighFilt(AXIS_NAMES_GEN[wf.axis], wf.rmsFilt);
      else if (wr.rmsUnfilt !== null && rank[sRaw[wr.axis]] >= 1) phrase = T.phrase.noiseHighRaw(AXIS_NAMES_GEN[wr.axis], wr.rmsUnfilt);
      else phrase = T.phrase.noiseOk(AXIS_NAMES[wf.axis], wf.rmsFilt);
      // самый заметный пик
      const pk = ax.flatMap((a) => a.peaks.map((p) => ({ a: a.axis, p }))).sort((x, y) => y.p.prominenceDb - x.p.prominenceDb)[0];
      if (pk) {
        const an = AXIS_NAMES_GEN[pk.a];
        if (pk.p.kind === 'frame') extra.push(T.phrase.peakFrame(an, pk.p.bandLo, pk.p.bandHi));
        else if (pk.p.kind === 'motor') extra.push(T.phrase.peakMotor(an, pk.p.hz, pk.p.harmonic ?? 1));
        else extra.push(T.phrase.peakUnknown(an, pk.p.hz));
      }
      if (nz.bursts.length) extra.push(T.phrase.bursts(nz.bursts.length));
      if (nz.degraded) extra.push(T.phrase.degraded);
      ax.forEach((a) => {
        metrics.push({ label: `${AXIS_NAMES[a.axis]}: до / после`, value: `${fx(a.rmsUnfilt, 1)} / ${fx(a.rmsFilt, 2)} °/с`, status: worst(sFilt[a.axis], sRaw[a.axis] === 'grey' ? 'green' : sRaw[a.axis]), help: 'metric-noise-rms' });
      });
    }
    cards.push({ id: 'noise', title: T.card.noise, status, phrase, extra, metrics, help: 'card-noise', tab: 'noise' });
  }

  // --- фильтры: задержка цепочки и самопроверка модели ---
  {
    const red = nz.axes.map((a) => a.reductionDb).filter((x): x is number => x !== null && Number.isFinite(x));
    const redAvg = red.length ? red.reduce((s, x) => s + x, 0) / red.length : null;
    const metrics: CardMetric[] = [];
    let status: Status = 'grey';
    let phrase = !enough ? T.phrase.noData : redAvg !== null ? T.phrase.filtersInfo(redAvg) : T.phrase.filtersNoRaw;
    const extra: string[] = [];
    if (fb && enough) {
      const v = fb.validation;
      const d = fb.current.delay;
      phrase = T.phrase.filtersDelay(d.gyro['100'], d.dterm['100'], redAvg);
      const worstMatch = Math.min(...v.match.filter((x) => Number.isFinite(x)));
      // редкий лог — не проблема борта: жёлтый, а не красный
      status = v.reason === 'low-rate' && v.status === 'red' ? 'yellow' : v.status;
      extra.push(v.status === 'green' ? T.phrase.filtersModelOk(worstMatch) : T.phrase.filtersModelBad(worstMatch, v.reason));
      metrics.push(
        { label: 'Задержка гиро на 50 / 100 / 150 Гц', value: `${fx(d.gyro['50'], 2)} / ${fx(d.gyro['100'], 2)} / ${fx(d.gyro['150'], 2)} мс`, help: 'filter-delay' },
        { label: 'Задержка D-term на 100 Гц', value: fx(d.dterm['100'], 2, ' мс'), help: 'filter-delay' },
        { label: 'Подавление шума >80 Гц', value: fx(redAvg, 0, ' дБ'), help: 'metric-reduction' },
        { label: 'Модель совпадает с бортом', value: v.match.map((x) => fx(x, 0)).join(' / ') + ' %', status: v.status, help: 'filter-model' },
      );
    } else if (enough) {
      for (const a of nz.axes) metrics.push({ label: `${AXIS_NAMES[a.axis]}: подавление`, value: fx(a.reductionDb, 0, ' дБ'), help: 'metric-reduction' });
    }
    cards.push({ id: 'filters', title: T.card.filters, status, phrase, extra, metrics, help: 'card-filters', tab: 'filters' });
  }

  cards.push({ id: 'pid', title: T.card.pid, status: 'grey', phrase: T.phrase.pendingPid, extra: [], metrics: [], help: 'card-pid', tab: 'pid' });
  cards.push({ id: 'ff', title: T.card.ff, status: 'grey', phrase: T.phrase.pendingFf, extra: [], metrics: [], help: 'card-ff', tab: 'pid' });

  // --- моторы ---
  {
    const M = cfg.motors;
    const m = h.motors;
    const sSat = enough ? lowIsGood(m.satPct, M.saturationPct) : 'grey';
    const sSpread = lowIsGood(m.spreadPct, M.hoverSpreadPct);
    const clips = h.anomalies.filter((a) => a.kind === 'GYRO_CLIP');
    const clipMs = clips.reduce((s, a) => s + (a.value ?? 0), 0);
    const sDesync: Status = m.desyncs > 0 ? 'red' : 'green';
    const sClip: Status = clips.length ? 'red' : 'green';
    const status = enough ? worst(sSat, sSpread === 'grey' ? 'green' : sSpread, sDesync, sClip) : 'grey';
    // фразы по убыванию серьёзности: первая — главная
    const found: { s: Status; text: string }[] = [];
    if (clips.length) found.push({ s: sClip, text: T.phrase.gyroClip(clips.length, clipMs) });
    if (m.desyncs) found.push({ s: sDesync, text: T.phrase.motorsDesync(m.desyncs) });
    if (rank[sSat] >= 1) found.push({ s: sSat, text: T.phrase.motorsSat(m.satPct) });
    if (rank[sSpread] >= 1 && m.heaviest !== null) found.push({ s: sSpread, text: T.phrase.motorsSpread(m.spreadPct!, m.heaviest) });
    found.sort((a, b) => rank[b.s] - rank[a.s]);
    const extra = found.map((f) => f.text);
    const phrase = extra.shift() ?? (enough ? T.phrase.motorsOk(m.satPct) : T.phrase.noData);
    cards.push({
      id: 'motors', title: T.card.motors, status, phrase, extra,
      metrics: [
        { label: 'В упоре (хоть один мотор)', value: fx(m.satPct, 1, ' %'), status: sSat, help: 'metric-motor-sat' },
        { label: 'Разброс на крейсере', value: fx(m.spreadPct, 0, ' %'), status: sSpread, help: 'metric-motor-spread' },
        { label: 'Десинки', value: String(m.desyncs), status: sDesync, help: 'metric-desync' },
        { label: 'Упор гироскопа', value: clips.length ? `${clips.length} / ${clipMs.toFixed(0)} мс` : '0', status: sClip, help: 'metric-gyro-clip' },
      ],
      help: 'card-motors', tab: 'motors',
    });
  }

  // --- питание ---
  {
    const P = cfg.power;
    const p = h.power;
    const sCell = highIsGood(p.minCell, P.minCellUnderLoad);
    // пороги пульсаций и сопротивления заданы для 6S — масштабируем по числу банок
    const rScale = p.cells ? p.cells / 6 : 1;
    const sRip = lowIsGood(p.rippleP99, { green: P.rippleP99.green * rScale, red: P.rippleP99.red * rScale });
    const sR = lowIsGood(p.resistanceMOhm, { green: P.resistanceMOhm.green * rScale, red: P.resistanceMOhm.red * rScale });
    const status = enough ? worst(...[sCell, sRip, sR].filter((s) => s !== 'grey')) : 'grey';
    const extra: string[] = [];
    if (rank[sCell] >= 1) extra.push(T.phrase.powerSag(p.minCell!));
    if (rank[sRip] >= 1) extra.push(T.phrase.powerRipple(p.rippleP99!));
    if (rank[sR] >= 1) extra.push(T.phrase.powerR(p.resistanceMOhm!));
    if (p.currentClipA !== null) extra.push(T.phrase.currentClip(p.currentClipA));
    const phrase = extra.shift() ?? (enough && p.minCell !== null ? T.phrase.powerOk(p.minCell) : T.phrase.noData);
    cards.push({
      id: 'power', title: T.card.power, status, phrase, extra,
      metrics: [
        { label: 'Банок', value: p.cells ? `${p.cells}S` : '—' },
        { label: 'Мин. на банку под нагрузкой', value: fx(p.minCell, 2, ' В'), status: sCell, help: 'metric-min-cell' },
        { label: 'Пульсации (p99, 20 мс)', value: fx(p.rippleP99, 2, ' В'), status: sRip, help: 'metric-ripple' },
        { label: 'Сопротивление пакет+проводка', value: fx(p.resistanceMOhm, 0, ' мОм'), status: sR, help: 'metric-resistance' },
        { label: 'Макс. ток', value: p.currentClipA !== null ? `≥ ${fx(p.maxAmp, 0)} А (упор датчика)` : fx(p.maxAmp, 0, ' А'), help: 'metric-current-clip' },
      ],
      help: 'card-power', tab: 'motors',
    });
  }

  // --- связь ---
  {
    const L = h.link;
    const sLow = lowIsGood(L.lowSharePct, cfg.link.lowShare);
    const sLoss: Status = L.failsafeCount ? 'red' : L.rxLossCount ? 'yellow' : 'green';
    const status = worst(sLow === 'grey' ? 'green' : sLow, sLoss);
    const parts: string[] = [];
    if (L.failsafeCount) parts.push(T.phrase.linkFs(L.failsafeCount));
    if (L.rxLossCount) parts.push(T.phrase.linkLoss(L.rxLossCount));
    if (rank[sLow] >= 1) parts.push(T.phrase.linkLow(L.lowSharePct!));
    if (!L.hasRssi) parts.push(T.phrase.linkNoRssi);
    cards.push({
      id: 'link', title: T.card.link, status, phrase: parts.shift() ?? T.phrase.linkOk, extra: parts,
      metrics: [
        { label: 'RSSI средний / минимум', value: L.hasRssi ? `${fx(L.rssiAvgPct, 0)} / ${fx(L.rssiMinPct, 0)} %` : '—', help: 'metric-rssi' },
        { label: `Время с RSSI < ${cfg.link.rssiLowPct} %`, value: fx(L.lowSharePct, 1, ' %'), status: sLow },
        { label: 'Потери сигнала / failsafe', value: `${L.rxLossCount} / ${L.failsafeCount}`, status: sLoss },
      ],
      help: 'card-link', tab: 'flight',
    });
  }

  // --- целостность ---
  {
    const log = ctx.log;
    const lostPct = log.dataBytes ? (100 * log.lostBytes) / log.dataBytes : 0;
    const sLost = lowIsGood(lostPct, cfg.integrity.lostPct);
    const parts: string[] = [];
    if (rank[sLost] >= 1 || log.holes.length) parts.push(T.phrase.integrityLost(lostPct, log.holes.length));
    if (meta.crossesWrap) parts.push(T.phrase.integrityWrap);
    if (log.repairedHeader) parts.push(T.phrase.integrityHeader);
    if (!ctx.hasGyroUnfilt) parts.push(T.phrase.degraded);
    for (const w of ctx.warnings) parts.push(T.phrase.integrityRate(w));
    const status = worst(sLost, meta.crossesWrap ? 'yellow' : 'green', ctx.hasGyroUnfilt ? 'green' : 'yellow', ctx.warnings.length ? 'yellow' : 'green');
    cards.push({
      id: 'integrity', title: T.card.integrity, status, phrase: parts.shift() ?? T.phrase.integrityOk, extra: parts,
      metrics: [
        { label: 'Потеряно данных', value: `${lostPct.toFixed(2)} %`, status: sLost, help: 'metric-lost' },
        { label: 'Кадров I / P / битых', value: `${log.frames.I} / ${log.frames.P} / ${log.frames.bad}` },
        { label: 'Частота логирования', value: `${ctx.timing.logHz.toFixed(0)} Гц (Найквист ${ctx.timing.nyquistHz.toFixed(0)} Гц)`, help: 'nyquist' },
        { label: 'gyroUnfilt в логе', value: ctx.hasGyroUnfilt ? 'есть' : 'нет', status: ctx.hasGyroUnfilt ? 'green' : 'yellow', help: 'gyro-unfilt' },
        { label: 'Конец лога', value: log.end === 'LOG_END' ? 'штатный' : 'обрезан' },
      ],
      help: 'card-integrity', tab: 'file',
    });
  }

  return cards;
}
