// Вкладка «PID / step»: step response по осям с полосой разброса, цифры, трекинг,
// вклад P/I/D/F, PID и слайдеры Simplified из заголовка.

import cfg from '../../config/analysis.json';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { lineChart } from '../charts/line';
import { fmt, h } from '../dom';
import { helpBtn } from '../help';
import { ensurePid, state } from '../store';

export function pidView(track: (d: () => void) => void): HTMLElement {
  const P = state.pid;
  if (!P) {
    ensurePid();
    return h('div', null, h('h2', null, T.pid.title, helpBtn('card-pid')), h('div', { class: 'panel muted' }, T.pid.loading));
  }
  const C = cfg.pid;
  const colors = ['--s1', '--s2', '--s4'];
  const anyStep = P.axes.find((a) => a.step);
  const out = h('div', null, h('h2', null, T.pid.title, helpBtn('card-pid')));
  out.append(h('div', { class: 'muted small', style: 'margin-bottom:8px' }, T.pid.excluded(P.satS, P.seconds)));
  if (P.axes.slice(0, 2).some((a) => !a.enough)) out.append(h('div', { class: 'panel warn' }, T.pid.lowData, ' ', helpBtn('test-flight')));

  if (anyStep?.step) {
    const t = Float32Array.from(anyStep.step.t, (v) => v * 1000);
    const lines = P.axes.filter((a) => a.step).map((a) => ({ label: `${T.pid.lAxis(AXIS_NAMES[a.axis])}${a.enough ? '' : ' (?)'}`, color: colors[a.axis], data: a.step!.mean, width: a.enough ? 2 : 1.2, dash: a.enough ? undefined : [5, 4] }));
    const bands = P.axes.filter((a) => a.step && a.enough).map((a) => ({
      lower: Float32Array.from(a.step!.mean, (m, i) => m - (a.step!.std[i] || 0)),
      upper: Float32Array.from(a.step!.mean, (m, i) => m + (a.step!.std[i] || 0)),
      color: colors[a.axis],
    }));
    const ch = lineChart({ title: T.pid.stepTitle, help: 'pid-step', x: t, lines, bands, height: 320, yRange: [0, 1.6], hline: { y: 1, label: '1.0', color: '--fg3' }, note: T.pid.stepNote });
    track(ch.destroy);
    out.append(ch.el);
  }

  const st = (v: number, g: { green: number; red: number }, high = false): string => {
    if (!Number.isFinite(v)) return '';
    const s = high ? (v >= g.green ? 'green' : v > g.red ? 'yellow' : 'red') : (v < g.green ? 'green' : v < g.red ? 'yellow' : 'red');
    return `dot ${s}`;
  };
  out.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.metricsTitle, helpBtn('pid-step')),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ...Object.values(T.pid.col).map((c) => h('th', null, c)))),
      h('tbody', null, P.axes.map((a) => {
        const m = a.metrics;
        const trust = a.enough ? T.pid.trustOk : (a.step?.activeS ?? 0) < C.minActiveS ? T.pid.trustLow(a.step?.activeS ?? 0, C.minActiveS) : T.pid.trustSpread;
        return h('tr', null, h('td', null, AXIS_NAMES[a.axis]),
          h('td', null, m && a.axis < 2 && a.enough ? h('span', { class: st(m.overshootPct, C.overshootPct) }) : null, ' ', m ? `${fmt(m.overshootPct, 0)} %` : '—'),
          h('td', null, m ? `${fmt(m.delayMs, 0)} мс` : '—'),
          h('td', null, m ? `${fmt(m.riseMs, 0)} мс` : '—'),
          h('td', null, m && a.axis < 2 && a.enough ? h('span', { class: st(m.settle, C.settle, true) }) : null, ' ', m ? fmt(m.settle, 2) : '—'),
          h('td', null, a.step ? fmt(a.step.activeS, 0) : '—'),
          h('td', null, h('span', { class: a.enough ? '' : 'badge yellow' }, trust)));
      })))));

  out.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.trackTitle, helpBtn('pid-track')),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, T.pid.col.axis), h('th', null, T.pid.colTrack), h('th', null, T.pid.colSp), h('th', null, T.pid.colContrib), h('th', null, T.pid.colJitter, helpBtn('pid-ff-jitter')))),
      h('tbody', null, P.axes.map((a) => h('tr', null, h('td', null, AXIS_NAMES[a.axis]), h('td', null, fmt(a.trackRms, 1)), h('td', null, fmt(a.spRms, 0)),
        h('td', null, [a.contrib.P, a.contrib.I, a.contrib.D, a.contrib.F].map((x) => fmt(x, 1)).join(' / ')),
        h('td', null, Number.isFinite(a.ffJitter) ? `${fmt(a.ffJitter * 100, 0)} %` : '—')))))));

  const g = P.gains;
  const dx = g.dExtraKind === 'd_max' ? 'D max' : g.dExtraKind === 'd_min' ? 'D min' : null;
  const gainsBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.gainsTitle, helpBtn('pid-gains')),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, T.pid.col.axis), h('th', null, 'P'), h('th', null, 'I'), h('th', null, 'D'), dx ? h('th', null, dx) : null, h('th', null, 'F'))),
      h('tbody', null, [0, 1, 2].map((a) => h('tr', null, h('td', null, AXIS_NAMES[a]), h('td', null, fmt(g.P[a], 0)), h('td', null, fmt(g.I[a], 0)), h('td', null, fmt(g.D[a], 0)), dx ? h('td', null, fmt(g.dExtra?.[a], 0)) : null, h('td', null, fmt(g.F[a], 0)))))));
  const sp = P.simplified;
  const simBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.simTitle, helpBtn('pid-simplified')),
    !sp || sp.s.mode === 0 ? h('div', { class: 'muted' }, T.pid.simOff)
      : h('table', { class: 'grid' }, h('tbody', null, Object.entries(T.pid.simNames).map(([k, label]) => h('tr', null, h('td', null, label), h('td', null, fmt((sp.s as unknown as Record<string, number>)[k] / 100, 2)))))));
  out.append(h('div', { class: 'two' }, gainsBox, simBox));
  return out;
}
