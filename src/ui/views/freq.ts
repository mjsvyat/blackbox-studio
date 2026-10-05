// Частотная характеристика, запасы устойчивости, модель по chirp и мастер chirp-полёта (C).

import cfg from '../../config/analysis.json';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { CHIRP_PARAMS } from '../../sysid/chirp';
import { paramByName } from '../../params/registry';
import { lineChart } from '../charts/line';
import { fmt, fmtTime, h } from '../dom';
import { fcPrepare } from '../fcStore';
import { helpBtn } from '../help';
import { state } from '../store';

let axisSel = 0;

const status = (v: number | null | undefined, t: { green: number; red: number }): string => (v === null || v === undefined || !Number.isFinite(v) ? 'grey' : v >= t.green ? 'green' : v >= t.red ? 'yellow' : 'red');

export function freqSection(track: (d: () => void) => void, rerender: () => void): HTMLElement {
  const F = state.pid?.freq;
  const box = h('div', null, h('h3', null, T.freq.title, helpBtn('freq-response')));
  if (!F) return box;
  const C = cfg.chirp;
  if (F.segments.length) box.append(h('div', { class: 'muted small' }, T.freq.segs(F.segments.length, F.segments.map((s) => `${AXIS_NAMES[s.axis]} ${fmtTime(s.t0)}–${fmtTime(s.t1)}, ${T.freq.axisFrom[s.axisFrom]}`).join('; '))));

  // таблица запасов по осям
  box.append(h('div', { class: 'panel' }, h('h4', { style: 'margin-top:0' }, T.freq.tableTitle, helpBtn('stability-margins')),
    h('table', { class: 'grid small' },
      h('thead', null, h('tr', null, Object.values(T.freq.col).map((c) => h('th', null, c)))),
      h('tbody', null, F.axes.map((a) => {
        const m = a.margins;
        const ok = a.marginsOk;
        return h('tr', null,
          h('td', null, AXIS_NAMES[a.axis]),
          h('td', null, T.freq.src[a.source]),
          h('td', null, ok && m?.crossHz ? `${fmt(m.crossHz, 0)} ${T.freq.hz}` : '—'),
          h('td', null, ok && m?.pmDeg !== null && m?.pmDeg !== undefined ? [h('span', { class: `dot ${status(m.pmDeg, C.pm)}` }), ` ${fmt(m.pmDeg, 0)}°`] : '—'),
          h('td', null, ok && m?.gmDb !== null && m?.gmDb !== undefined ? [h('span', { class: `dot ${status(m.gmDb, C.gm)}` }), ` ${T.freq.db(fmt(m.gmDb, 1))}`] : '—'),
          h('td', null, a.bwHz !== null ? `${fmt(a.bwHz, 0)} ${T.freq.hz}` : '—'),
          h('td', null, a.cohAtCross !== null ? fmt(a.cohAtCross, 2) : '—'),
          h('td', null, h('span', { class: `badge ${ok ? '' : 'yellow'}` }, ok ? T.freq.trustOk : T.freq.trustNo)));
      })))));

  // графики выбранной оси
  const a = F.axes.find((x) => x.axis === axisSel) ?? F.axes[0];
  if (a) {
    box.append(h('div', { class: 'row', style: 'margin:6px 0' }, h('div', { class: 'seg-ctl' }, F.axes.map((x) => h('button', { class: x.axis === a.axis ? 'on' : '', onclick: () => { axisSel = x.axis; rerender(); } }, AXIS_NAMES[x.axis])))));
    box.append(h('div', { class: 'muted small' }, a.source === 'chirp' ? T.freq.srcChirp(fmt(a.seconds, 0)) : T.freq.srcFlight));
    // масштаб — по области, где данным можно верить (минимум 30 Гц)
    let fCoh = 0;
    a.f.forEach((v, i) => { if (a.tCoh[i] >= C.minCoh) fCoh = v; });
    const fMax = Math.min(250, a.f[a.f.length - 1] ?? 250, Math.max(30, fCoh * 1.5));
    const n = a.f.findIndex((v) => v > fMax);
    const cut = <X>(v: X[]): X[] => (n > 0 ? v.slice(0, n) : v);
    const x = cut(a.f);
    const bars = { x, h: cut(a.tCoh), width: x.length > 1 ? x[1] - x[0] : 1, color: 'rgba(120,160,255,0.25)' };
    const grid = h('div', { class: 'grid2' });
    const add = (title: string, data: number[], color: string, hline?: { y: number; label: string; color: string }): void => {
      const ch = lineChart({ title, help: 'freq-response', x, lines: [{ label: title.split(':').pop()!.trim(), color, data: cut(data), width: 1.4 }], height: 200, xRange: [0, fMax], bars, hline });
      track(ch.destroy);
      grid.append(ch.el);
    };
    add(T.freq.chT, a.tDb, '--accent', { y: -3, label: T.freq.db('−3'), color: '--fg3' });
    add(T.freq.chTph, a.tPh, '--s2');
    if (a.lDb) add(T.freq.chL, a.lDb, '--s3', { y: 0, label: T.freq.db('0'), color: '--fg3' });
    if (a.lPh) add(T.freq.chLph, a.lPh, '--s4', { y: -180, label: '−180°', color: '--red' });
    box.append(grid, h('div', { class: 'muted small' }, T.freq.coh));
  }

  // модель по chirp против модели по обычному полёту
  if (F.cmp.length) {
    box.append(h('div', { class: 'panel' }, h('h4', { style: 'margin-top:0' }, T.freq.cmpTitle, helpBtn('pid-model')),
      h('table', { class: 'grid small' },
        h('thead', null, h('tr', null, Object.values(T.freq.cmpCol).map((c) => h('th', null, c)), h('th', null, ''))),
        h('tbody', null, F.cmp.map((c) => h('tr', null,
          h('td', null, AXIS_NAMES[c.axis]),
          h('td', null, c.flightFit !== null ? `${fmt(c.flightFit, 0)} %` : '—'),
          h('td', null, `${fmt(c.chirpFit, 0)} %`),
          h('td', null, c.flightBandPp !== null ? T.freq.pp(fmt(c.flightBandPp, 1)) : '—'),
          h('td', null, T.freq.pp(fmt(c.chirpBandPp, 1))),
          h('td', { class: 'small' }, c.flightBandPp && c.chirpBandPp > 0 && c.flightBandPp / c.chirpBandPp > 1.2 ? T.freq.narrower(c.flightBandPp / c.chirpBandPp) : ''))))),
      h('div', { class: 'muted small' }, T.freq.modelChirp)));
  }
  box.append(chirpWizard());
  return box;
}

