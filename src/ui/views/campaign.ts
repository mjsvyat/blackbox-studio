// Вкладка «Кампания» (A1–A2): серия полётов борта с целью — лента итераций (предложено →
// применено → вышло), метрики по итерациям, протокол следующего полёта и проверка открытого лога.

import { GOALS, GoalKind, Iteration, ProtocolCheck, campaignSessions, checkProtocol, iterations, metricSeries, protocolNeeds } from '../../campaigns/campaign';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { cliValue } from '../../params/registry';
import { boardFor } from '../../sessions/boards';
import { lineChart } from '../charts/line';
import { fmt, h } from '../dom';
import { lastErase } from '../fcStore';
import { helpBtn } from '../help';
import { createCampaign, deleteCampaign, ensureOpenSnap, loadSessions, set, setMark, state, updateCampaign } from '../store';

let loaded = false;
let boardSel: string | null = null;

/** выбрать борт во вкладке «Кампания» (из переключателя бортов в шапке) */
export function selectBoard(id: string): void {
  boardSel = id;
}

const when = (dt: string): string => (dt || '').slice(0, 16).replace('T', ' ');

export function campaignView(track: (d: () => void) => void): HTMLElement {
  if (!loaded) {
    loaded = true;
    loadSessions();
  }
  const out = h('div', null, h('h2', null, T.camp.title, helpBtn('campaign')), h('p', { class: 'muted' }, T.camp.intro));
  if (!state.projects.length) {
    out.append(h('div', { class: 'panel' }, T.camp.noBoards));
    return out;
  }
  const cur = state.campaigns.find((c) => c.id === state.campaignId) ?? null;
  const openBoard = state.info ? boardFor(state.projects, state.info.header) : null;
  const pid = cur?.projectId ?? boardSel ?? openBoard?.id ?? state.projects.filter((p) => !p.fcMovedTo)[0]?.id ?? state.projects[0].id;
  const project = state.projects.find((p) => p.id === pid)!;

  // ---------- борт и его кампании ----------
  const sel = h('select', { class: 'btn', onchange: (e: Event) => { boardSel = (e.target as HTMLSelectElement).value; set({ campaignId: state.campaigns.find((c) => c.projectId === boardSel && c.status === 'open')?.id ?? null }); } },
    state.projects.map((p) => h('option', { value: p.id, selected: p.id === pid }, p.name)));
  const list = h('div', { class: 'panel' }, h('div', { class: 'row' }, h('b', null, T.camp.board), sel));
  const mine = state.campaigns.filter((c) => c.projectId === pid);
  list.append(h('h3', null, T.camp.list));
  if (!mine.length) list.append(h('div', { class: 'muted' }, T.camp.none));
  for (const c of mine) {
    list.append(h('div', { class: `row camp-item ${c.id === cur?.id ? 'active' : ''}`, onclick: () => set({ campaignId: c.id }) },
      h('b', null, c.title || T.camp.goals[c.goal]), h('span', { class: 'muted small' }, T.camp.goals[c.goal]),
      h('span', { class: `badge ${c.status === 'open' ? '' : 'yellow'}` }, c.status === 'open' ? T.camp.open : T.camp.closed),
      h('span', { class: 'muted small' }, T.camp.flights(c.sessionIds.length))));
  }
  // новая кампания
  const goal = h('select', { class: 'btn' }, GOALS.map((g) => h('option', { value: g }, T.camp.goals[g]))) as HTMLSelectElement;
  const title = h('input', { type: 'text', placeholder: T.camp.titlePh, style: 'flex:1;min-width:220px' }) as HTMLInputElement;
  list.append(h('h3', null, T.camp.newTitle),
    h('div', { class: 'row' }, h('span', null, T.camp.goal), goal, title,
      h('button', { class: 'btn primary', onclick: () => createCampaign(pid, goal.value as GoalKind, title.value.trim()) }, T.camp.create)),
    h('div', { class: 'muted small', style: 'margin-top:4px' }, T.camp.autoAdd));
  out.append(list);
  if (!cur || cur.projectId !== pid) return out;

  // ---------- выбранная кампания ----------
  const its = iterations(cur, state.sessions);
  const inCamp = new Set(cur.sessionIds);
  const free = state.sessions.filter((s) => s.projectId === pid && !inCamp.has(s.id));
  const add = h('select', { class: 'btn', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) updateCampaign({ ...cur, sessionIds: [...cur.sessionIds, v] }); } },
    h('option', { value: '' }, T.camp.add), free.map((s) => h('option', { value: s.id }, `${when(s.snap.source.datetime)} · ${s.snap.source.fileName} №${s.snap.source.logIndex}`)));
  out.append(h('div', { class: 'panel' },
    h('div', { class: 'row' },
      h('h3', { style: 'margin:0;flex:1' }, cur.title || T.camp.goals[cur.goal], h('span', { class: 'muted small', style: 'font-weight:normal' }, ` · ${T.camp.goals[cur.goal]} · ${when(cur.createdAt)}`)),
      free.length ? add : '',
      h('button', { class: 'btn small', onclick: () => updateCampaign({ ...cur, status: cur.status === 'open' ? 'closed' : 'open' }) }, cur.status === 'open' ? T.camp.close : T.camp.reopen),
      h('button', { class: 'btn small', onclick: () => { if (confirm(T.camp.delQ)) deleteCampaign(cur.id); } }, T.camp.del)),
    its.length ? '' : h('p', { class: 'muted' }, T.camp.empty)));

  // метрики по итерациям
  if (its.length) {
    const ser = metricSeries(cur, state.sessions);
    const grid = h('div', { class: 'grid2' });
    const chart = (titleT: string, data: number[], color: string, help: string): void => {
      const ch = lineChart({ title: titleT, help, x: ser.x, lines: [{ label: titleT.split(',')[0], color, data }], height: 170, xRange: [0.8, Math.max(2, ser.x.length) + 0.2] });
      track(ch.destroy);
      grid.append(ch.el);
    };
    chart(T.camp.ch.noise, ser.noiseFilt, '--accent', 'campaign-metrics');
    chart(T.camp.ch.dterm, ser.dterm, '--yellow', 'campaign-metrics');
    chart(T.camp.ch.overshoot, ser.overshoot, '--green', 'campaign-metrics');
    chart(T.camp.ch.delay, ser.delay, '--fg2', 'campaign-metrics');
    if (ser.motorTemp.some((v) => Number.isFinite(v))) chart(T.camp.ch.temp, ser.motorTemp, '--red', 'campaign-metrics');
    out.append(h('h3', null, T.camp.chartsTitle, helpBtn('campaign-metrics')), grid);
  }

  // следующий полёт: протокол и чек-лист
  out.append(nextFlight(cur.goal, project.uid ?? null));

  // открытый лог — проверка по протоколу до сохранения
  if (state.info) {
    const box = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.camp.openCheck, helpBtn('campaign-protocol')));
    if (openBoard?.id !== pid) box.append(h('div', { class: 'muted' }, T.camp.openNotThis));
    else if (!state.openSnap) {
      box.append(h('div', { class: 'muted' }, T.camp.openCheckBusy));
      void ensureOpenSnap();
    } else {
      const last = campaignSessions(cur, state.sessions).filter((s) => s.snap.source.datetime !== state.openSnap!.source.datetime || s.snap.source.fileName !== state.openSnap!.source.fileName).pop();
      box.append(protoBlock(checkProtocol(state.openSnap, last?.snap ?? null, cur.goal)), h('div', { class: 'muted small' }, T.camp.saveHint));
    }
    out.append(box);
  }

  // лента итераций (новые сверху)
  for (const it of [...its].reverse()) out.append(iterCard(it, cur));
  return out;
}

