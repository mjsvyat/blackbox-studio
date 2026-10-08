// Вкладка «Автотюн»: полёт → ответы пилота (пропы, моторы, ощущения) → решение по политике
// «не душить» (autotune/autotune.ts поверх советчика) → сохранить в серию и записать на борт по
// USB → слетать → снова «Автотюн». Серия — кампания борта с целью «autotune».

import type { Advice } from '../../advisor/advisor';
import { AutotuneCheckin, FEEL_TAGS, FeelTag, PropsState } from '../../autotune/autotune';
import { campaignSessions } from '../../campaigns/campaign';
import { T } from '../../i18n/ru';
import { cliDiff, cliValue } from '../../params/registry';
import { boardFor } from '../../sessions/boards';
import { h } from '../dom';
import { fcPrepare } from '../fcStore';
import { helpBtn } from '../help';
import { autotuneCampaign, autotuneSave, ensureAdvice, loadSessions, runAutotune, set, state } from '../store';
import { nextFlight } from './campaign';

let loaded = false;
/** черновик ответов пилота (до «Разобрать»), по открытому логу */
let draft: { key: string; props: PropsState | null; temp: AutotuneCheckin['motorTemp'] | null; feel: Set<FeelTag> } | null = null;

const logKey = (): string => `${state.fileName ?? ''}#${state.info?.index ?? ''}`;
const when = (dt: string): string => (dt || '').slice(0, 16).replace('T', ' ');

