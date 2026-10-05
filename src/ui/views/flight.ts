// «Полёт и события»: обзор с маской, графики гиро/setpoint, моторы, питание,
// таблица событий (клик → зум всех графиков).

import { AXIS_NAMES, T } from '../../i18n/ru';
import { TimeChart, zoomTo } from '../charts/timechart';
import { lineChart } from '../charts/line';
import { fmt, fmtTime, h } from '../dom';
import { helpBtn } from '../help';
import { set, setAnalysisRange, state } from '../store';
import { seekLog, videoPanel } from '../video';

export function overviewChart(): TimeChart {
  return new TimeChart({
    title: T.flight.overview,
    help: 'chart-overview',
    overview: true,
    height: 110,
    yRange: [0, 100],
    series: [{ key: 'thr', label: T.flight.sThr, color: '--fg2' }],
  });
}

export function rangeControls(): HTMLElement {
  const an = state.analysis;
  return h('div', { class: 'row small', style: 'margin:-4px 0 10px' },
    h('span', { class: 'muted' }, T.flight.selectHint),
    h('span', { style: 'flex:1' }),
    an?.range ? h('b', null, T.flight.rangeSet(an.range.t0, an.range.t1)) : null,
    an?.range ? h('button', { class: 'btn small', onclick: () => setAnalysisRange(null) }, T.flight.resetRange) : null,
    h('button', { class: 'btn small', onclick: () => state.info && set({ view: { t0: 0, t1: state.info.durationS } }) }, T.flight.resetZoom));
}