/** мастер chirp-полёта: прошивка, параметры (CLI / по USB), режим, лог, как лететь, безопасность */
function chirpWizard(): HTMLElement {
  const F = state.pid?.freq;
  const H = state.info?.header ?? {};
  const fw = F?.fw;
  const cur: Record<string, number> = {};
  for (const k of CHIRP_PARAMS) if (H[k] !== undefined) cur[k] = Number(H[k]);
  // рекомендуемое: дефолты BF, амплитуда ролла/питча для первого раза — 150
  const rec: Record<string, number> = {};
  for (const k of CHIRP_PARAMS) rec[k] = paramByName.get(k)!.def;
  rec.chirp_amplitude_roll = 150;
  rec.chirp_amplitude_pitch = 150;
  const lines = CHIRP_PARAMS.map((k) => `set ${k} = ${rec[k]}`);
  const text = [...lines, 'save'].join('\n');
  return h('details', { class: 'panel', open: !F?.segments.length },
    h('summary', null, h('b', null, T.freq.wizTitle), ' ', helpBtn('chirp-wizard')),
    h('p', { class: 'small' }, T.freq.wizIntro),
    h('p', { class: 'small' }, fw?.inFirmware ? T.freq.wizFwOk : [T.freq.wizFw, fw && !fw.inFirmware ? h('div', { class: 'warn-text' }, T.freq.noFw) : '']),
    h('p', { class: 'small' }, T.freq.wizCli),
    h('pre', { class: 'cli small' }, text),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(text).catch(() => undefined) }, T.filt.cliCopy),
      h('button', { class: 'btn small', onclick: () => fcPrepare(cur, rec, 'chirp') }, T.fc.toBoard)),
    h('p', { class: 'small' }, T.freq.wizMode),
    h('p', { class: 'small' }, T.freq.wizLog),
    h('p', { class: 'small' }, T.freq.wizFly),
    h('p', { class: 'small warn-text' }, T.freq.wizSafe),
    h('p', { class: 'small' }, T.freq.wizAfter));
}
