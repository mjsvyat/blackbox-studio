// Вкладка «Фильтры»: самопроверка модели, текущая цепочка, примерка (Simplified +
// все параметры), «что изменится», CLI, спектры, АЧХ, задержка, дорожки дин. фильтров.

import { fcPrepare } from '../fcStore';
import type { FilterEval } from '../../filters/evaluate';
import { FilterParams, applySimplified, cliDiff, simplifiedConsistent } from '../../filters/settings';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { PARAMS, ParamDef, clampParam, paramAvailable } from '../../params/registry';
import { lineChart } from '../charts/line';
import { clear, fmt, h } from '../dom';
import { helpBtn } from '../help';
import { ensureFilters, requestSandbox, set, state, subscribe } from '../store';

const GROUPS: { id: string; names: string[] }[] = [
  { id: 'rpm', names: ['rpm_filter_harmonics', 'rpm_filter_q', 'rpm_filter_min_hz', 'rpm_filter_fade_range_hz', 'rpm_filter_lpf_hz'] },
  { id: 'dyn', names: ['dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz'] },
  { id: 'glpf', names: ['gyro_lpf1_type', 'gyro_lpf1_static_hz', 'gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz', 'gyro_lpf1_dyn_expo', 'gyro_lpf2_type', 'gyro_lpf2_static_hz'] },
  { id: 'notch', names: ['gyro_notch1_hz', 'gyro_notch1_cutoff', 'gyro_notch2_hz', 'gyro_notch2_cutoff'] },
  { id: 'dterm', names: ['dterm_lpf1_type', 'dterm_lpf1_static_hz', 'dterm_lpf1_dyn_min_hz', 'dterm_lpf1_dyn_max_hz', 'dterm_lpf1_dyn_expo', 'dterm_lpf2_type', 'dterm_lpf2_static_hz', 'dterm_notch_hz', 'dterm_notch_cutoff'] },
];

let advancedOpen = false;

const pctDelta = (a: number, b: number): string => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return '—';
  const d = ((b - a) / a) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(0)} %`;
};
const absDelta = (a: number, b: number, d = 2, unit = ''): string => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const x = b - a;
  return `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;
};

function sameParams(a: FilterParams, b: FilterParams): boolean {
  return Object.keys(b).every((k) => a[k] === b[k]);
}