export function flightView(track: (d: () => void) => void): HTMLElement {
  const info = state.info, an = state.analysis;
  if (!info || !an) return h('div');
  const charts: TimeChart[] = [overviewChart()];
  for (let a = 0; a < 3; a++) {
    charts.push(new TimeChart({
      title: T.flight.gyro(AXIS_NAMES[a]),
      help: 'chart-gyro-time',
      height: 170,
      series: [
        { key: `sp${a}`, label: T.flight.sSetpoint, color: '--s2', width: 1.2 },
        { key: `gyro${a}`, label: T.flight.sGyro, color: '--s1', width: 1 },
      ],
    }));
  }
  charts.push(new TimeChart({
    title: T.flight.motors, help: 'chart-motors-time', height: 170, yRange: [0, 100],
    series: Array.from({ length: info.motorCount }, (_, i) => ({ key: `m${i}`, label: `М${i + 1}`, color: ['--s1', '--s2', '--s3', '--s4', '--s5', '--fg2', '--fg3', '--red'][i] })),
  }));
  charts.push(new TimeChart({
    title: T.flight.power, help: 'chart-power-time', height: 150,
    series: [{ key: 'vbat', label: T.flight.sVbat, color: '--s3' }, { key: 'amp', label: T.flight.sAmp, color: '--s5', scale: 'amp' }],
    scales: { amp: {} },
  }));
  const hasRssi = an.health.link.hasRssi;
  if (hasRssi) charts.push(new TimeChart({ title: T.link.rssi, help: 'metric-rssi', height: 120, yRange: [0, 100], series: [{ key: 'rssi', label: 'RSSI', color: '--s4' }] }));
  charts.forEach((c) => track(() => c.destroy()));

  // полоса режимов: цвет по набору режимов, клик — зум
  const dur = info.durationS || 1;
  const modeColor = (m: string[], fsPh: string, rx: boolean): string => (!rx || fsPh !== 'IDLE' ? 'var(--red)' : m.some((x) => ['ANGLE', 'HORIZON', 'HEADFREE', 'GPSRESCUE'].includes(x)) ? 'var(--yellow)' : m.includes('ARM') ? 'var(--green)' : 'var(--grey)');
  const strip = h('div', { style: 'display:flex;height:22px;border-radius:4px;overflow:hidden;border:1px solid var(--line)' },
    info.modes.map((md) => h('div', {
      title: `${fmtTime(md.t0)}–${fmtTime(md.t1)}: ${md.modes.join(' + ') || '—'}${md.failsafe !== 'IDLE' ? ` · failsafe ${md.failsafe}` : ''}${md.rxOk ? '' : ' · нет сигнала'}`,
      style: `width:${Math.max(0.15, ((md.t1 - md.t0) / dur) * 100)}%;background:${modeColor(md.modes, md.failsafe, md.rxOk)};opacity:.75;cursor:pointer`,
      onclick: () => zoomTo((md.t0 + md.t1) / 2, Math.max(1.5, (md.t1 - md.t0) / 2)),
    })));
  const L = an.health.link;
  const linkBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.link.title, helpBtn('card-link')),
    hasRssi ? h('div', null, T.link.stats(fmt(L.rssiAvgPct, 0), fmt(L.rssiMinPct, 0), fmt(L.lowSharePct, 1), L.rxLossCount, L.failsafeCount)) : h('div', { class: 'muted' }, T.link.noRssi),
    hasRssi ? charts[charts.length - 1].el : null);

  // события: записанные в лог + найденные аномалии
  const rows: { t: number; what: string; kind: string }[] = [
    ...info.events.filter((e) => e.name !== 'LOG_END').map((e) => ({ t: e.t, what: `${e.name}${e.detail ? ': ' + e.detail : ''}`, kind: 'event' })),
    ...an.anomalies.map((x) => ({ t: x.t0, what: x.text + (x.t1 > x.t0 + 0.05 ? ` (${fmt(x.t1 - x.t0, 2)} с)` : ''), kind: x.kind })),
    ...info.holes.map(([a, b]) => ({ t: a ?? 0, what: `Битые данные ${fmt(a ?? 0, 2)}–${b === null ? 'конец' : fmt(b, 2)} с`, kind: 'hole' })),
  ].sort((x, y) => x.t - y.t);

  const events = h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, T.flight.events),
    rows.length
      ? h('table', { class: 'grid' },
          h('thead', null, h('tr', null, h('th', null, T.flight.evTime), h('th', null, T.flight.evWhat))),
          h('tbody', null, rows.map((r) => h('tr', { class: 'click', onclick: () => { zoomTo(r.t); seekLog(r.t); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
            h('td', null, fmtTime(r.t)),
            h('td', null, h('span', { class: `badge ${['GYRO_CLIP', 'MOTOR_DESYNC', 'FAILSAFE', 'hole'].includes(r.kind) ? 'red' : r.kind === 'event' ? '' : 'yellow'}` }, r.kind === 'event' ? 'лог' : r.kind === 'hole' ? 'данные' : 'аномалия'), r.what)))))
      : h('div', { class: 'muted' }, T.flight.noEvents));

  return h('div', null,
    h('h2', null, T.flight.title),
    charts[0].el,
    rangeControls(),
    videoPanel(),
    h('div', { class: 'panel' }, h('b', { class: 'small' }, T.link.modes, ' '), h('span', { class: 'muted small' }, T.link.modesNote), strip),
    charts.slice(1, 4).map((c) => c.el),
    h('div', { class: 'two' }, charts[4].el, charts[5].el),
    linkBox,
    events,
    h('div', { class: 'muted small' }, helpBtn('flight-mask'), ' ', T.summary.flightTime, ': ', fmtTime(an.maskSeconds)),
  );
}

