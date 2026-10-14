// Вкладка «Рейты»: самопроверка формулы, примерка (все rates_type), кривые с
// гистограммой стиков, использование стиков, манёвры «было → стало бы», CLI.

import { fcPrepare } from '../fcStore';
import cfg from '../../config/analysis.json';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { cliDiff } from '../../params/registry';
import {
  RATE_RANGES, RATES_TYPE, RATES_TYPE_NAMES, RateProfile, centerSensitivity, cloneProfile, convertProfile, curve,
  maxRate, profileToCli, sameProfile, setpointFor,
} from '../../rates/rates';
import { lineChart } from '../charts/line';
import { clear, fmt, h } from '../dom';
import { helpBtn } from '../help';
import { ensureRates, fetchSeries, requestRatesEval, set, state, subscribe } from '../store';

const C = cfg.rates;
type Field = 'rcRate' | 'rate' | 'expo' | 'limit';

let linkRollPitch: boolean | null = null;
let convertMsg = '';

export function ratesView(track: (d: () => void) => void): HTMLElement {
  const R = state.rates;
  if (!R) {
    if (state.ratesWhy) return h('div', null, h('h2', null, T.rates.title, helpBtn('rates-curve')), h('div', { class: 'panel warn' }, T.rates.noHeader));
    ensureRates();
    return h('div', null, h('h2', null, T.rates.title, helpBtn('rates-curve')), h('div', { class: 'panel muted' }, T.rates.loading));
  }
  const base = R.profile;
  if (linkRollPitch === null) linkRollPitch = sameAxis(base, 0, 1);

  // ---------- самопроверка ----------
  const ck = R.check;
  const matchTxt = ck.axes.map((a, i) => `${AXIS_NAMES[i]} ${a.samples ? fmt(a.matchPct, 1) + ' %' : '—'}`).join(' / ');
  const errTxt = ck.axes.map((a) => fmt(a.rmsErr, 2)).join(' / ');
  const check = h('div', { class: `panel ${ck.status === 'green' ? '' : ck.status === 'red' ? 'bad' : 'warn'}` },
    h('h3', { style: 'margin-top:0' }, h('span', { class: `dot ${ck.status}` }), T.rates.checkTitle, helpBtn('rates-check')),
    ck.reason !== 'no-fields' ? h('div', null, h('b', null, T.rates.checkMatch(matchTxt))) : null,
    ck.reason !== 'no-fields' ? h('div', { class: 'muted small' }, T.rates.checkErr(errTxt), ' · ', T.rates.checkData(R.seconds, R.smoothHz)) : null,
    h('p', { style: 'margin:6px 0 0' }, T.rates.checkReason[ck.reason] ?? ''),
    ck.nonRateS > 0.05 ? h('div', { class: 'muted small' }, T.rates.nonRate(ck.nonRateS, ck.nonRateModes.join(', '))) : null);

  // ---------- примерка: управление ----------
  const sb = (): RateProfile => state.ratesSandbox ?? cloneProfile(base);
  const inputs: { ax: number; f: Field; el: HTMLInputElement }[] = [];
  const labels: HTMLElement[][] = [];
  const syncInputs = (p: RateProfile): void => {
    for (const x of inputs) if (String(p.axes[x.ax][x.f]) !== x.el.value) x.el.value = String(p.axes[x.ax][x.f]);
    typeSel.value = String(p.type);
    quickRow.style.display = p.type === RATES_TYPE.QUICK ? '' : 'none';
    quickChk.checked = !!p.quickRcExpo;
    labels.forEach((ls) => ls.forEach((l, k) => { l.textContent = T.rates.fieldNames[p.type][k]; }));
  };
  const commit = (p: RateProfile): void => {
    syncInputs(p);
    requestRatesEval(p);
  };
  const typeSel = h('select', { class: 'btn small' }, RATES_TYPE_NAMES.map((n, i) => h('option', { value: i }, n))) as HTMLSelectElement;
  typeSel.addEventListener('change', () => {
    // смена типа = перевод чисел под ту же кривую (CLI сам не пересчитывает)
    const cur = sb();
    const conv = convertProfile(cur, Number(typeSel.value));
    convertMsg = T.rates.convertDone(conv.rmsErr.map((e) => fmt(e, 1)).join(' / '), conv.center.map(([a, b]) => `${fmt(a, 0)} → ${fmt(b, 0)}`).join(' / '));
    convertNote.textContent = convertMsg;
    commit(conv.profile);
  });
  const quickChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  quickChk.addEventListener('change', () => commit({ ...cloneProfile(sb()), quickRcExpo: quickChk.checked ? 1 : 0 }));
  const quickRow = h('label', { class: 'small row', style: 'gap:6px;margin:4px 0' }, quickChk, T.rates.quickExpo, h('span', { class: 'muted' }, `(${T.rates.quickExpoNote})`));
  const convertNote = h('div', { class: 'muted small' }, convertMsg);

  const numInput = (ax: number, f: Field): HTMLElement => {
    const rg = RATE_RANGES[f];
    const el = h('input', { type: 'number', min: rg.min, max: rg.max, step: 1, value: sb().axes[ax][f], style: 'width:70px' }) as HTMLInputElement;
    el.addEventListener('input', () => {
      const raw = Number(el.value);
      if (!Number.isFinite(raw) || el.value === '') return;
      const v = Math.min(rg.max, Math.max(rg.min, Math.round(raw)));
      const p = cloneProfile(sb());
      p.axes[ax][f] = v;
      if (linkRollPitch && ax < 2) p.axes[1 - ax][f] = v;
      commit(p);
    });
    el.addEventListener('change', () => syncInputs(sb()));
    inputs.push({ ax, f, el });
    return h('div', { style: 'display:flex;flex-direction:column;gap:2px' }, el,
      h('span', { class: 'muted small' }, T.rates.was(String(base.axes[ax][f]))));
  };
  const axisRows = [0, 1, 2].map((ax) => {
    const ls = [0, 1, 2].map(() => h('span', { class: 'muted small' }));
    labels.push(ls);
    return h('tr', null,
      h('td', null, h('b', null, AXIS_NAMES[ax])),
      ...(['rcRate', 'rate', 'expo'] as Field[]).map((f, k) => h('td', null, ls[k], numInput(ax, f))),
      h('td', null, h('span', { class: 'muted small' }, T.rates.limit), numInput(ax, 'limit')));
  });
  const linkChk = h('input', { type: 'checkbox', checked: linkRollPitch }) as HTMLInputElement;
  linkChk.addEventListener('change', () => { linkRollPitch = linkChk.checked; });
  const busy = h('span', { class: 'muted small', style: 'visibility:hidden' }, T.rates.busy);
  const controls = h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, T.rates.sandbox, helpBtn('rates-sandbox'), busy),
    h('div', { class: 'muted small' }, T.rates.sandboxHint),
    h('div', { class: 'row', style: 'margin:8px 0' }, T.rates.type, typeSel, helpBtn('rates-type'),
      h('label', { class: 'small row', style: 'gap:6px' }, linkChk, T.rates.linkRP)),
    quickRow,
    h('table', { class: 'grid' }, h('tbody', null, axisRows)),
    h('div', { class: 'muted small', style: 'margin-top:4px' }, T.rates.convertHint, ' ', helpBtn('rates-params')),
    convertNote,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn small', onclick: () => { convertMsg = ''; convertNote.textContent = ''; commit(cloneProfile(base)); } }, T.rates.reset)));
  syncInputs(sb());

  // ---------- результаты ----------
  const numbers = h('div');
  const curves = h('div');
  const usage = h('div');
  const man = h('div');
  const cliBox = h('div');
  let destroyers: (() => void)[] = [];
  let manDestroy: (() => void) | null = null;
  const dispose = (): void => { destroyers.forEach((d) => d()); destroyers = []; manDestroy?.(); manDestroy = null; };
  track(dispose);

  // гистограмма ролл+питч для подложки под кривой
  const bins = R.hist.axes[0].length;
  const binW = 100 / bins;
  const rpHist = R.hist.axes[0].map((v, i) => (v + R.hist.axes[1][i]) / 2);
  const rpMax = Math.max(1e-9, ...rpHist);

  const renderNumbers = (p: RateProfile): void => {
    clear(numbers);
    const cell = (a: number, b: number): HTMLElement => h('td', null, `${fmt(a, 0)} → `, h('b', null, fmt(b, 0)),
      Math.abs(b - a) >= 0.5 ? h('span', { class: 'muted small' }, ` (${b > a ? '+' : ''}${fmt(((b - a) / Math.max(1, a)) * 100, 0)} %)`) : null);
    numbers.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.rates.tableTitle, helpBtn('rates-curve')),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, T.rates.col.axis), h('th', null, T.rates.col.center), h('th', null, T.rates.col.p50), h('th', null, T.rates.col.p75), h('th', null, T.rates.col.max))),
        h('tbody', null, [0, 1, 2].map((ax) => h('tr', null, h('td', null, AXIS_NAMES[ax]),
          cell(centerSensitivity(base, ax), centerSensitivity(p, ax)),
          cell(setpointFor(base, ax, 0.5), setpointFor(p, ax, 0.5)),
          cell(setpointFor(base, ax, 0.75), setpointFor(p, ax, 0.75)),
          cell(maxRate(base, ax), maxRate(p, ax))))))));
  };

  const renderCurves = (p: RateProfile): void => {
    destroyers.forEach((d) => d());
    destroyers = [];
    clear(curves);
    const colors = ['--s1', '--s2', '--s4'];
    const c0 = [0, 1, 2].map((ax) => curve(base, ax));
    const c1 = [0, 1, 2].map((ax) => curve(p, ax));
    const x = Float32Array.from(c0[0].x, (v) => v * 100);
    const lines = [0, 1, 2].flatMap((ax) => [
      { label: T.rates.lNow(AXIS_NAMES[ax]), color: colors[ax], data: c0[ax].y, width: 1, dash: [4, 3] },
      { label: T.rates.lNew(AXIS_NAMES[ax]), color: colors[ax], data: c1[ax].y, width: 2 },
    ]);
    const top = Math.max(...[0, 1, 2].flatMap((ax) => [maxRate(base, ax), maxRate(p, ax)]));
    const ch = lineChart({
      title: T.rates.curveAll, help: 'rates-curve', x, lines, height: 320, xRange: [0, 100], yRange: [0, Math.ceil((top * 1.08) / 100) * 100],
      bars: { x: rpHist.map((_, i) => (i + 0.5) * binW), h: rpHist.map((v) => v / rpMax), width: binW, color: '--fg3' },
      note: T.rates.curveNote,
    });
    destroyers.push(ch.destroy);
    curves.append(ch.el);
  };

  // использование стиков — не зависит от примерки, строится один раз
  {
    const hBars = (vals: number[], title: string): HTMLElement => {
      const mx = Math.max(1e-9, ...vals);
      return h('div', { style: 'flex:1;min-width:180px' },
        h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, title),
        h('div', { style: 'display:flex;align-items:flex-end;gap:1px;height:90px;border-bottom:1px solid var(--line)' },
          vals.map((v, i) => h('div', { title: `${(i * binW).toFixed(0)}–${((i + 1) * binW).toFixed(0)} %: ${v.toFixed(1)} % времени`, style: `flex:1;background:var(--s3);opacity:.75;height:${(v / mx) * 100}%` }))),
        h('div', { class: 'muted small', style: 'display:flex;justify-content:space-between' }, h('span', null, '0'), h('span', null, '50'), h('span', null, '100 %')));
    };
    const U = R.usage;
    const urow = (label: string, vals: string[]): HTMLElement => h('tr', null, h('td', null, label), ...vals.map((v) => h('td', null, v)));
    const obs: string[] = [];
    for (let ax = 0; ax < 2; ax++) {
      if (U[ax].fullPct >= C.fullStickSharePct) obs.push(T.rates.obsFull(AXIS_NAMES[ax], U[ax].fullPct));
      else if (U[ax].p99 < C.underusedP99) obs.push(T.rates.obsUnder(AXIS_NAMES[ax], U[ax].p99 * 100));
    }
    usage.append(h('div', { class: 'panel' },
      h('h3', { style: 'margin-top:0' }, T.rates.usageTitle, helpBtn('rates-hist')),
      h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' }, [0, 1, 2].map((ax) => hBars(R.hist.axes[ax], AXIS_NAMES[ax])), hBars(R.hist.throttle, T.rates.throttle)),
      h('div', { class: 'muted small', style: 'margin:4px 0 8px' }, T.rates.histNote(R.seconds)),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, T.rates.uMetric, ' ', helpBtn('rates-usage')), ...AXIS_NAMES.map((n) => h('th', null, n)))),
        h('tbody', null,
          urow(T.rates.uCenter, U.map((u) => `${fmt(u.centerPct, 0)} %`)),
          urow(T.rates.uFull, U.map((u) => `${fmt(u.fullPct, 1)} %`)),
          urow(T.rates.uP99, U.map((u) => `${fmt(u.p99 * 100, 0)} %`)),
          urow(T.rates.uSp99, U.map((u) => `${fmt(u.sp99, 0)} °/с`)),
          urow(T.rates.uSpMax, U.map((u) => `${fmt(u.spMax, 0)} °/с`)))),
      h('ul', { class: 'small', style: 'margin:8px 0 0' }, (obs.length ? obs : [T.rates.obsNone]).map((o) => h('li', null, o)))));
  }

  const renderManeuvers = (): void => {
    manDestroy?.();
    manDestroy = null;
    clear(man);
    const M = R.maneuvers;
    if (!M.length) {
      man.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.rates.manTitle, helpBtn('rates-maneuvers')), h('div', { class: 'muted' }, T.rates.manNone)));
      return;
    }
    const ev = state.ratesEval;
    const sel = Math.min(state.ratesManeuver, M.length - 1);
    const rows = M.map((m, i) => {
      const e = ev?.maneuvers[i];
      return h('tr', { style: `cursor:pointer;${i === sel ? 'background:var(--bg3)' : ''}`, onclick: () => set({ ratesManeuver: i }) },
        h('td', null, `${fmt(m.tPeak, 2)} с`), h('td', null, AXIS_NAMES[m.axis]), h('td', null, `${fmt(m.stick * 100, 0)} %`),
        h('td', null, fmt(Math.abs(m.spWas), 0)), h('td', null, fmt(Math.abs(m.gyroPeak), 0), Math.abs(m.gyroPeak) < C.gyroLagShare * Math.abs(m.spWas) ? h('span', { class: 'badge yellow', title: T.rates.gyroLag }, '!') : null),
        h('td', null, h('b', null, e ? fmt(Math.abs(e.spNew), 0) : '…')),
        h('td', null, `${fmt(Math.abs(m.angleWas), 0)} → `, h('b', null, e ? fmt(Math.abs(e.angleNew), 0) : '…'), h('span', { class: 'muted small' }, ` (гиро ${fmt(Math.abs(m.angleGyro), 0)})`)));
    });
    const m = M[sel];
    const e = ev?.maneuvers[sel];
    const summary = e ? h('p', { style: 'margin:8px 0 0' }, h('b', null, T.rates.manSummary(T.rates.manKind[m.axis], Math.abs(e.spNew), Math.abs(m.spWas))), ' ', T.rates.manAngle(Math.abs(e.angleNew), Math.abs(m.angleWas))) : null;
    const chartBox = h('div');
    man.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.rates.manTitle, helpBtn('rates-maneuvers')),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ...Object.values(T.rates.manCol).map((c) => h('th', null, c)))),
        h('tbody', null, rows)),
      summary,
      h('div', { class: 'muted small', style: 'margin-top:4px' }, T.rates.manNote)), chartBox);
    // график выбранного манёвра
    const pad = 0.4;
    const a = m.axis;
    let alive = true;
    manDestroy = () => { alive = false; };
    fetchSeries([`sp${a}`, `spN${a}`, `gyro${a}`], m.t0 - pad, m.t1 + pad, 900).then((r) => {
      if (!alive) return;
      const ch = lineChart({
        title: T.rates.manChart(AXIS_NAMES[a], m.tPeak), help: 'rates-maneuvers', x: r.x, height: 260,
        lines: [
          { label: T.rates.lGyro, color: '--fg3', data: r.ys[2], width: 1 },
          { label: T.rates.lSpWas, color: '--s1', data: r.ys[0], width: 1.4, dash: [4, 3] },
          { label: T.rates.lSpNew, color: '--s3', data: r.ys[1], width: 2 },
        ],
      });
      chartBox.append(ch.el);
      manDestroy = () => ch.destroy();
    });
  };

  const renderCli = (p: RateProfile): void => {
    clear(cliBox);
    const cli = cliDiff(profileToCli(base), profileToCli(p), R.fwCode);
    const text = cli.lines.join('\n');
    const copyBtn = h('button', { class: 'btn small', onclick: async () => {
      try { await navigator.clipboard.writeText(text); copyBtn.textContent = T.filt.cliCopied; } catch { /* нет доступа к буферу */ }
    } }, T.filt.cliCopy);
    const usb = h('button', { class: 'btn small', onclick: () => fcPrepare(profileToCli(base), profileToCli(p), 'rates') }, T.fc.toBoard);
    cliBox.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.rates.cliTitle, text ? copyBtn : null, text ? usb : null),
      text ? h('pre', { style: 'margin:0;padding:8px;background:var(--bg3);border-radius:6px;overflow:auto' }, text) : h('div', { class: 'muted' }, T.rates.cliEmpty),
      p.type !== base.type ? h('div', { class: 'muted small' }, T.rates.cliTypeNote) : null,
      cli.skipped.length ? h('div', { class: 'muted small' }, cli.skipped.map((s) => `${s.name}: ${s.why}`).join('; ')) : null));
  };

  let lastDrawn: RateProfile | null = null;
  const renderLive = (): void => {
    const p = sb();
    busy.style.visibility = state.ratesBusy ? 'visible' : 'hidden';
    if (lastDrawn && sameProfile(lastDrawn, p)) return;
    lastDrawn = cloneProfile(p);
    renderNumbers(p);
    renderCurves(p);
    renderCli(p);
  };
  const unsub = subscribe((_s, ch) => {
    if (ch.has('ratesSandbox') || ch.has('ratesBusy')) renderLive();
    if (ch.has('ratesEval') || ch.has('ratesManeuver')) renderManeuvers();
  });
  track(unsub);
  renderLive();
  renderManeuvers();

  return h('div', null,
    h('h2', null, T.rates.title, helpBtn('rates-curve')),
    check,
    h('div', { class: 'two' }, controls, numbers),
    curves,
    man,
    cliBox,
    usage,
  );
}

function sameAxis(p: RateProfile, a: number, b: number): boolean {
  const x = p.axes[a], y = p.axes[b];
  return x.rcRate === y.rcRate && x.rate === y.rate && x.expo === y.expo && x.limit === y.limit;
}