export function filtersView(track: (d: () => void) => void): HTMLElement {
  const F = state.filters;
  if (!F) {
    ensureFilters();
    return h('div', null, h('h2', null, T.filt.title, helpBtn('card-filters')), h('div', { class: 'panel muted' }, T.filt.loading));
  }
  const base = F.base;
  const v = base.validation;
  const cur = base.current;
  const ax = state.filterAxis;

  // ---------- самопроверка ----------
  const matchTxt = v.match.map((m, i) => `${AXIS_NAMES[i]} ${fmt(m, 0)} %`).join(' / ');
  const model = h('div', { class: `panel ${v.status === 'green' ? '' : v.status === 'yellow' ? 'warn' : 'bad'}` },
    h('h3', { style: 'margin-top:0' }, h('span', { class: `dot ${v.status}` }), T.filt.modelTitle, helpBtn('filter-model')),
    h('div', null, h('b', null, T.filt.modelMatch(matchTxt))),
    h('div', { class: 'muted small' },
      T.filt.modelSpec(v.spectralDb.map((x) => fmt(x, 1)).join(' / ')), ' · ',
      T.filt.modelD(v.dCorr.map((x) => fmt(x, 2)).join(' / ')), ' · ',
      T.filt.modelData(base.seconds, v.logHz, v.pidHz)),
    h('p', { style: 'margin:6px 0 0' }, T.filt.reason[v.reason] ?? ''));

  // ---------- примерка: управление ----------
  const sb = state.sandbox ?? { ...F.params };
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const commit = (next: FilterParams): void => {
    for (const [k, el] of inputs) if (next[k] !== undefined && String(next[k]) !== el.value) el.value = String(next[k]);
    requestSandbox(next);
  };
  const slider = (name: string, label: string, onChange: (val: number) => void): HTMLElement => {
    const def = PARAMS.find((p) => p.name === name)!;
    const val = sb[name] ?? def.def;
    const num = h('input', { type: 'number', min: def.min, max: def.max, value: val, style: 'width:70px' }) as HTMLInputElement;
    const rng = h('input', { type: 'range', min: def.min, max: def.max, step: 5, value: val, style: 'flex:1' }) as HTMLInputElement;
    rng.addEventListener('input', () => { num.value = rng.value; onChange(Number(rng.value)); });
    num.addEventListener('change', () => { const x = clampParam(name, Number(num.value)); num.value = String(x); rng.value = String(x); onChange(x); });
    inputs.set(name, num);
    return h('div', { class: 'row', style: 'gap:10px;margin:6px 0' }, h('span', { style: 'min-width:290px' }, label, ' ', helpBtn(def.help)), rng, num,
      h('span', { class: 'muted small', style: 'min-width:60px' }, `было ${F.params[name] ?? '—'}`));
  };
  // множитель Simplified: включает simplified-режим и пересчитывает зависимые срезы
  const simRow = (name: string, label: string): HTMLElement => slider(name, label, (val) => {
    const enabledKey = name.replace('_multiplier', '');
    commit(applySimplified({ ...(state.sandbox ?? sb), [name]: val, [enabledKey]: 1 }));
  });

  const paramControl = (def: ParamDef): HTMLElement | null => {
    if (!paramAvailable(def.name, F.fwCode)) return null;
    const val = sb[def.name] ?? def.def;
    const onChange = (x: number): void => commit({ ...(state.sandbox ?? sb), [def.name]: x });
    let ctl: HTMLInputElement | HTMLSelectElement;
    if (def.options) {
      ctl = h('select', { class: 'btn small' }, def.options.map((o, i) => h('option', { value: i, selected: i === val }, o))) as HTMLSelectElement;
      ctl.addEventListener('change', () => onChange(Number(ctl.value)));
    } else {
      ctl = h('input', { type: 'number', min: def.min, max: def.max, value: val, style: 'width:80px' }) as HTMLInputElement;
      ctl.addEventListener('change', () => { const x = clampParam(def.name, Number(ctl.value)); ctl.value = String(x); onChange(x); });
    }
    inputs.set(def.name, ctl);
    return h('div', { class: 'row small', style: 'gap:8px;margin:3px 0' },
      h('span', { style: 'min-width:330px' }, def.label, ' ', helpBtn(def.help)), ctl,
      h('span', { class: 'muted' }, `${def.unit ?? ''} (${def.min}…${def.max}), было ${F.params[def.name] ?? '—'}`));
  };
  const adv = h('div', { style: advancedOpen ? '' : 'display:none' },
    GROUPS.map((g) => h('div', null, h('h4', { style: 'margin:10px 0 2px' }, T.filt.params[g.id]),
      g.names.map((n) => PARAMS.find((p) => p.name === n)).filter((d): d is ParamDef => !!d).map(paramControl))));
  const busy = h('span', { class: 'muted small', style: 'visibility:hidden' }, T.filt.busy);
  const controls = h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, T.filt.sandbox, helpBtn('filter-sandbox'), busy),
    h('div', { class: 'muted small' }, T.filt.sandboxHint),
    simRow('simplified_gyro_filter_multiplier', T.filt.simGyro),
    simRow('simplified_dterm_filter_multiplier', T.filt.simD),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn small', onclick: () => { commit({ ...F.params }); for (const [k, el] of inputs) el.value = String(F.params[k] ?? ''); } }, T.filt.reset),
      h('button', { class: 'btn small', onclick: (e: Event) => { advancedOpen = !advancedOpen; adv.style.display = advancedOpen ? '' : 'none'; (e.target as HTMLElement).textContent = `${T.filt.advanced} ${advancedOpen ? '▾' : '▸'}`; } }, `${T.filt.advanced} ${advancedOpen ? '▾' : '▸'}`)),
    adv);

  // ---------- результаты (перерисовываются на каждый новый расчёт) ----------
  const results = h('div');
  const charts = h('div');
  let destroyers: (() => void)[] = [];
  const disposeCharts = (): void => { destroyers.forEach((d) => d()); destroyers = []; };
  track(disposeCharts);

  const renderResults = (): void => {
    const nb = state.sandbox ?? F.params;
    const ev: FilterEval = state.sandboxEval ?? cur;
    busy.style.visibility = state.sandboxBusy ? 'visible' : 'hidden';
    clear(results);
    const changed = !sameParams(F.params, nb);
    // таблица «что изменится»
    const rows: HTMLElement[] = [];
    const row = (label: string, a: number, b: number, unit: string, d: number, helpId?: string, logged?: number): void => {
      rows.push(h('tr', null, h('td', null, label, ' ', helpBtn(helpId)),
        h('td', null, `${fmt(a, d)}${unit}`, logged !== undefined ? h('span', { class: 'muted small' }, ` (${T.filt.logged} ${fmt(logged, d)})`) : null),
        h('td', null, h('b', null, `${fmt(b, d)}${unit}`)),
        h('td', null, unit === ' мс' ? absDelta(a, b, 2, ' мс') : pctDelta(a, b))));
    };
    for (const f of ['50', '100', '150']) row(T.filt.delayGyro(f), cur.delay.gyro[f], ev.delay.gyro[f], ' мс', 2, 'filter-delay');
    row(T.filt.delayD('100'), cur.delay.dterm['100'], ev.delay.dterm['100'], ' мс', 2, 'filter-delay');
    for (let a = 0; a < 3; a++) row(T.filt.noiseAxis(AXIS_NAMES[a]), cur.rmsGyro[a], ev.rmsGyro[a], ' °/с', 2, 'metric-noise-rms', base.loggedRmsGyro[a]);
    for (let a = 0; a < 2; a++) row(T.filt.dAxis(AXIS_NAMES[a]), cur.rmsDterm[a], ev.rmsDterm[a], '', 1, 'metric-dterm', base.loggedRmsDterm[a]);
    const tbl = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, T.filt.colMetric), h('th', null, T.filt.colNow), h('th', null, T.filt.colNew), h('th', null, T.filt.colDelta))), h('tbody', null, rows));
    const meanPct = (a: number[], b: number[]): string => pctDelta(a.reduce((s, x) => s + x, 0), b.reduce((s, x) => s + x, 0));
    const trade = changed
      ? T.filt.tradeoff(absDelta(cur.delay.gyro['100'], ev.delay.gyro['100'], 2, ' мс'), meanPct(cur.rmsGyro, ev.rmsGyro), meanPct(cur.rmsDterm, ev.rmsDterm))
      : T.filt.noChange;

    // предупреждения
    const warns: HTMLElement[] = [];
    const weaker = changed && (ev.delay.gyro['100'] < cur.delay.gyro['100'] - 0.01 || ev.delay.dterm['100'] < cur.delay.dterm['100'] - 0.01 || ev.rmsDterm.some((x, i) => x > cur.rmsDterm[i] * 1.03));
    if (weaker) warns.push(h('div', { class: 'panel bad' }, h('b', null, T.filt.warnWeaken)));
    if (weaker && F.noiseStatus !== 'green') warns.push(h('div', { class: 'panel bad' }, T.filt.warnDirty));
    if (changed && v.status !== 'green') warns.push(h('div', { class: 'panel warn' }, T.filt.warnModel));
    const sc = simplifiedConsistent(nb);
    const extra: FilterParams = {};
    if (!sc.gyro) extra.simplified_gyro_filter = 0;
    if (!sc.dterm) extra.simplified_dterm_filter = 0;
    // обязательные фильтры (чат Blackbox 2.0): LPF2 при PID медленнее гиро, хотя бы один фильтр D-term
    const denom = Number(state.info?.header.pid_process_denom ?? 1) || 1;
    if (denom > 1 && !(nb.gyro_lpf2_static_hz ?? 0)) warns.push(h('div', { class: 'panel bad' }, T.filt.warnLpf2Denom(denom), ' ', helpBtn('filter-lpf')));
    if (!(nb.dterm_lpf1_static_hz ?? 0) && !(nb.dterm_lpf1_dyn_min_hz ?? 0) && !(nb.dterm_lpf2_static_hz ?? 0)) warns.push(h('div', { class: 'panel bad' }, T.filt.warnDtermOff, ' ', helpBtn('filter-dterm')));
    if (changed && (!sc.gyro || !sc.dterm)) warns.push(h('div', { class: 'panel warn' }, T.filt.warnSimplified));

    // CLI
    const cli = cliDiff(F.params, { ...nb, ...extra }, F.fwCode);
    const cliText = cli.lines.join('\n');
    const copyBtn = h('button', { class: 'btn small', onclick: async () => {
      try { await navigator.clipboard.writeText(cliText); copyBtn.textContent = T.filt.cliCopied; } catch { /* нет доступа к буферу */ }
    } }, T.filt.cliCopy);
    const simHint = changed && sc.gyro && sc.dterm && (nb.simplified_gyro_filter_multiplier !== F.params.simplified_gyro_filter_multiplier || nb.simplified_dterm_filter_multiplier !== F.params.simplified_dterm_filter_multiplier)
      ? h('div', { class: 'muted small' }, T.filt.cliSimplifiedHint, ` гиро ${nb.simplified_gyro_filter_multiplier}, D-term ${nb.simplified_dterm_filter_multiplier}.`)
      : null;
    const usb = h('button', { class: 'btn small', onclick: () => fcPrepare(F.params, { ...nb, ...extra }, 'filters') }, T.fc.toBoard);
    const cliBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.filt.cliTitle, cliText ? copyBtn : null, cliText ? usb : null),
      cliText ? h('pre', { style: 'margin:0;padding:8px;background:var(--bg3);border-radius:6px;overflow:auto' }, cliText) : h('div', { class: 'muted' }, T.filt.cliEmpty),
      simHint);

    // разбивка задержки по звеньям
    const names = [...new Set([...cur.breakdown.map((b) => b.name), ...ev.breakdown.map((b) => b.name)])];
    const bmap = (arr: { name: string; ms: number }[]): Map<string, number> => new Map(arr.map((b) => [b.name, b.ms]));
    const b0 = bmap(cur.breakdown), b1 = bmap(ev.breakdown);
    const maxMs = Math.max(0.01, ...names.map((n) => Math.max(b0.get(n) ?? 0, b1.get(n) ?? 0)));
    const bar = (v: number | undefined, c: string): HTMLElement => h('div', { style: `height:7px;margin:1px 0;border-radius:3px;background:var(${c});width:${Math.max(0, ((v ?? 0) / maxMs) * 100)}%` });
    const bdBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.filt.bdTitle, helpBtn('filter-delay')),
      h('table', { class: 'grid' }, h('tbody', null, names.map((n) => h('tr', null,
        h('td', { style: 'width:200px' }, T.filt.bdNames[n] ?? n),
        h('td', { style: 'width:150px' }, `${fmt(b0.get(n), 2)} → `, h('b', null, fmt(b1.get(n), 2)), ' мс'),
        h('td', null, bar(b0.get(n), '--fg3'), bar(b1.get(n), '--s3')))))),
      h('div', { class: 'muted small' }, T.filt.bdNote));

    results.append(
      h('div', { class: 'two' },
        h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.filt.chainNow), h('b', { class: 'small' }, T.filt.gyroChain), h('ul', { class: 'small' }, cur.describe.gyro.map((x) => h('li', null, x))), h('b', { class: 'small' }, T.filt.dChain), h('ul', { class: 'small' }, cur.describe.dterm.map((x) => h('li', null, x)))),
        h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.filt.chainNew), h('b', { class: 'small' }, T.filt.gyroChain), h('ul', { class: 'small' }, ev.describe.gyro.map((x) => h('li', null, x))), h('b', { class: 'small' }, T.filt.dChain), h('ul', { class: 'small' }, ev.describe.dterm.map((x) => h('li', null, x))))),
      h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.filt.resultTitle), tbl, h('p', { style: 'margin:8px 0 0' }, h('b', null, trade))),
      bdBox,
      ...warns, cliBox);
    renderCharts(ev);
  };

  const renderCharts = (ev: FilterEval): void => {
    disposeCharts();
    clear(charts);
    const nyq = base.fs / 2;
    const nBins = Math.floor(nyq / base.df);
    const fx = Float32Array.from({ length: nBins }, (_, i) => i * base.df);
    const cut = (a: Float32Array | undefined | null): Float32Array | null => (a ? a.subarray(0, nBins) : null);
    const sg = lineChart({
      title: T.filt.specGyro(AXIS_NAMES[ax]), help: 'chart-filter-spectrum', x: fx, xRange: [2, nyq], height: 300,
      lines: [
        { label: T.filt.lUnfilt, color: '--s2', data: cut(base.loggedUnfiltDb[ax]), width: 1 },
        { label: T.filt.lLogged, color: '--s1', data: cut(base.loggedGyroDb[ax]), width: 1 },
        { label: T.filt.lModelNow, color: '--fg2', data: cut(cur.gyroDb[ax]), width: 1.2 },
        { label: T.filt.lModelNew, color: '--s3', data: cut(ev.gyroDb[ax]), width: 1.8 },
      ],
      hline: { y: F.quantFloorDb, label: T.filt.quant, color: '--fg3' },
      marks: ev.op.motorHz.length && ev.op.motorHz[0] ? [1, 2, 3].map((k) => ({ x: (ev.op.motorHz.reduce((s, x) => s + x, 0) / ev.op.motorHz.length) * k, label: `×${k}`, color: '--fg3' })).filter((m) => m.x < nyq) : [],
      note: T.filt.quantNote,
    });
    destroyers.push(sg.destroy);
    charts.append(sg.el);
    if (ax < 2) {
      const sd = lineChart({
        title: T.filt.specD(AXIS_NAMES[ax]), help: 'metric-dterm', x: fx, xRange: [2, nyq], height: 240,
        lines: [
          { label: T.filt.lDLogged, color: '--s4', data: cut(base.loggedDtermDb[ax]), width: 1 },
          { label: T.filt.lModelNow, color: '--fg2', data: cut(cur.dtermDb[ax]), width: 1.2 },
          { label: T.filt.lModelNew, color: '--s3', data: cut(ev.dtermDb[ax]), width: 1.8 },
        ],
      });
      destroyers.push(sd.destroy);
      charts.append(sd.el);
    }
    const r0 = cur.response, r1 = ev.response;
    const mHz = ev.op.motorHz.length ? ev.op.motorHz.reduce((s, x) => s + x, 0) / ev.op.motorHz.length : 0;
    const mag = lineChart({
      title: T.filt.mag, help: 'filter-response', x: r0.freqs, height: 260, yRange: [-40, 3],
      lines: [
        { label: T.filt.lGyroNow, color: '--fg2', data: r0.gyroMagDb, width: 1.2 },
        { label: T.filt.lGyroNew, color: '--s3', data: r1.gyroMagDb, width: 1.8 },
        { label: T.filt.lDNow, color: '--s4', data: r0.dtermMagDb, width: 1, dash: [4, 3] },
        { label: T.filt.lDNew, color: '--s2', data: r1.dtermMagDb, width: 1.4, dash: [4, 3] },
      ],
      note: T.filt.opNote(ev.op.throttle * 100, mHz),
    });
    const n300 = Math.min(300, r0.freqs.length);
    const del = lineChart({
      title: T.filt.delayChart, help: 'filter-delay', x: r0.freqs.subarray(0, n300), height: 260,
      lines: [
        { label: T.filt.lGyroNow, color: '--fg2', data: r0.gyroDelayMs.subarray(0, n300), width: 1.2 },
        { label: T.filt.lGyroNew, color: '--s3', data: r1.gyroDelayMs.subarray(0, n300), width: 1.8 },
        { label: T.filt.lDNow, color: '--s4', data: r0.dtermDelayMs.subarray(0, n300), width: 1, dash: [4, 3] },
        { label: T.filt.lDNew, color: '--s2', data: r1.dtermDelayMs.subarray(0, n300), width: 1.4, dash: [4, 3] },
      ],
      marks: [50, 100, 150].map((f) => ({ x: f, label: `${f}`, color: '--fg3' })),
      note: T.filt.delayNote,
      yRange: [-1, Math.max(6, Math.ceil(Math.max(cur.delay.dterm['150'], ev.delay.dterm['150']) * 1.4))],
    });
    destroyers.push(mag.destroy, del.destroy);
    charts.append(h('div', { class: 'two' }, mag.el, del.el));
    // дорожки динамических фильтров (текущие настройки)
    const tr = F.track;
    if (tr.t.length > 2) {
      const lines = [
        ...tr.dyn[ax].map((arr, k) => ({ label: T.filt.lDyn(k + 1), color: ['--s1', '--s2', '--s4', '--s5', '--s3', '--fg2', '--red'][k % 7], data: arr, width: 1.2 })),
        ...(tr.lpf1.some((x) => x > 0) ? [{ label: T.filt.lLpf1, color: '--fg3', data: tr.lpf1, width: 1, dash: [4, 3] }] : []),
      ];
      if (lines.length) {
        const tc = lineChart({ title: `${T.filt.track}: ${AXIS_NAMES[ax]}`, help: 'filter-dyn-notch', x: tr.t, height: 200, lines, note: T.filt.trackNote });
        destroyers.push(tc.destroy);
        charts.append(tc.el);
      }
    }
  };

  const unsub = subscribe((_s, ch) => {
    if (ch.has('sandboxEval') || ch.has('sandboxBusy')) renderResults();
  });
  track(unsub);
  renderResults();

  const axisCtl = h('div', { class: 'seg-ctl' }, AXIS_NAMES.map((n, i) => h('button', { class: i === ax ? 'on' : '', onclick: () => set({ filterAxis: i }) }, n)));
  return h('div', null,
    h('h2', null, T.filt.title, helpBtn('card-filters')),
    model,
    controls,
    results,
    h('div', { class: 'row', style: 'margin:6px 0 10px' }, T.filt.axis, axisCtl),
    charts,
  );
}
