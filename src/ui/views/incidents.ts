// Журнал инцидентов в UI: форма «сообщить о проблеме», случаи борта с авторазбором,
// откат (у серьёзных — первым), экспорт папки случая, профиль борта, статистика правил.

import { CLASSES, classInfo } from '../../config/classes';
import { normalizeProfile } from '../../sessions/profile';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { Incident, SYMPTOMS, Symptom, autoAnalyze, isSevere, lastGood, predictionHistory, rollbackCli, ruleStats } from '../../incidents/incidents';
import type { Project, SessionRecord } from '../../sessions/db';
import { fmt, h } from '../dom';
import { helpBtn } from '../help';
import { exportCase, saveIncident, saveProfile, set, state, updateIncident } from '../store';

const when = (s: SessionRecord): string => (s.snap.source.datetime || s.savedAt).slice(0, 16).replace('T', ' ');

export function incidentForm(sessionId: string): HTMLElement {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return h('div');
  const checks = SYMPTOMS.map((k) => h('label', { class: 'small', style: 'display:inline-flex;gap:4px;margin-right:12px' }, h('input', { type: 'checkbox', value: k }), T.case.symptom[k]));
  const text = h('textarea', { rows: 3, placeholder: T.inc.textPh, style: 'width:100%' }) as HTMLTextAreaElement;
  const tLog = h('input', { type: 'number', step: 0.1, min: 0, style: 'width:90px' }) as HTMLInputElement;
  const sev = h('select', { class: 'btn small' }, [1, 2, 3].map((v) => h('option', { value: v, selected: v === 2 }, T.inc.sev[v]))) as HTMLSelectElement;
  const temp = h('select', { class: 'btn small' }, h('option', { value: '' }, '—'), T.case.temp.map((t, i) => h('option', { value: i }, t))) as HTMLSelectElement;
  const media = h('input', { type: 'text', style: 'width:100%' }) as HTMLInputElement;
  const save = (): void => {
    const symptoms = checks.map((c) => c.querySelector('input') as HTMLInputElement).filter((c) => c.checked).map((c) => c.value as Symptom);
    saveIncident({
      sessionId, symptoms: symptoms.length ? symptoms : ['other'], text: text.value, tLog: tLog.value === '' ? null : Number(tLog.value),
      severity: Number(sev.value) as 1 | 2 | 3, motorTemp: temp.value === '' ? null : (Number(temp.value) as 0 | 1 | 2 | 3), media: media.value,
    });
  };
  return h('div', { class: 'panel warn' },
    h('h3', { style: 'margin-top:0' }, T.inc.formTitle, ` — ${when(s)}`, helpBtn('incidents')),
    h('div', null, h('b', { class: 'small' }, T.inc.symptoms), h('div', null, checks)),
    h('div', { style: 'margin:6px 0' }, h('b', { class: 'small' }, T.inc.text), text),
    h('div', { class: 'row small' }, T.inc.tLog, tLog, T.inc.severity, sev, T.inc.motorTemp, temp),
    h('div', { class: 'small', style: 'margin:6px 0' }, T.inc.media, media),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, T.inc.save), h('button', { class: 'btn small', onclick: () => set({ incidentForm: null }) }, T.inc.cancel)));
}

export function rollbackPanel(sessionId: string): HTMLElement {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return h('div');
  const good = lastGood(s, state.sessions, state.incidents);
  const box = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.inc.rollbackTitle, ` — ${when(s)}`, helpBtn('rollback')));
  if (!good) return box.appendChild(h('div', { class: 'muted' }, T.inc.rollbackNone)), box;
  const cli = rollbackCli(s.snap, good.snap);
  box.append(cli.lines.length ? cliBlock(cli.lines, T.inc.rollbackNote(when(good))) : h('div', { class: 'muted' }, T.inc.rollbackSame));
  return box;
}

function cliBlock(lines: string[], note: string): HTMLElement {
  const text = lines.join('\n');
  const btn = h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(text); btn.textContent = T.filt.cliCopied; } catch { /* нет доступа */ } } }, T.filt.cliCopy);
  return h('div', null, h('div', { class: 'muted small' }, note, ' ', btn), h('pre', { style: 'margin:4px 0;padding:8px;background:var(--bg3);border-radius:6px;overflow:auto' }, text));
}

export function journal(p: Project): HTMLElement | null {
  const list = state.incidents.filter((i) => i.projectId === p.id);
  if (!list.length) return null;
  return h('div', { style: 'margin-top:8px' }, h('h4', { style: 'margin:8px 0 4px' }, T.inc.title, helpBtn('incidents')), list.map(incidentCard));
}

