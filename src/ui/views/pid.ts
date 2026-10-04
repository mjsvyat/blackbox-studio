// Вкладка «PID / step»: step response по осям с полосой разброса, цифры, трекинг,
// вклад P/I/D/F, PID и слайдеры Simplified из заголовка.

import cfg from '../../config/analysis.json';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { lineChart } from '../charts/line';
import { clear, fmt, h } from '../dom';
import { helpBtn } from '../help';
import { ensurePid, requestPidForecast, state, subscribe } from '../store';
import { SimplifiedPids, gainsToCli, simplifiedPids, simplifiedToCli } from '../../pid/gains';
import { cliDiff } from '../../params/registry';

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
  out.append(forecastSection(track));
  return out;
}

// ---------- этап 7: модель оси и песочница PID ----------

const SIM_KEYS: (keyof SimplifiedPids)[] = ['master', 'pi', 'i', 'd', 'dExtra', 'ff', 'pitchD', 'pitchPi'];
let useFilterSandbox = false;

export function forecastSection(track: (d: () => void) => void): HTMLElement {
  const P = state.pid!;
  const M = P.model;
  const box = h('div');
  if (!M) return box;
  const fmtPct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)} %` : '—');
  box.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.modelTitle, helpBtn('pid-model')),
    h('div', { class: 'muted small' }, T.pid.modelNote),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ...Object.values(T.pid.modelCol).map((c) => h('th', null, c)))),
      h('tbody', null, M.axes.map((a) => h('tr', null,
        h('td', null, AXIS_NAMES[a.axis]),
        h('td', null, Number.isFinite(a.stepFit) ? `${fmt(a.stepFit, 0)} %` : '—'),
        h('td', null, Number.isFinite(a.tauMs) ? `${fmt(a.tauMs, 0)} мс` : '—'),
        h('td', null, Number.isFinite(a.plantDelayMs) && a.ok ? `${fmt(a.plantDelayMs, 0)} мс` : '—'),
        h('td', null, `${fmtPct(a.pFit)} / ${fmtPct(a.dFit)} / ${fmtPct(a.fFit)}`),
        h('td', null, h('span', { class: a.ok ? 'badge' : 'badge yellow' }, T.pid.modelWhy[a.why]))))))));
  if (!M.axes.some((a) => a.ok)) {
    box.append(h('div', { class: 'panel muted' }, T.pid.fcNone));
    return box;
  }

  // ---------- песочница ----------
  const sp = P.simplified;
  const curCli = { ...gainsToCli(P.gains), ...(sp ? simplifiedToCli(sp.s, sp.dExtraName) : {}) };
  const changes = (): Record<string, number> => state.pidSandbox ?? {};
  const filterChanges = (): Record<string, number> => {
    if (!useFilterSandbox || !state.filters || !state.sandbox) return {};
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(state.sandbox)) if (state.filters.params[k] !== v) o[k] = v;
    return o;
  };
  const commit = (ch: Record<string, number>): void => requestPidForecast({ ...ch, ...filterChanges() });
  const controls = h('div');
  if (sp && sp.s.mode > 0) {
    const s1: SimplifiedPids = { ...sp.s };
    const kind = P.gains.dExtraKind === 'd_max' ? 'd_max' : 'd_min';
    for (const k of SIM_KEYS) {
      const cliKey = Object.keys(simplifiedToCli(sp.s, sp.dExtraName))[['mode', ...SIM_KEYS].indexOf(k)];
      const cur = (state.pidSandbox?.[cliKey] ?? sp.s[k]) as number;
      (s1 as unknown as Record<string, number>)[k] = cur;
      const num = h('input', { type: 'number', min: 0, max: 200, step: 5, value: cur, style: 'width:70px' }) as HTMLInputElement;
      const rng = h('input', { type: 'range', min: 0, max: 200, step: 5, value: cur, style: 'flex:1' }) as HTMLInputElement;
      const on = (v: number): void => {
        (s1 as unknown as Record<string, number>)[k] = v;
        num.value = String(v); rng.value = String(v);
        const g = simplifiedPids(s1, kind, P.gains);
        const next = { ...gainsToCli(g), ...simplifiedToCli(s1, sp.dExtraName) };
        const ch: Record<string, number> = {};
        for (const [kk, vv] of Object.entries(next)) if (curCli[kk] !== vv) ch[kk] = vv;
        commit(ch);
      };
      rng.addEventListener('input', () => on(Number(rng.value)));
      num.addEventListener('change', () => on(Math.max(0, Math.min(200, Math.round(Number(num.value))))));
      controls.append(h('div', { class: 'row', style: 'gap:10px;margin:4px 0' }, h('span', { style: 'min-width:240px' }, T.pid.simNames[k]), rng, num, h('span', { class: 'muted small', style: 'min-width:70px' }, `было ${sp.s[k]}`)));
    }
  } else {
    controls.append(h('div', { class: 'muted small' }, T.pid.sbDirect));
    const tbl = h('table', { class: 'grid small' });
    for (const ax of [0, 1]) {
      const cells = (['p', 'i', 'd', 'f'] as const).map((t) => {
        const key = `${t}_${['roll', 'pitch'][ax]}`;
        const el = h('input', { type: 'number', min: 0, max: t === 'f' ? 1000 : 250, value: changes()[key] ?? curCli[key], style: 'width:70px' }) as HTMLInputElement;
        el.addEventListener('change', () => { const ch = { ...changes() }; const v = Number(el.value); if (v === curCli[key]) delete ch[key]; else ch[key] = v; commit(ch); });
        return h('td', null, t.toUpperCase(), ' ', el);
      });
      tbl.append(h('tr', null, h('td', null, AXIS_NAMES[ax]), ...cells));
    }
    controls.append(tbl);
  }
  const fChk = h('input', { type: 'checkbox', checked: useFilterSandbox }) as HTMLInputElement;
  fChk.addEventListener('change', () => { useFilterSandbox = fChk.checked; const own: Record<string, number> = {}; for (const [k, v] of Object.entries(changes())) if (!(state.filters && k in state.filters.params)) own[k] = v; commit(own); });
  const busy = h('span', { class: 'muted small', style: `visibility:${state.pidBusy ? 'visible' : 'hidden'}` }, T.pid.sbBusy);
  box.append(h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, T.pid.sbTitle, helpBtn('pid-forecast'), busy),
    h('div', { class: 'muted small' }, T.pid.sbHint),
    h('div', { style: 'margin-top:6px' }, sp && sp.s.mode > 0 ? h('b', { class: 'small' }, T.pid.sbSimplified) : null, controls),
    h('div', { class: 'row', style: 'margin-top:6px' },
      state.filters && state.sandbox ? h('label', { class: 'small row', style: 'gap:6px' }, fChk, T.pid.sbFilters) : null,
      h('button', { class: 'btn small', onclick: () => requestPidForecast({}, 0) }, T.pid.sbReset))));

  // ---------- графики и таблица прогноза (перерисовываются по подписке) ----------
  const results = h('div');
  box.append(results);
  let destroyers: (() => void)[] = [];
  track(() => destroyers.forEach((d) => d()));
  const renderResults = (): void => {
    destroyers.forEach((d) => d());
    destroyers = [];
    clear(results);
    busy.style.visibility = state.pidBusy ? 'visible' : 'hidden';
    resultsInto(results, (d) => destroyers.push(d));
  };
  track(subscribe((_s, chg) => { if (chg.has('pidForecast') || chg.has('pidBusy')) renderResults(); }));
  renderResults();
  return box;
}

function resultsInto(box: HTMLElement, track: (d: () => void) => void): void {
  const P = state.pid!;
  const M = P.model!;
  const sp = P.simplified;
  const curCli = { ...gainsToCli(P.gains), ...(sp ? simplifiedToCli(sp.s, sp.dExtraName) : {}) };
  const changes = (): Record<string, number> => state.pidSandbox ?? {};
  const F = state.pidForecast ?? M.axes;
  const t = M.t.map((v) => v * 1000);
  for (const f of F.filter((x) => x.ok && x.axis < 2)) {
    const meas = P.axes[f.axis].step?.mean;
    const ch = lineChart({
      title: T.pid.fcChart(AXIS_NAMES[f.axis]), help: 'pid-forecast', x: t, height: 260, yRange: [0, 1.6],
      lines: [
        { label: T.pid.lMeasured, color: '--s1', data: meas ? Array.from(meas) : null, width: 2 },
        { label: T.pid.lModelNow, color: '--fg3', data: f.now, width: 1 },
        { label: T.pid.lForecast, color: '--s3', data: f.mid, width: 2, dash: [6, 4] },
      ],
      bands: [{ lower: f.lo, upper: f.hi, color: '--s3' }],
      hline: { y: 1, label: '1.0', color: '--fg3' },
      note: `${T.pid.fcNote} ${T.pid.fcScale(state.board?.pidBandScale ?? 1)}`,
    });
    track(ch.destroy);
    box.append(ch.el);
  }
  const rng = (r: { mid: number; lo: number; hi: number }, d: number): string => `${fmt(r.mid, d)} (${fmt(r.lo, d)}–${fmt(r.hi, d)})`;
  box.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.fcTable),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ...Object.values(T.pid.fcCol).map((c) => h('th', null, c)))),
      h('tbody', null, F.filter((x) => x.ok).flatMap((f) => {
        const m = P.axes[f.axis].metrics;
        return [
          h('tr', null, h('td', null, AXIS_NAMES[f.axis]), h('td', null, T.pid.mOvershoot), h('td', null, fmt(m?.overshootPct, 0)), h('td', null, fmt(f.nowMetrics.overshoot, 0)), h('td', { style: 'font-style:italic' }, rng(f.overshoot, 0))),
          h('tr', null, h('td', null, ''), h('td', null, T.pid.mDelay), h('td', null, fmt(m?.delayMs, 1)), h('td', null, fmt(f.nowMetrics.delayMs, 1)), h('td', { style: 'font-style:italic' }, rng(f.delayMs, 1))),
          h('tr', null, h('td', null, ''), h('td', null, T.pid.mSettle), h('td', null, fmt(m?.settle, 2)), h('td', null, fmt(f.nowMetrics.settle, 2)), h('td', { style: 'font-style:italic' }, rng(f.settle, 2))),
        ];
      })))));
  // CLI песочницы
  const ch = changes();
  const pidOnly: Record<string, number> = {};
  for (const [k, v] of Object.entries(ch)) if (!(state.filters && k in state.filters.params)) pidOnly[k] = v;
  const cli = cliDiff(curCli, { ...curCli, ...pidOnly }, P.fwCode);
  if (cli.lines.length) {
    const text = cli.lines.join('\n');
    box.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.pid.cliTitle),
      h('pre', { style: 'margin:0;padding:8px;background:var(--bg3);border-radius:6px;overflow:auto' }, text),
      h('div', { class: 'muted small' }, T.adv.cliNote)));
  }
}