function nextFlight(goal: GoalKind, uid: string | null): HTMLElement {
  const n = protocolNeeds(goal);
  const le = uid ? lastErase(uid) : null;
  return h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, T.camp.nextTitle, helpBtn('campaign-protocol')),
    h('div', { class: 'grid2' },
      h('div', null, h('b', null, T.camp.fly), h('ol', null, T.camp.flyItems(n).map((x) => h('li', null, x)))),
      h('div', null, h('b', null, T.camp.before), h('ul', null, T.camp.beforeItems.map((x) => h('li', null, x))),
        h('div', { class: 'muted small' }, le ? T.camp.lastErase(new Date(le).toLocaleString('ru')) : T.camp.noErase))));
}

function protoBlock(pc: ProtocolCheck): HTMLElement {
  const mark = (s: string): string => (s === 'ok' ? '✓' : s === 'bad' ? '✗' : '—');
  const val = (id: string, v: number | string | null): string => (v === null ? '—' : id === 'comparable' ? T.camp.fairState[String(v)] ?? String(v) : id === 'unfilt' ? (v ? '✓' : '✗') : `${v}${T.camp.unit[id] ?? ''}`);
  const old = pc.items.some((i) => i.id === 'hover' && i.state === 'na');
  return h('div', null,
    h('div', { class: pc.ok ? 'good-text' : 'warn-text' }, pc.ok ? T.camp.protoOk : `${T.camp.protoBad} ${pc.todo.map((t) => T.camp.proto[t]).join(', ')}`),
    old ? h('div', { class: 'muted small' }, T.camp.protoOld) : '',
    h('table', { class: 'grid small proto' }, h('tbody', null, pc.items.map((i) =>
      h('tr', { class: i.state }, h('td', null, mark(i.state)), h('td', null, T.camp.proto[i.id]), h('td', null, val(i.id, i.have)), h('td', { class: 'muted' }, i.id === 'unfilt' || i.need === null ? '' : `≥ ${val(i.id, i.need)}`))))),
    pc.fair && pc.fair.warnings.length ? h('ul', { class: 'small' }, pc.fair.warnings.map((w) => h('li', null, T.ses.warn[w]))) : '');
}