export function autotuneView(openFile: () => void): HTMLElement {
  if (!loaded) {
    loaded = true;
    void loadSessions();
  }
  const A = T.at;
  const out = h('div', null,
    h('h2', null, A.title, helpBtn('autotune')),
    h('p', { class: 'muted' }, A.intro),
    h('details', { class: 'small' }, h('summary', null, A.principles), h('ul', null, A.rules.map((r) => h('li', null, r)))));

  if (!state.info) {
    out.append(h('div', { class: 'panel' }, h('p', null, A.noLog),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: openFile }, A.openLog), h('button', { class: 'btn', onclick: () => set({ tab: 'fc' }) }, A.toFc))));
    return out;
  }

  // ---------- серия ----------
  const project = boardFor(state.projects, state.info.header);
  const camp = project ? autotuneCampaign(project.id) : null;
  const series = camp ? campaignSessions(camp, state.sessions) : [];
  const at = state.autotune;
  const n = at.ctx?.iteration ?? series.length + 1;
  out.append(h('div', { class: 'panel' }, camp && series.length ? A.series(n, camp.title || A.seriesTitle(project?.name ?? '')) : A.seriesNew));

  // ---------- 1. ответы пилота ----------
  if (!draft || draft.key !== logKey()) {
    const c = at.checkin;
    draft = { key: logKey(), props: c?.props ?? null, temp: c?.motorTemp ?? null, feel: new Set(c?.feel ?? []) };
  }
  const d = draft;
  const radio = <V extends string | number>(name: string, opts: [V, string][], cur: V | null, onPick: (v: V) => void): HTMLElement =>
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, opts.map(([v, label]) =>
      h('button', { class: `btn small ${cur === v ? 'primary' : ''}`, 'aria-pressed': cur === v ? 'true' : 'false', name, onclick: () => { onPick(v); set({ autotune: { ...state.autotune } }); } }, label)));
  const ready = d.props !== null && d.temp !== null;
  const form = h('div', { class: 'panel' },
    h('h3', { style: 'margin-top:0' }, A.step1, helpBtn('autotune-checkin')),
    h('div', { class: 'small muted' }, A.props),
    radio('props', (['ok', 'chipped', 'damaged'] as PropsState[]).map((p) => [p, A.propsOpt[p]]), d.props, (v) => { d.props = v; }),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, A.motors),
    radio('temp', A.temps.map((t, i) => [i as AutotuneCheckin['motorTemp'], t]), d.temp, (v) => { d.temp = v; }),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, A.feelTitle),
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, FEEL_TAGS.map((f) =>
      h('button', { class: `btn small ${d.feel.has(f) ? 'primary' : ''}`, 'aria-pressed': d.feel.has(f) ? 'true' : 'false', onclick: () => { if (d.feel.has(f)) d.feel.delete(f); else d.feel.add(f); set({ autotune: { ...state.autotune } }); } }, A.feel[f]))),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', disabled: !ready || at.busy, onclick: () => { if (ready) void runAutotune({ props: d.props!, motorTemp: d.temp!, feel: [...d.feel] }); } }, at.busy ? A.analyzing : A.analyze),
      ready ? null : h('span', { class: 'muted small' }, A.needAnswers)));
  out.append(form);
  if (at.msg) out.append(h('div', { class: `panel ${at.msg.kind === 'ok' ? '' : 'bad'}` }, at.msg.text));

  // ---------- 2. решение ----------
  const adv = state.advice;
  if (at.ctx && !adv) {
    ensureAdvice();
    out.append(h('div', { class: 'panel muted' }, A.analyzing));
  }
  if (at.ctx && adv?.autotune) {
    const v = adv.autotune.verdict;
    const vt = A.verdict[v];
    const tone = v === 'done' ? 'good' : v === 'props' || v === 'mechanics' || v === 'limit' ? 'bad' : 'warn';
    const chosen = adv.advice.filter((a) => a.kind === 'tune' && a.selected && Object.keys(a.changes).length);
    const kept = adv.advice.filter((a) => a.kind === 'tune' && !a.selected && a.deferred);
    const notes = adv.advice.filter((a) => a.kind !== 'tune' && (a.severity === 'red' || a.id.startsWith('R-AT-') || a.kind === 'mechanic' || a.kind === 'flight'));
    out.append(h('div', { class: `panel ${tone === 'good' ? '' : tone}`, style: tone === 'good' ? 'border-left:4px solid var(--green)' : '' },
      h('h3', { style: 'margin-top:0' }, A.step2, ': ', vt.title, helpBtn('autotune-verdict')),
      h('p', null, vt.text),
      chosen.length ? h('div', null, h('b', null, A.change), chosen.map(changeCard)) : h('div', { class: 'muted' }, A.noChange),
      notes.length ? h('div', { style: 'margin-top:8px' }, h('b', null, A.notes), h('ul', { class: 'small' }, notes.map((a) => h('li', null, h('b', null, T.adv.rules[a.id]?.title ?? a.id), ' — ', T.adv.rules[a.id]?.seen(a.inputs) ?? '', ' ', h('span', { class: 'muted' }, T.adv.rules[a.id]?.change(a.inputs) ?? ''))))) : null,
      kept.length ? h('details', { style: 'margin-top:8px' }, h('summary', null, A.keep, ` (${kept.length})`), h('ul', { class: 'small' }, kept.map((a) => h('li', null, T.adv.rules[a.id]?.title ?? a.id, ' — ', h('span', { class: 'muted' }, T.adv.deferred[a.deferred ?? ''] ?? a.deferred ?? ''))))) : null));

    // ---------- 3. записать и слетать ----------
    const cli = cliDiff(adv.from, adv.to, adv.fwCode);
    const text = cli.lines.join('\n');
    const has = chosen.length > 0 && text.length > 0;
    const copy = h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(text); copy.textContent = T.filt.cliCopied; } catch { /* нет доступа к буферу */ } } }, A.copyCli);
    out.append(h('div', { class: 'panel' },
      h('h3', { style: 'margin-top:0' }, A.step3, helpBtn('autotune-write')),
      has ? h('pre', { class: 'cli small' }, text) : null,
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        has ? h('button', { class: 'btn primary', disabled: at.busy, onclick: async () => { if (await autotuneSave()) fcPrepare(adv.from, adv.to, 'autotune'); } }, A.saveAndWrite) : null,
        h('button', { class: `btn ${has ? '' : 'primary'}`, disabled: at.busy || !!at.savedId, onclick: () => void autotuneSave() }, A.saveOnly),
        has ? copy : null),
      has ? h('div', { class: 'muted small', style: 'margin-top:6px' }, A.writeHint) : null,
      h('p', { class: 'small', style: 'margin-bottom:0' }, A.next)));
    out.append(nextFlight('autotune', project?.uid ?? null));
  }

  // ---------- серия: история ----------
  if (camp) {
    const rows = series.map((r, i) => {
      const m = camp.marks[r.id];
      const s = r.snap;
      const ch = s.plan ? Object.entries(s.plan.to).map(([k, val]) => `${k} → ${cliValue(k, val)}`).join(', ') : '—';
      return h('tr', null, h('td', null, String(i + 1)), h('td', null, when(s.source.datetime), h('div', { class: 'muted small' }, `${s.source.fileName} №${s.source.logIndex}`)),
        h('td', null, m?.props ? A.propsOpt[m.props] : '—'), h('td', null, m?.motorTemp !== null && m?.motorTemp !== undefined ? A.temps[m.motorTemp] : '—'),
        h('td', null, (m?.tags ?? []).map((t) => A.feel[t]).join(', ') || '—'),
        h('td', null, s.autotune ? A.verdictShort[s.autotune.verdict] : '—'), h('td', { class: 'small' }, h('code', null, ch)));
    });
    out.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, A.history),
      rows.length ? h('table', { class: 'grid small' }, h('thead', null, h('tr', null, [A.colN, A.colWhen, A.colProps, A.colTemp, A.colFeel, A.colVerdict, A.colChange].map((x) => h('th', null, x)))), h('tbody', null, rows)) : h('div', { class: 'muted' }, A.noHistory)));
  }
  return out;
}

function changeCard(a: Advice): HTMLElement {
  const t = T.adv.rules[a.id];
  const keys = Object.keys(a.changes);
  return h('div', { class: 'panel', style: 'margin:6px 0' },
    h('div', { class: 'row' }, h('b', { style: 'flex:1' }, t?.title ?? a.id), h('span', { class: 'badge' }, T.adv.rule(a.id, a.version))),
    t ? h('div', { class: 'small' }, t.seen(a.inputs)) : null,
    t ? h('div', { class: 'small muted' }, t.why) : null,
    h('table', { class: 'grid small', style: 'margin:4px 0' }, h('tbody', null, keys.map((k) => h('tr', null,
      h('td', null, h('code', null, k)), h('td', null, a.from[k] !== undefined ? cliValue(k, a.from[k]) : '—'), h('td', null, '→'), h('td', null, h('b', null, cliValue(k, a.changes[k]))))))),
    t ? h('div', { class: 'small' }, T.adv.expect, ': ', t.expect(a.inputs)) : null,
    a.safety ? h('div', { class: 'panel bad small', style: 'margin:6px 0 0' }, T.at.safety) : null);
}
