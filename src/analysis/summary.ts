// «Светофор»: 8 карточек со статусом и одной фразой. Пороги — config/analysis.json.

import cfg from '../config/analysis.json';
import { AXIS_NAMES, AXIS_NAMES_GEN, T } from '../i18n/ru';
import { LogContext } from './context';
import { FlightMask } from './flightMask';
import { HealthResult } from './health';
import { NoiseResult } from './noise';
import type { FilterBaseline } from '../filters/evaluate';
import { isBenchTest } from './bench';
import type { PidResult } from '../pid/analyze';

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

const capYellow = (s: Status): Status => (s === 'red' ? 'yellow' : s);

export function buildSummary(ctx: LogContext, fm: FlightMask, nz: NoiseResult, h: HealthResult, meta: LogMeta, fb: FilterBaseline | null = null, pid: PidResult | null = null): Card[] {
  const cards: Card[] = [];
  const enough = fm.seconds >= 3 && nz.segments >= 2;
  // тест моторов на столе: тяга, разброс, питание и PID не оцениваются (карточки серые)
  const bench = isBenchTest(ctx);

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
      // окно «ниже 100 Гц» (ролл, питч): узкий пик над трендом или широкий подъём 40–100 Гц
      const SB = N.sub100;
      const s100 = ax.slice(0, 2).map((a) => a.sub100);
      const lvl = (x: (typeof s100)[number]): number => (!x ? -Infinity : Math.max(x.bandDb, x.peakProm >= SB.narrowDb ? x.peakDb : -Infinity));
      const s100st = s100.map((x): Status => (!x ? 'grey' : lvl(x) >= SB.redDb ? 'red' : lvl(x) >= SB.warnDb ? 'yellow' : 'green'));
      if (s100.some(Boolean)) {
        metrics.push({ label: T.phrase.sub100Label, value: s100.map((x) => (x ? `${x.bandDb.toFixed(0)} дБ` : '—')).join(' · '), status: worst(...s100st.filter((s) => s !== 'grey')), help: 'noise-sub100' });
        status = worst(status, ...s100st.filter((s) => s !== 'grey'));
        const w = s100.map((x, i) => ({ x, i })).filter((o) => o.x && s100st[o.i] !== 'green').sort((a, b) => lvl(b.x) - lvl(a.x))[0];
        if (w) {
          const x = w.x!;
          const nar = x.peakProm >= SB.narrowDb && x.peakDb >= SB.warnDb;
          extra.unshift(T.phrase.sub100(AXIS_NAMES_GEN[w.i], nar ? x.peakHz : SB.bandFromHz, nar ? x.peakDb : x.bandDb, nar));
        }
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
      // Цвет карточки — про борт, а не про модель. Модель не сошлась (прошивка до 4.5 с другими
      // фильтрами, иной алгоритм) — это ограничение утилиты: серый «не оценить», а не красный.
      // Редкий лог и нет gyroUnfilt — исправимо записью лога: жёлтый. (Разбор чата Blackbox 2.0:
      // красный «модель не совпадает» был на 128 из 232 чужих логов, почти все — 4.3/4.4.)
      status = v.status === 'green' ? 'green' : v.reason === 'low-rate' || v.reason === 'no-unfilt' ? 'yellow' : 'grey';
      extra.push(v.status === 'green' ? T.phrase.filtersModelOk(worstMatch) : T.phrase.filtersModelBad(worstMatch, v.reason));
      metrics.push(
        { label: 'Задержка гиро на 50 / 100 / 150 Гц', value: `${fx(d.gyro['50'], 2)} / ${fx(d.gyro['100'], 2)} / ${fx(d.gyro['150'], 2)} мс`, help: 'filter-delay' },
        // PIDtoolbox пишет «Dterm Y мс» без гиро-цепочки — показываем обе цифры; ориентир чата ~2 мс для 5"
        { label: 'Задержка D-term на 100 Гц (из них D-фильтры)', value: `${fx(d.dterm['100'], 2)} (${fx(d.dterm['100'] - d.gyro['100'], 2)}) мс`, help: 'filter-delay' },
        { label: 'Подавление шума >80 Гц', value: fx(redAvg, 0, ' дБ'), help: 'metric-reduction' },
        { label: 'Модель совпадает с бортом', value: v.match.map((x) => fx(x, 0)).join(' / ') + ' %', status: v.status, help: 'filter-model' },
      );
    } else if (enough) {
      for (const a of nz.axes) metrics.push({ label: `${AXIS_NAMES[a.axis]}: подавление`, value: fx(a.reductionDb, 0, ' дБ'), help: 'metric-reduction' });
    }
    cards.push({ id: 'filters', title: T.card.filters, status, phrase, extra, metrics, help: 'card-filters', tab: 'filters' });
  }

  // --- отработка PID: step response по ролл/питч (яв — справочно) ---
  {
    const Pc = cfg.pid;
    let status: Status = 'grey';
    let phrase = T.phrase.noData;
    const extra: string[] = [];
    const metrics: CardMetric[] = [];
    if (pid && enough) {
      const rp = pid.axes.slice(0, 2);
      const ok = rp.filter((a) => a.enough && a.metrics);
      if (!ok.length) {
        phrase = T.phrase.pidNoData(Math.min(...rp.map((a) => a.step?.activeS ?? 0)), Pc.minActiveS);
      } else {
        const sOs = ok.map((a) => lowIsGood(a.metrics!.overshootPct, Pc.overshootPct));
        const sSt = ok.map((a) => highIsGood(a.metrics!.settle, Pc.settle));
        status = worst(...sOs, ...sSt);
        const wo = ok.reduce((b, a) => (a.metrics!.overshootPct > b.metrics!.overshootPct ? a : b));
        const ws = ok.reduce((b, a) => (a.metrics!.settle < b.metrics!.settle ? a : b));
        if (rank[lowIsGood(wo.metrics!.overshootPct, Pc.overshootPct)] >= 1) phrase = T.phrase.pidOvershoot(AXIS_NAMES_GEN[wo.axis], wo.metrics!.overshootPct);
        else if (rank[highIsGood(ws.metrics!.settle, Pc.settle)] >= 1) phrase = T.phrase.pidSag(AXIS_NAMES_GEN[ws.axis], ws.metrics!.settle);
        else phrase = T.phrase.pidOk(Math.max(...ok.map((a) => a.metrics!.overshootPct)));
        if (ok.length < rp.length) extra.push(T.phrase.pidPartial);
      }
      for (const a of pid.axes) {
        const m = a.metrics;
        metrics.push({
          label: T.phrase.pidMetric(AXIS_NAMES[a.axis]),
          value: m ? `${fx(m.overshootPct, 0)} % · ${fx(m.delayMs, 0)} мс · ${fx(m.settle, 2)}` : '—',
          status: m && a.enough && a.axis < 2 ? worst(lowIsGood(m.overshootPct, Pc.overshootPct), highIsGood(m.settle, Pc.settle)) : 'grey',
          help: 'pid-step',
        });
      }
      metrics.push({ label: T.phrase.pidTrack, value: pid.axes.map((a) => fx(a.trackRms, 0)).join(' / ') + ' °/с', help: 'pid-track' });
    }
    cards.push({ id: 'pid', title: T.card.pid, status, phrase, extra, metrics, help: 'card-pid', tab: 'pid' });
  }

  // --- feedforward: дрожь F от радиоканала и его доля в PID ---
  {
    let status: Status = 'grey';
    let phrase = T.phrase.noData;
    const metrics: CardMetric[] = [];
    if (pid && enough) {
      const rp = pid.axes.slice(0, 2).filter((a) => Number.isFinite(a.ffJitter));
      if (rp.length) {
        const w = rp.reduce((b, a) => (a.ffJitter > b.ffJitter ? a : b));
        status = lowIsGood(w.ffJitter, cfg.pid.ffJitter);
        phrase = status === 'green' ? T.phrase.ffOk : T.phrase.ffJitter(AXIS_NAMES_GEN[w.axis], w.ffJitter);
      }
      for (const a of pid.axes) {
        const c = a.contrib;
        const sum = [c.P, c.I, c.D, c.F].filter((x) => Number.isFinite(x)).reduce((s, x) => s + x, 0);
        metrics.push({ label: T.phrase.ffMetric(AXIS_NAMES[a.axis]), value: `${fx(a.ffJitter * 100, 0)} % · ${sum ? fx((c.F / sum) * 100, 0) : '—'} %`, status: a.axis < 2 ? lowIsGood(a.ffJitter, cfg.pid.ffJitter) : undefined, help: 'pid-ff-jitter' });
      }
    }
    cards.push({ id: 'ff', title: T.card.ff, status, phrase, extra: [], metrics, help: 'card-ff', tab: 'pid' });
  }

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
    const status = bench ? 'grey' : enough ? worst(sSat, sSpread === 'grey' ? 'green' : sSpread, sDesync, sClip) : 'grey';
    // фразы по убыванию серьёзности: первая — главная
    const found: { s: Status; text: string }[] = [];
    if (clips.length) found.push({ s: sClip, text: T.phrase.gyroClip(clips.length, clipMs) });
    if (m.desyncs) found.push({ s: sDesync, text: T.phrase.motorsDesync(m.desyncs) });
    if (rank[sSat] >= 1) found.push({ s: sSat, text: T.phrase.motorsSat(m.satPct) });
    if (rank[sSpread] >= 1 && m.heaviest !== null) found.push({ s: sSpread, text: T.phrase.motorsSpread(m.spreadPct!, m.heaviest) });
    found.sort((a, b) => rank[b.s] - rank[a.s]);
    const extra = found.map((f) => f.text);
    const phrase = bench ? T.phrase.bench : extra.shift() ?? (enough ? T.phrase.motorsOk(m.satPct) : T.phrase.noData);
    if (bench) extra.length = 0;
    cards.push({
      id: 'motors', title: T.card.motors, status, phrase, extra,
      metrics: [
        { label: 'В упоре (хоть один мотор)', value: fx(m.satPct, 1, ' %'), status: sSat, help: 'metric-motor-sat' },
        { label: 'Разброс на крейсере', value: fx(m.spreadPct, 0, ' %'), status: sSpread, help: 'metric-motor-spread' },
        { label: 'Десинки', value: String(m.desyncs), status: sDesync, help: 'metric-desync' },
        { label: 'Обороты на холостом ходу', value: m.idleRpm !== null && m.idleRpm !== undefined ? `${Math.round(m.idleRpm)} об/мин` : '—', help: 'setup-dyn-idle' },
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
    // сопротивление считается по датчику тока, который на многих бортах не откалиброван: не выше жёлтого
    const sR = capYellow(lowIsGood(p.resistanceMOhm, { green: P.resistanceMOhm.green * rScale, red: P.resistanceMOhm.red * rScale }));
    const status = enough && !bench ? worst(...[sCell, sRip, sR].filter((s) => s !== 'grey')) : 'grey';
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
    // RSSI в % у разных линков (ELRS, CRSF, LQ вместо RSSI) несопоставим: не выше жёлтого; красный — только failsafe
    const sLow = capYellow(lowIsGood(L.lowSharePct, cfg.link.lowShare));
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
        { label: 'Кадры I / P / битые', value: `${log.frames.I} / ${log.frames.P} / ${log.frames.bad}` },
        { label: 'Частота записи', value: `${ctx.timing.logHz.toFixed(0)} Гц`, help: 'nyquist' },
        { label: 'gyroUnfilt в логе', value: ctx.hasGyroUnfilt ? (ctx.unfiltFromDebug ? 'есть (debug GYRO_SCALED)' : 'есть') : 'нет', status: ctx.hasGyroUnfilt ? 'green' : 'yellow', help: 'gyro-unfilt' },
        { label: 'Конец лога', value: log.end === 'LOG_END' ? 'штатный' : 'обрезан' },
      ],
      help: 'card-integrity', tab: 'file',
    });
  }

  return cards;
}
