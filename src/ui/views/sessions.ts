// Вкладка «Сессии и сравнение»: сохранить открытый лог как сессию; борта и сессии
// (IndexedDB), экспорт/импорт; сравнение «было / прогноз / стало» с проверкой честности,
// применённым планом, метриками, спектрами, step response и шумом по бинам газа.

import { AXIS_NAMES, T } from '../../i18n/ru';
import { cliValue } from '../../params/registry';
import { binNoise, comparability, headerDiff, metricRows, planCheck, predictedSpectrum, predictionAccuracy } from '../../sessions/compare';
import type { SessionRecord } from '../../sessions/db';
import type { SessionSnapshot } from '../../sessions/snapshot';
import { lineChart } from '../charts/line';
import { fmt, fmtTime, h } from '../dom';
import { helpBtn } from '../help';
import { incidentForm, journal, profilePanel, rollbackPanel } from './incidents';
import {
  deleteProject, deleteSession, exportProject, exportReport, importProject, loadSessions, moveFcToNewFrame, renameProject, resolveBoardAsk, saveCurrentSession, set, state,
  updateSessionNotes,
} from '../store';
import { legacyKey } from '../../sessions/boards';
import { fcDownloadBackup } from '../fcStore';

let loaded = false;
let showDiff = false;

const when = (s: SessionSnapshot): string => (s.source.datetime || '').slice(0, 16).replace('T', ' ');

export function sessionsView(track: (d: () => void) => void): HTMLElement {
  if (!loaded) {
    loaded = true;
    loadSessions();
  }
  const out = h('div', null, h('h2', null, T.ses.title, helpBtn('sessions')));
  if (state.dbPersistent === false) out.append(h('div', { class: 'panel warn' }, T.ses.noDb));
  if (state.sessionsMsg) out.append(h('div', { class: 'panel' }, state.sessionsMsg));

  // ---------- сохранить открытый лог ----------
  const notes = h('input', { type: 'text', placeholder: T.ses.notesPh, style: 'flex:1;min-width:240px' }) as HTMLInputElement;
  out.append(h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, T.ses.current),
    state.info
      ? h('div', { class: 'row' }, notes, h('button', { class: 'btn primary', disabled: state.sessionsBusy, onclick: () => saveCurrentSession(notes.value) }, state.sessionsBusy ? T.ses.saving : T.ses.save))
      : h('div', { class: 'muted' }, T.ses.noLog),
    h('div', { class: 'muted small', style: 'margin-top:6px' }, T.ses.whatSaved)));
  if (state.boardAsk) out.append(boardAskPanel());

  // ---------- борта и сессии ----------
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
  fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) importProject(f); fileIn.value = ''; });
  const list = h('div', { class: 'panel' },
    h('div', { class: 'row' }, h('h3', { style: 'margin:0;flex:1' }, T.ses.projects), h('button', { class: 'btn small', onclick: () => fileIn.click() }, T.ses.import), fileIn));
  if (!state.projects.length) list.append(h('div', { class: 'muted' }, T.ses.noProjects));
  for (const p of state.projects) {
    const ss = state.sessions.filter((s) => s.projectId === p.id);
    list.append(h('div', { style: 'margin-top:10px' },
      h('div', { class: 'row' },
        h('b', { style: 'flex:1' }, p.name, h('span', { class: 'muted small' }, ` · ${ss.length}`),
          h('span', { class: 'muted small', style: 'font-weight:normal' }, ' · ', p.uid ? T.board.uid(p.uid) : T.board.noUid),
          p.sameFcAs ? h('span', { class: 'badge', style: 'margin-left:6px' }, T.board.sameFc(state.projects.find((x) => x.id === p.sameFcAs)?.name ?? '?')) : '',
          p.fcMovedTo ? h('span', { class: 'badge yellow', style: 'margin-left:6px' }, T.board.movedTo(state.projects.find((x) => x.id === p.fcMovedTo)?.name ?? '?')) : '',
          helpBtn('board-key')),
        h('button', { class: 'btn small', onclick: () => { const n = prompt(T.ses.rename, p.name); if (n) renameProject(p, n); } }, T.ses.rename),
        p.uid && !p.fcMovedTo ? h('button', { class: 'btn small', onclick: () => { const n = prompt(T.board.moveQ, T.board.moveName(p.name)); if (n) moveFcToNewFrame(p.id, n); } }, T.board.moveBtn) : '',
        h('button', { class: 'btn small', onclick: () => exportProject(p) }, T.ses.export),
        h('button', { class: 'btn small', onclick: () => { if (confirm(T.ses.delProjectQ)) deleteProject(p.id); } }, T.ses.del)),
      h('table', { class: 'grid small' },
        h('thead', null, h('tr', null, ...Object.values(T.ses.col).map((c) => h('th', null, c)), h('th', null, ''))),
        h('tbody', null, ss.map((r) => row(r)))),
      profilePanel(p),
      journal(p)));
  }
  if (state.sessions.length) list.append(h('div', { class: 'muted small', style: 'margin-top:6px' }, T.ses.pickHint));
  out.append(list);
  if (state.incidentForm) out.append(incidentForm(state.incidentForm));
  if (state.rollbackFor) out.append(rollbackPanel(state.rollbackFor));

  // ---------- сравнение ----------
  const A = state.sessions.find((s) => s.id === state.cmpA);
  const B = state.sessions.find((s) => s.id === state.cmpB);
  if (A && B && A.id !== B.id) out.append(compareBlock(A, B, track));
  return out;
}

