// Вкладка «Шумы»: спектр до/после фильтров, D-term, пики, спектрограммы.

import { AXIS_NAMES, T } from '../../i18n/ru';
import { heatmap } from '../charts/heatmap';
import { spectrumChart } from '../charts/spectrum';
import { zoomTo } from '../charts/timechart';
import { fmt, h } from '../dom';
import { helpBtn } from '../help';
import { set, state } from '../store';

export function noiseView(track: (d: () => void) => void): HTMLElement {
  const an = state.analysis, info = state.info;
  if (!an || !info) return h('div');
  const N = an.noise;
  const a = state.noiseAxis;
  const ax = N.axes[a];
  const src = state.noiseSource === 'unfilt' && info.hasGyroUnfilt ? 'unfilt' : 'filt';

  const axisCtl = h('div', { class: 'seg-ctl' }, AXIS_NAMES.map((n, i) => h('button', { class: i === a ? 'on' : '', onclick: () => set({ noiseAxis: i }) }, n)));
  const srcCtl = h('div', { class: 'seg-ctl' },
    h('button', { class: src === 'unfilt' ? 'on' : '', disabled: !info.hasGyroUnfilt, onclick: () => set({ noiseSource: 'unfilt' }) }, T.noise.srcUnfilt),
    h('button', { class: src === 'filt' ? 'on' : '', onclick: () => set({ noiseSource: 'filt' }) }, T.noise.srcFilt));

  const marks = N.motorHzMedian
    ? [1, 2, 3].map((k) => ({ hz: N.motorHzMedian! * k, label: `×${k}`, color: '--fg3' })).filter((m) => m.hz < N.nyquist)
    : [];

  const spec = spectrumChart({
    title: `${T.noise.spectrum}: ${AXIS_NAMES[a]}`,
    help: 'chart-spectrum',
    df: N.df,
    maxHz: N.nyquist,
    lines: [
      { label: T.noise.before, color: '--s2', data: ax.unfilt },
      { label: T.noise.after, color: '--s1', data: ax.filt, width: 1.6 },
    ],
    marks,
    peaks: ax.peaks.map((p) => ({ hz: p.hz, label: `${p.hz.toFixed(0)}` })),
    height: 300,
  });
  track(spec.destroy);

  const dspec = ax.dterm && a < 2
    ? spectrumChart({ title: `${T.noise.dterm}: ${AXIS_NAMES[a]}`, help: 'metric-dterm', df: N.df, maxHz: N.nyquist, lines: [{ label: T.noise.dterm, color: '--s4', data: ax.dterm }], marks, height: 200 })
    : null;
  if (dspec) track(dspec.destroy);

  const ts = N.thrSpec[a][src] ?? N.thrSpec[a].filt;
  const tt = N.timeSpec[a][src] ?? N.timeSpec[a].filt;
  const hThr = heatmap({ title: `${T.noise.thrSpec}: ${AXIS_NAMES[a]}`, help: 'chart-thr-spectrogram', spec: ts, maxHz: N.nyquist, mode: 'throttle', yLabel: T.noise.throttle, xLabel: T.noise.freq, height: 300 });
  const hTime = heatmap({
    title: `${T.noise.timeSpec}: ${AXIS_NAMES[a]}`, help: 'chart-time-spectrogram', spec: tt, maxHz: N.nyquist, mode: 'time', yLabel: T.noise.time, xLabel: T.noise.freq, height: 380,
    onRowClick: (t) => { zoomTo(t, 1.5); set({ tab: 'flight' }); },
  });
  track(hThr.destroy);
  track(hTime.destroy);

  const peaks = ax.peaks.length
    ? h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, T.noise.peakHz), h('th', null, T.noise.peakProm), h('th', null, T.noise.peakKind), h('th', null, T.noise.peakBand))),
        h('tbody', null, ax.peaks.map((p) => h('tr', null,
          h('td', null, `${p.hz.toFixed(0)} Гц`),
          h('td', null, `+${p.prominenceDb.toFixed(0)} дБ`),
          h('td', null, T.noise.kind[p.kind] + (p.kind === 'motor' && p.harmonic ? ` ×${p.harmonic}` : '')),
          h('td', { class: 'muted small' }, `${p.bandLo.toFixed(0)}–${p.bandHi.toFixed(0)} Гц`)))))
    : h('div', { class: 'muted' }, T.noise.noPeaks);

  const metrics = h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, T.noise.axis),
      h('th', null, T.noise.mRaw, ' ', helpBtn('metric-noise-rms')), h('th', null, T.noise.mFilt), h('th', null, T.noise.mRed, ' ', helpBtn('metric-reduction')),
      h('th', null, T.noise.mD, ' ', helpBtn('metric-dterm')), h('th', null, T.noise.mMid, ' ', helpBtn('metric-mid')))),
    h('tbody', null, N.axes.map((x) => h('tr', { class: 'click', onclick: () => set({ noiseAxis: x.axis }) },
      h('td', null, x.axis === a ? h('b', null, AXIS_NAMES[x.axis]) : AXIS_NAMES[x.axis]),
      h('td', null, fmt(x.rmsUnfilt, 1, ' °/с')), h('td', null, fmt(x.rmsFilt, 2, ' °/с')), h('td', null, fmt(x.reductionDb, 0, ' дБ')),
      h('td', null, fmt(x.rmsDterm, 1)), h('td', null, fmt(x.rmsMid, 1, ' °/с'))))));

  const notes = h('div', { class: 'muted small' },
    [N.motorHzMedian ? T.noise.motorHz(N.motorHzMedian) : '', N.bursts.length ? T.phrase.bursts(N.bursts.length) : ''].filter(Boolean).join(' · '));

  return h('div', null,
    h('h2', null, T.noise.title, helpBtn('card-noise')),
    N.degraded ? h('div', { class: 'panel warn' }, T.phrase.degraded, ' ', helpBtn('gyro-unfilt')) : null,
    h('div', { class: 'row', style: 'margin-bottom:10px' }, T.noise.axis, axisCtl, h('span', { style: 'width:20px' }), T.noise.source, srcCtl),
    h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.noise.metrics), metrics, notes),
    spec.el,
    h('div', { class: 'two' },
      h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.noise.peaks, helpBtn('chart-peaks')), peaks),
      dspec ? dspec.el : h('div')),
    h('div', { class: 'two' }, hThr.el, hTime.el),
  );
}