export function motorsView(track: (d: () => void) => void): HTMLElement {
  const info = state.info, an = state.analysis;
  if (!info || !an) return h('div');
  const charts: TimeChart[] = [overviewChart()];
  charts.push(new TimeChart({
    title: T.flight.motors, help: 'chart-motors-time', height: 200, yRange: [0, 100],
    series: Array.from({ length: info.motorCount }, (_, i) => ({ key: `m${i}`, label: `М${i + 1}`, color: ['--s1', '--s2', '--s3', '--s4'][i % 4] })),
  }));
  if (info.hasErpm) {
    charts.push(new TimeChart({
      title: 'Обороты моторов, Гц', help: 'card-motors', height: 180,
      series: Array.from({ length: info.motorCount }, (_, i) => ({ key: `mhz${i}`, label: `М${i + 1}`, color: ['--s1', '--s2', '--s3', '--s4'][i % 4] })),
    }));
  }
  charts.push(new TimeChart({
    title: T.flight.power, help: 'chart-power-time', height: 180,
    series: [{ key: 'vbat', label: T.flight.sVbat, color: '--s3' }, { key: 'amp', label: T.flight.sAmp, color: '--s5', scale: 'amp' }],
    scales: { amp: {} },
  }));
  charts.forEach((c) => track(() => c.destroy()));
  const cardsBox = h('div', { class: 'cards' }, an.cards.filter((c) => c.id === 'motors' || c.id === 'power').map((c) =>
    h('div', { class: `card ${c.status}` },
      h('div', { class: 'head' }, h('span', { class: `dot ${c.status}` }), h('span', { class: 'title' }, c.title), helpBtn(c.help)),
      h('div', { class: 'phrase' }, c.phrase), c.extra.map((e) => h('div', { class: 'extra' }, e)),
      h('div', { class: 'metrics' }, c.metrics.map((m) => h('div', { class: 'm' }, m.status ? h('span', { class: `dot ${m.status}` }) : h('span', { class: 'dot', style: 'visibility:hidden' }), h('span', { class: 'l' }, m.label), h('b', null, m.value), helpBtn(m.help)))))));
  const th = an.health.thr;
  const colors = ['--s1', '--s2', '--s3', '--s4', '--s5', '--fg2', '--fg3', '--red'];
  const extra: HTMLElement[] = [];
  const thrLines = (title: string, help: string, data: number[][], note?: string): void => {
    const ch = lineChart({ title, help, x: th.pct, height: 220, lines: data.map((d, i) => ({ label: `М${i + 1}`, color: colors[i % colors.length], data: d, width: 1.6 })), note });
    track(ch.destroy);
    extra.push(ch.el);
  };
  thrLines(T.mp.motorsByThr, 'metric-motor-spread', th.motorCmd, T.mp.motorsNote);
  if (th.motorHz) thrLines(T.mp.motorsHzByThr, 'card-motors', th.motorHz);
  if (th.cellV || th.amp) {
    const ch = lineChart({ title: T.mp.powerByThr, help: 'metric-resistance', x: th.pct, height: 200, lines: [
      { label: T.mp.cellV, color: '--s3', data: th.cellV, width: 1.8 },
    ], note: T.mp.powerNote });
    track(ch.destroy);
    extra.push(ch.el);
    if (th.amp) {
      const ca = lineChart({ title: `${T.mp.powerByThr}: ${T.mp.amp}`, help: 'metric-current-clip', x: th.pct, height: 160, lines: [{ label: T.mp.amp, color: '--s5', data: th.amp, width: 1.8 }] });
      track(ca.destroy);
      extra.push(ca.el);
    }
  }
  const evs = an.anomalies.filter((x) => ['MOTOR_DESYNC', 'ALL_MOTORS_SAT', 'MOTOR_SAT', 'VBAT_DIP', 'GYRO_CLIP'].includes(x.kind));
  const evBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.mp.eventsTitle),
    evs.length ? h('table', { class: 'grid small' }, h('tbody', null, evs.map((x) => h('tr', { class: 'click', onclick: () => { zoomTo(x.t0); seekLog(x.t0); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      h('td', null, fmtTime(x.t0)), h('td', null, h('span', { class: `badge ${x.kind === 'VBAT_DIP' ? 'yellow' : 'red'}` }, x.kind), ' ', x.text)))))
      : h('div', { class: 'muted' }, T.mp.noEvents));
  return h('div', null, h('h2', null, T.tabs.motors), cardsBox, h('div', { style: 'height:12px' }), charts[0].el, rangeControls(), charts.slice(1).map((c) => c.el),
    h('div', { class: 'two' }, ...extra.slice(0, 2)), h('div', { class: 'two' }, ...extra.slice(2)), evBox);
}