function incidentCard(i: Incident): HTMLElement {
  const after = state.sessions.find((s) => s.id === i.sessionId);
  const before = i.beforeId ? state.sessions.find((s) => s.id === i.beforeId) : undefined;
  const good = after ? lastGood(after, state.sessions, state.incidents) : null;
  const rb = after && good ? rollbackCli(after.snap, good.snap) : null;
  const severe = isSevere(i);
  const rollbackEl = rb?.lines.length ? h('div', { class: severe ? 'panel bad' : '' }, severe ? h('b', null, T.inc.severeFirst) : h('b', { class: 'small' }, T.inc.rollbackTitle), cliBlock(rb.lines, T.inc.rollbackNote(good ? when(good) : ''))) : null;
  const auto = before && after ? autoAnalyze(before.snap, after.snap, i) : null;
  const res = h('textarea', { rows: 2, placeholder: T.inc.resolutionPh, style: 'width:100%' }) as HTMLTextAreaElement;
  res.value = i.resolution;
  res.addEventListener('change', () => updateIncident({ ...i, resolution: res.value }));
  return h('details', { class: 'panel', open: i.status === 'open' },
    h('summary', null, h('b', null, i.id), ` · ${i.createdAt.slice(0, 10)} · `, i.symptoms.map((s) => T.case.symptom[s]).join(', '), ` · ${i.severity}/3 · `,
      h('span', { class: `badge ${i.status === 'open' ? 'yellow' : ''}` }, i.status === 'open' ? T.inc.open : T.inc.resolved)),
    severe ? rollbackEl : null,
    i.text ? h('p', null, i.text) : null,
    auto ? h('div', { class: 'small' },
      h('b', null, T.inc.auto, ': '), T.case.planState[auto.plan.state], auto.extraChanged.length ? ` · ${T.case.extra}: ${auto.extraChanged.join(', ')}` : '',
      h('ul', { style: 'margin:4px 0' }, auto.findings.map((f) => h('li', null, T.case.sign[f.sign], f.axis !== undefined ? ` (${AXIS_NAMES[f.axis]})` : '', f.hz !== undefined ? ` ${f.hz} Гц` : f.a !== undefined ? `: ${fmt(f.a, 2)} → ${fmt(f.b, 2)}` : '', f.rules ? `: ${f.rules.join(', ')}` : ''))),
      h('div', null, h('b', null, T.inc.suspects, ': '), auto.suspects.length ? auto.suspects.map((s) => `${s.rule} (${s.score})`).join(', ') : T.case.noSuspects))
      : h('div', { class: 'muted small' }, T.inc.noBefore),
    severe ? null : rollbackEl,
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('button', { class: 'btn small primary', onclick: () => exportCase(i) }, T.inc.export),
      i.status === 'open' ? h('button', { class: 'btn small', onclick: () => updateIncident({ ...i, status: 'resolved', resolution: res.value }) }, T.inc.resolve) : null),
    h('div', { class: 'muted small' }, T.inc.exportNote),
    res);
}

export function profilePanel(p: Project): HTMLElement {
  // структурированный профиль (E2.2); старый текст — подсказкой
  const pr = normalizeProfile(p.profile);
  const lbl = (text: string, el: HTMLElement): HTMLElement => h('label', { class: 'small', style: 'display:inline-flex;gap:4px;align-items:center;margin-right:10px' }, text, el);
  const field = (k: 'frame' | 'notes'): HTMLElement => {
    const el = h('input', { type: 'text', value: pr[k] ?? '', style: 'width:140px' }) as HTMLInputElement;
    el.addEventListener('change', () => saveProfile(p, { ...pr, [k]: el.value }));
    return lbl(T.inc.profile[k], el);
  };
  const numField = (k: 'cells' | 'kvRating' | 'weightG', text: string): HTMLElement => {
    const el = h('input', { type: 'number', value: pr[k] ?? '', style: 'width:80px', min: 0 }) as HTMLInputElement;
    el.addEventListener('change', () => saveProfile(p, { ...pr, [k]: el.value === '' ? undefined : Number(el.value) }));
    return lbl(text, el);
  };
  const ci = classInfo(pr.cls);
  const clsSel = h('select', { class: 'btn small', onchange: (e: Event) => saveProfile(p, { ...pr, cls: (e.target as HTMLSelectElement).value || undefined }) },
    h('option', { value: '', selected: !pr.cls }, T.cls.none),
    CLASSES.map((c) => h('option', { value: c, selected: pr.cls === c }, T.cls.names[c])));
  const oldText = [pr.props, pr.kv, pr.weight].filter(Boolean).join(' · ');
  const ds = h('input', { type: 'checkbox', checked: !!pr.dSensitive }) as HTMLInputElement;
  ds.addEventListener('change', () => saveProfile(p, { ...pr, dSensitive: ds.checked }));
  const dis = h('input', { type: 'text', value: (pr.disabledRules ?? []).join(', '), style: 'width:260px' }) as HTMLInputElement;
  dis.addEventListener('change', () => saveProfile(p, { ...pr, disabledRules: dis.value.split(/[,\s]+/).filter(Boolean) }));
  const sessions = state.sessions.filter((s) => s.projectId === p.id);
  const stats = Object.entries(ruleStats(sessions, state.incidents.filter((i) => i.projectId === p.id)));
  const ph = predictionHistory(sessions);
  return h('details', { style: 'margin-top:6px' }, h('summary', { class: 'small' }, T.inc.profileTitle, ' ', helpBtn('board-profile')),
    h('div', { style: 'margin:6px 0' }, lbl(T.cls.title, clsSel), helpBtn('board-class'), numField('cells', T.cls.cells), numField('kvRating', T.cls.kv), numField('weightG', T.cls.weight), field('frame'), field('notes')),
    pr.cls && !ci.calibrated ? h('div', { class: 'small warn-text' }, T.cls.uncal(T.cls.names[ci.cls], T.cls.names[ci.like ?? ''] ?? ci.like ?? '')) : null,
    oldText ? h('div', { class: 'muted small' }, T.cls.old(oldText)) : null,
    h('label', { class: 'small', style: 'display:inline-flex;gap:4px;margin-right:12px' }, ds, T.inc.profile.dSensitive),
    h('label', { class: 'small', style: 'display:inline-flex;gap:4px;align-items:center' }, T.inc.profile.disabled, dis),
    stats.length ? h('table', { class: 'grid small', style: 'margin-top:6px' },
      h('thead', null, h('tr', null, ...Object.values(T.inc.statsCol).map((c) => h('th', null, c)))),
      h('tbody', null, stats.map(([id, s]) => h('tr', null, h('td', null, id), h('td', null, s.n), h('td', null, s.worse), h('td', null, s.incidents.join(', ')))))) : null,
    ph.length ? h('div', { class: 'small' }, T.inc.predHistory(ph.map((e) => `${fmt(e, 0)} %`).join(', '))) : null);
}