function iterCard(it: Iteration, c: Parameters<typeof setMark>[0]): HTMLElement {
  const s = it.session.snap;
  const unfair = it.protocol.fair?.status === 'red';
  const temp = h('select', { class: 'btn small', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; setMark(c, it.session.id, { motorTemp: v === '' ? null : (Number(v) as 0 | 1 | 2 | 3), feel: it.mark?.feel ?? '' }); } },
    h('option', { value: '', selected: it.mark?.motorTemp === null || it.mark === null }, T.camp.tempNone),
    T.camp.temps.map((t, i) => h('option', { value: i, selected: it.mark?.motorTemp === i }, t)));
  const feel = h('input', { type: 'text', value: it.mark?.feel ?? '', placeholder: T.camp.feelPh, style: 'flex:1;min-width:200px' }) as HTMLInputElement;
  feel.addEventListener('change', () => setMark(c, it.session.id, { motorTemp: it.mark?.motorTemp ?? null, feel: feel.value }));

  const proposed = it.prev
    ? it.proposed
      ? h('div', null, h('code', { class: 'small' }, it.proposed.rules.join(', ')), h('pre', { class: 'cli small' }, Object.entries(it.proposed.to).map(([k, v]) => `set ${k} = ${cliValue(k, v)}`).join('\n')))
      : h('span', { class: 'muted' }, T.camp.nothingProposed)
    : h('span', { class: 'muted' }, T.camp.first);
  const ap = it.applied;
  const applied = ap
    ? h('div', null, h('span', { class: `badge ${ap.state === 'applied' ? '' : ap.state === 'none' ? '' : 'yellow'}` }, T.camp.planState[ap.state]), ap.extra.length ? h('span', { class: 'muted small' }, ` ${T.camp.extra(ap.extra.length)}`) : '')
    : h('span', { class: 'muted' }, '—');
  const vmark = (v: string): HTMLElement => h('span', { style: `color:var(${v === 'better' ? '--green' : v === 'worse' ? '--red' : '--fg2'})` }, T.ses.verdict[v] || '—');
  const result = it.prev
    ? h('div', null,
        unfair ? h('div', { class: 'warn-text small' }, T.camp.unfair) : '',
        h('table', { class: 'grid small' }, h('tbody', null, it.rows.map((r) => h('tr', null,
          h('td', null, T.ses.m[r.id] ?? r.id, r.axis !== undefined ? `, ${AXIS_NAMES[r.axis]}` : ''),
          h('td', null, `${fmt(r.a, r.digits)} → ${fmt(r.b, r.digits)}${r.unit}`), h('td', null, vmark(r.verdict)))))))
    : h('span', { class: 'muted' }, T.camp.first);

  return h('div', { class: 'panel iter' },
    h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, T.camp.iter(it.n)),
      h('span', { class: 'muted' }, `${when(s.source.datetime)} · ${s.source.fileName} №${s.source.logIndex}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => updateCampaign({ ...c, sessionIds: c.sessionIds.filter((x) => x !== it.session.id) }) }, T.camp.remove)),
    h('div', { class: 'grid3' },
      h('div', null, h('b', null, T.camp.proposed), proposed),
      h('div', null, h('b', null, T.camp.applied), applied),
      h('div', null, h('b', null, T.camp.result), result)),
    h('details', null, h('summary', null, T.camp.protoTitle, ' ', it.protocol.ok ? '✓' : `✗ ${it.protocol.todo.length}`), protoBlock(it.protocol)),
    h('div', { class: 'row', style: 'margin-top:6px' }, h('span', null, T.camp.markTitle), temp, feel));
}