/** «это новый борт или существующий?» — выбор пилота перед сохранением сессии */
function boardAskPanel(): HTMLElement {
  const a = state.boardAsk!;
  const cands = a.candidates.map((id) => state.projects.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const first = cands[0];
  const why =
    a.reason === 'craft-changed' && first ? T.board.askCraft(first.name, a.key.craft)
    : a.reason === 'legacy' ? T.board.askLegacy(cands.filter((p) => !p.uid).map((p) => `«${p.name}»`).join(', '))
    : a.reason === 'several' ? T.board.askSeveral
    : T.board.askNew(a.key.uid, legacyKey(a.key));
  // по умолчанию: тот же UID с другим именем — «переименовал»; старый борт без UID — «это он»; иначе — новый
  let pick: 'new' | 'existing' | 'moved' = a.reason === 'new' ? 'new' : 'existing';
  const name = h('input', { type: 'text', value: a.key.craft || legacyKey(a.key), placeholder: T.board.namePh, style: 'min-width:220px' }) as HTMLInputElement;
  const sel = h('select', { class: 'btn' }, cands.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
  const opt = (v: typeof pick, label: string, extra: HTMLElement | null): HTMLElement =>
    h('label', { class: 'row', style: 'margin:4px 0' }, h('input', { type: 'radio', name: 'board-ask', checked: pick === v, onchange: () => { pick = v; } }), label, extra ?? '');
  const opts: HTMLElement[] = [];
  if (a.reason === 'craft-changed' && first) {
    opts.push(opt('existing', T.board.optRenamed, null), opt('moved', T.board.optMoved, null));
  } else {
    if (cands.length) opts.push(opt('existing', T.board.optExisting, sel));
    opts.push(opt('new', T.board.optNew, null));
  }
  return h('div', { class: 'panel warn' },
    h('h3', { style: 'margin-top:0' }, T.board.askTitle, helpBtn('board-key')),
    h('p', null, why, a.key.uid ? h('span', { class: 'muted small' }, ` (${T.board.uid(a.key.uid)})`) : ''),
    ...opts,
    h('div', { class: 'row', style: 'margin-top:8px' }, name,
      h('button', { class: 'btn primary', onclick: () => {
        const nm = name.value.trim() || legacyKey(a.key);
        if (pick === 'new') resolveBoardAsk({ kind: 'new', name: nm });
        else if (pick === 'moved' && first) resolveBoardAsk({ kind: 'moved', id: first.id, name: nm });
        else resolveBoardAsk({ kind: 'existing', id: a.reason === 'craft-changed' && first ? first.id : sel.value });
      } }, T.board.save),
      h('button', { class: 'btn', onclick: () => resolveBoardAsk({ kind: 'cancel' }) }, T.board.cancel)),
    h('div', { class: 'muted small' }, T.board.nameHint));
}

function row(r: SessionRecord): HTMLElement {
  const s = r.snap;
  const dots = h('span', null, s.cards.map((c) => h('span', { class: `dot ${c.status}`, title: c.phrase, style: 'margin-right:2px' })));
  const nt = h('input', { type: 'text', value: r.notes, style: 'width:100%;min-width:160px' }) as HTMLInputElement;
  nt.addEventListener('change', () => updateSessionNotes(r, nt.value));
  const radio = (k: 'cmpA' | 'cmpB'): HTMLElement => h('input', { type: 'radio', name: k, checked: state[k] === r.id, onchange: () => set({ [k]: r.id }) });
  return h('tr', null,
    h('td', null, when(s)),
    h('td', null, `${s.source.fileName} №${s.source.logIndex}`),
    h('td', null, fmtTime(s.source.durationS)),
    h('td', null, s.source.firmware.replace(/^Betaflight /, '').replace(/ \(.*$/, '')),
    h('td', null, dots),
    h('td', null, s.plan ? h('span', { title: s.plan.ruleIds.join(', ') }, T.ses.planRules(Object.keys(s.plan.to).length)) : '—'),
    h('td', null, nt),
    h('td', null, radio('cmpA')),
    h('td', null, radio('cmpB')),
    h('td', { style: 'white-space:nowrap' },
      h('button', { class: 'btn small', title: T.inc.report, onclick: () => set({ incidentForm: r.id }) }, '⚠'),
      h('button', { class: 'btn small', title: T.rep.button, onclick: () => exportReport(r.snap) }, '📄'),
      h('button', { class: 'btn small', title: T.inc.rollbackTitle, onclick: () => set({ rollbackFor: state.rollbackFor === r.id ? null : r.id }) }, '↩'),
      r.fcLog?.length ? h('button', { class: 'btn small', title: T.fc.sessionLog(r.fcLog.map((e) => `${e.at.slice(0, 16).replace('T', ' ')} ${e.kind} ${e.ok ? '✓' : '✗'}: ${e.lines.join('; ')}`).join('\n')), onclick: () => { const e = r.fcLog!.at(-1)!; fcDownloadBackup(e.diffAll, `diff_all_before_${e.at.slice(0, 19).replace(/[:T]/g, '-')}.txt`); } }, '💾') : '',
      h('button', { class: 'btn small', onclick: () => { if (confirm(T.ses.delSessionQ)) deleteSession(r.id); } }, '×')));
}

function compareBlock(Ar: SessionRecord, Br: SessionRecord, track: (d: () => void) => void): HTMLElement {
  const a = Ar.snap, b = Br.snap;
  const box = h('div', null, h('h2', null, T.ses.cmpTitle, helpBtn('compare'), h('button', { class: 'btn small', style: 'margin-left:8px', onclick: () => exportReport(b, a) }, T.rep.button)),
    h('div', { class: 'muted' }, `${T.ses.was}: ${when(a)} · ${a.source.fileName} №${a.source.logIndex}${Ar.notes ? ` — ${Ar.notes}` : ''}`),
    h('div', { class: 'muted', style: 'margin-bottom:8px' }, `${T.ses.now}: ${when(b)} · ${b.source.fileName} №${b.source.logIndex}${Br.notes ? ` — ${Br.notes}` : ''}`));

  // ---------- честность ----------
  const cmp = comparability(a, b);
  box.append(h('div', { class: `panel ${cmp.status === 'green' ? '' : cmp.status === 'yellow' ? 'warn' : 'bad'}` },
    h('h3', { style: 'margin-top:0' }, h('span', { class: `dot ${cmp.status}` }), T.ses.honestTitle, helpBtn('compare-honesty')),
    h('div', null, T.ses.overlap(cmp.thrOverlap), ' · ', T.ses.stick(cmp.stickRatio.map((x) => fmt(x, 2)).join(' / ')), cmp.cellVDiff !== null ? [' · ', T.ses.volt(cmp.cellVDiff)] : null),
    cmp.warnings.length ? h('ul', null, cmp.warnings.map((w) => h('li', null, T.ses.warn[w]))) : null,
    h('details', null, h('summary', { class: 'small' }, T.ses.binsTitle),
      h('table', { class: 'grid small' }, h('tbody', null,
        h('tr', null, h('td', null, 'газ, %'), ...cmp.bins.map((x) => h('td', null, fmt(x.pct, 0)))),
        h('tr', null, h('td', null, T.ses.was), ...cmp.bins.map((x) => h('td', null, fmt(x.aS, 0)))),
        h('tr', null, h('td', null, T.ses.now), ...cmp.bins.map((x) => h('td', null, fmt(x.bS, 0)))),
        h('tr', null, h('td', null, ''), ...cmp.bins.map((x) => h('td', null, h('span', { class: `dot ${x.ok ? 'green' : 'grey'}`, title: x.ok ? T.ses.binOk : T.ses.binNo })))))))));

  // ---------- план ----------
  const pc = planCheck(a, b);
  const planBox = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.ses.planTitle, helpBtn('compare-plan')));
  if (!pc.items.length) planBox.append(h('div', { class: 'muted' }, T.ses.noPlan));
  else {
    planBox.append(
      h('div', null, h('b', null, T.ses.planAll[pc.state])),
      h('table', { class: 'grid small' }, h('tbody', null, pc.items.map((i) => h('tr', null,
        h('td', null, h('code', null, i.key)), h('td', null, i.from !== undefined ? cliValue(i.key, i.from) : '—'), h('td', null, '→ ', cliValue(i.key, i.planned)),
        h('td', null, `${T.ses.now}: `, i.actual !== undefined ? cliValue(i.key, i.actual) : '—'),
        h('td', null, h('span', { class: `badge ${i.state === 'applied' ? '' : 'yellow'}` }, T.ses.planState[i.state])))))),
      h('div', { class: 'small', style: 'margin-top:6px' }, T.ses.rulesTitle, ': ', pc.rules.map((r) => `${r.rule} — ${T.ses.planState[r.state]}`).join('; ')));
  }
  if (pc.extra.length) planBox.append(h('h4', { style: 'margin:10px 0 2px' }, T.ses.extraTitle),
    h('div', { class: 'muted small' }, T.ses.extraNote),
    h('table', { class: 'grid small' }, h('tbody', null, pc.extra.map((x) => h('tr', null, h('td', null, h('code', null, x.key)), h('td', null, x.a !== undefined ? cliValue(x.key, x.a) : '—'), h('td', null, '→'), h('td', null, h('b', null, x.b !== undefined ? cliValue(x.key, x.b) : '—')))))));
  box.append(planBox);

  // ---------- метрики ----------
  const rows = metricRows(a, b);
  const acc = predictionAccuracy(rows);
  box.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.ses.metricsTitle, helpBtn('compare-metrics')),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, T.ses.colMetric), h('th', null, T.ses.was), h('th', null, T.ses.pred), h('th', null, T.ses.now), h('th', null, T.ses.colDelta), h('th', null, ''))),
      h('tbody', null, rows.map((r) => {
        const d = r.b - r.a;
        return h('tr', null,
          h('td', null, T.ses.m[r.id] ?? r.id, r.axis !== undefined ? `, ${AXIS_NAMES[r.axis]}` : '', r.flightDependent ? ' *' : ''),
          h('td', null, `${fmt(r.a, r.digits)}${r.unit}`),
          h('td', { style: 'font-style:italic' }, r.pred !== undefined ? `${fmt(r.pred, r.digits)}${r.unit}` : '', r.band ? h('span', { class: 'muted small' }, ` (${fmt(r.band.lo, r.digits)}–${fmt(r.band.hi, r.digits)})`) : null),
          h('td', null, h('b', null, `${fmt(r.b, r.digits)}${r.unit}`)),
          h('td', null, Number.isFinite(d) ? `${d > 0 ? '+' : ''}${fmt(d, r.digits)}` : '—'),
          h('td', { style: `color:var(${r.verdict === 'better' ? '--green' : r.verdict === 'worse' ? '--red' : '--fg2'})` }, T.ses.verdict[r.verdict]));
      }))),
    h('div', { class: 'muted small' }, T.ses.flightDep),
    h('div', { style: 'margin-top:4px' }, acc.n ? T.ses.accuracy(acc.n, acc.medianErrPct) : T.ses.accuracyNone, ' ', helpBtn('compare-prediction')),
    a.plan?.filters ? h('div', { class: 'muted small' }, pc.state === 'applied' || pc.state === 'partial' ? T.ses.predNote : T.ses.predNotApplied) : null));

  // ---------- графики ----------
  const ax = state.cmpAxis;
  const axisCtl = h('div', { class: 'seg-ctl' }, AXIS_NAMES.map((n, i) => h('button', { class: i === ax ? 'on' : '', onclick: () => set({ cmpAxis: i }) }, n)));
  box.append(h('div', { class: 'row', style: 'margin:6px 0 10px' }, T.ses.axis, axisCtl));
  const charts = h('div');
  box.append(charts);
  const spec = (title: string, help: string, da: number[] | null, db: number[] | null, pr: number[] | null, df: number, nyq: number): void => {
    if (!da || !db) return;
    const n = Math.min(da.length, db.length, Math.floor(nyq / df));
    const x = Float32Array.from({ length: n }, (_, i) => i * df);
    const ch = lineChart({
      title, help, x, xRange: [2, nyq], height: 260,
      lines: [
        { label: T.ses.was, color: '--fg2', data: da.slice(0, n), width: 1.2 },
        { label: T.ses.pred, color: '--s3', data: pr ? pr.slice(0, n) : null, width: 1.4, dash: [6, 4] },
        { label: T.ses.now, color: '--s1', data: db.slice(0, n), width: 1.8 },
      ],
    });
    track(ch.destroy);
    charts.append(ch.el);
  };
  const nyq = Math.min(a.noise.nyquist, b.noise.nyquist);
  const usePred = pc.state === 'applied' || pc.state === 'partial';
  spec(T.ses.specTitle(AXIS_NAMES[ax]), 'chart-filter-spectrum', a.noise.axes[ax].filtDb, b.noise.axes[ax].filtDb, usePred ? predictedSpectrum(a, ax, 'gyro') : null, a.noise.df, nyq);
  if (ax < 2) spec(T.ses.dSpecTitle(AXIS_NAMES[ax]), 'metric-dterm', a.noise.axes[ax].dtermDb, b.noise.axes[ax].dtermDb, usePred ? predictedSpectrum(a, ax, 'dterm') : null, a.noise.df, nyq);
  const sa = a.pid?.axes[ax], sb = b.pid?.axes[ax];
  if (sa?.t.length && sb?.t.length) {
    const n = Math.min(sa.t.length, sb.t.length);
    const ch = lineChart({
      title: T.ses.stepTitle(AXIS_NAMES[ax]), help: 'pid-step', x: sa.t.slice(0, n).map((v) => v * 1000), height: 240, yRange: [0, 1.6],
      lines: [
        { label: `${T.ses.was}${sa.enough ? '' : ' (?)'}`, color: '--fg2', data: sa.mean.slice(0, n), width: 1.2 },
        { label: `${T.ses.now}${sb.enough ? '' : ' (?)'}`, color: '--s1', data: sb.mean.slice(0, n), width: 1.8 },
      ],
      hline: { y: 1, label: '1.0', color: '--fg3' },
      note: T.ses.stepPredLater,
    });
    track(ch.destroy);
    charts.append(ch.el);
  }
  const bn = binNoise(a, b, ax);
  if (bn.length >= 2) {
    const ch = lineChart({
      title: T.ses.binChart(AXIS_NAMES[ax]), help: 'compare-honesty', x: bn.map((x) => x.pct), height: 200,
      lines: [{ label: T.ses.was, color: '--fg2', data: bn.map((x) => x.a), width: 1.2 }, { label: T.ses.now, color: '--s1', data: bn.map((x) => x.b), width: 1.8 }],
    });
    track(ch.destroy);
    charts.append(ch.el);
  }

  // ---------- diff заголовков ----------
  const diff = headerDiff(a.header, b.header);
  const diffBody = h('div', { style: showDiff ? '' : 'display:none' },
    diff.length ? h('table', { class: 'grid small' }, h('tbody', null, diff.map((d) => h('tr', null, h('td', null, h('code', null, d.key)), h('td', null, d.a ?? '—'), h('td', null, '→'), h('td', null, h('b', null, d.b ?? '—'))))))
      : h('div', { class: 'muted' }, T.ses.diffNone));
  box.append(h('div', { class: 'panel' },
    h('button', { class: 'btn small', onclick: (e: Event) => { showDiff = !showDiff; diffBody.style.display = showDiff ? '' : 'none'; (e.target as HTMLElement).textContent = `${T.ses.diffTitle(diff.length)} ${showDiff ? '▾' : '▸'}`; } }, `${T.ses.diffTitle(diff.length)} ${showDiff ? '▾' : '▸'}`),
    helpBtn('compare-diff'), diffBody));
  return box;
}
