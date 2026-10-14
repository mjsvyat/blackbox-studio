// Вкладка «Настройка»: советы по правилам (механика → настройки → тестовый полёт →
// о логе), у каждого — что увидели / почему / что поменять / что ожидаем / риск /
// как проверить, ID и версия правила; общий CLI для выбранных в эту итерацию.

import { fcPrepare } from '../fcStore';
import type { Advice } from '../../advisor/advisor';
import { AXIS_NAMES, T } from '../../i18n/ru';
import { cliDiff, cliValue, paramByName } from '../../params/registry';
import { fmt, h } from '../dom';
import { helpBtn } from '../help';
import { ensureAdvice, ensureFilters, requestSandbox, set, state } from '../store';

const ORDER: Advice['kind'][] = ['mechanic', 'tune', 'flight', 'info'];

export function tuningView(): HTMLElement {
  const R = state.advice;
  const head = h('h2', null, T.adv.title, helpBtn('advisor'));
  if (!R) {
    ensureAdvice();
    return h('div', null, head, h('div', { class: 'panel muted' }, T.adv.loading));
  }
  const out = h('div', null, head, h('p', { class: 'muted' }, T.adv.intro));
  if (R.cls && !R.cls.calibrated) out.append(h('div', { class: 'panel warn' }, T.cls.uncal(T.cls.names[R.cls.cls], T.cls.names[R.cls.like ?? ''] ?? ''), ' ', helpBtn('board-class')));
  if (!R.advice.length) out.append(h('div', { class: 'panel' }, T.adv.none));

  const card = (a: Advice): HTMLElement => {
    const t = T.adv.rules[a.id];
    const x = a.inputs;
    const changes = Object.keys(a.changes);
    const sec = (label: string, body: (HTMLElement | string | null)[] | string): HTMLElement =>
      h('div', { style: 'margin:4px 0' }, h('b', { class: 'small muted' }, label, ': '), ...(Array.isArray(body) ? body : [body]));
    const tbl = changes.length ? h('table', { class: 'grid small', style: 'margin:4px 0' }, h('tbody', null, changes.map((k) => h('tr', null,
      h('td', null, h('code', null, k)), h('td', null, a.from[k] !== undefined ? cliValue(k, a.from[k]) : '—'), h('td', null, '→'), h('td', null, h('b', null, cliValue(k, a.changes[k]))))))) : null;
    const sliders = a.sliders.length ? h('div', { class: 'small' }, T.adv.sliders, ' ', a.sliders.map(([n, f, to]) => `${paramByName.get(n)?.label ?? n}: ${fmt(f, 2)} → ${fmt(to, 2)}`).join('; ')) : null;
    const effect = a.effect ? h('div', { class: 'small' }, T.adv.effect(a.effect.delay100[0], a.effect.delay100[1], a.effect.delayD100[0], a.effect.delayD100[1], a.effect.dterm[0], a.effect.dterm[1], a.effect.gyro[0], a.effect.gyro[1])) : null;
    const isPid = a.id.startsWith('R-PID-');
    const filterKeys = changes.length && state.filters && changes.every((k) => k in state.filters!.params || /^simplified_(gyro|dterm)_filter_multiplier$/.test(k));
    const cls = a.kind === 'tune' && !a.selected ? 'panel' : a.severity === 'red' ? 'panel bad' : a.severity === 'yellow' ? 'panel warn' : 'panel';
    return h('div', { class: cls, style: a.kind === 'tune' && !a.selected ? 'opacity:.7' : '' },
      h('div', { class: 'row', style: 'gap:8px' },
        h('h3', { style: 'margin:0;flex:1' }, t?.title ?? a.id),
        a.kind === 'tune' ? h('span', { class: `badge ${a.selected ? '' : 'yellow'}` }, a.selected ? T.adv.selected : T.adv.deferred[a.deferred ?? ''] ?? '') : null,
        h('span', { class: 'badge', title: 'ID и версия правила' }, T.adv.rule(a.id, a.version))),
      // на виду — что увидели и что поменять; объяснения и проверка — по клику
      t ? [
        sec(T.adv.seen, t.seen(x)),
        sec(T.adv.change, [t.change(x), tbl, sliders]),
        h('details', { class: 'fold' }, h('summary', null, T.adv.details),
        sec(T.adv.why, t.why),
        sec(T.adv.expect, [t.expect(x), effect,
          a.forecast?.length ? h('div', { class: 'small', style: 'font-style:italic' }, a.forecast.filter((f) => f.axis < 2).map((f) => h('div', null, T.adv.forecast(AXIS_NAMES[f.axis], f.now.overshoot, `${f.overshoot.mid.toFixed(0)} (${f.overshoot.lo.toFixed(0)}–${f.overshoot.hi.toFixed(0)})`, f.now.delayMs, `${f.delayMs.mid.toFixed(1)} (${f.delayMs.lo.toFixed(1)}–${f.delayMs.hi.toFixed(1)})`))))
            : isPid && changes.length ? h('div', { class: 'muted small' }, T.adv.pidForecast) : null]),
        sec(T.adv.risk, t.risk),
        sec(T.adv.verify, t.verify)),
      ] : null,
      a.caution ? h('div', { class: 'panel warn', style: 'margin:6px 0 0' }, T.inc.caution(a.caution.worse, a.caution.n, a.caution.incidents.join(', '))) : null,
      a.limited?.length ? h('div', { class: 'small muted', style: 'margin:4px 0' }, h('b', null, T.adv.whyNotMore, ': '), a.limited.map((l) => T.adv.limitedText(l.key, l.wanted, l.cap, T.cls.names[R.cls?.cls ?? '5in'] ?? '')).join('; ')) : null,
      a.safety ? h('div', { class: 'panel bad', style: 'margin:6px 0 0' }, h('b', null, T.adv.safety)) : null,
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { class: 'btn small', onclick: () => set({ tab: a.tab }) }, T.adv.open),
        filterKeys ? h('button', { class: 'btn small', onclick: () => { requestSandbox({ ...state.filters!.params, ...a.changes }); set({ tab: 'filters' }); } }, T.adv.toSandbox) : null));
  };

  for (const kind of ORDER) {
    const list = R.advice.filter((a) => a.kind === kind);
    if (!list.length) continue;
    out.append(h('h3', null, T.adv.groups[kind], kind === 'flight' ? helpBtn('test-flight') : null), ...list.map(card));
  }

  const cli = cliDiff(R.from, R.to, R.fwCode);
  const text = cli.lines.join('\n');
  const copyBtn = h('button', { class: 'btn small', onclick: async () => {
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = T.filt.cliCopied; } catch { /* нет доступа к буферу */ }
  } }, T.filt.cliCopy);
  const usb = h('button', { class: 'btn small', onclick: () => fcPrepare(R.from, R.to, 'plan') }, T.fc.toBoard);
  out.append(h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.adv.cliTitle, text ? copyBtn : null, text ? usb : null),
    text ? h('pre', { style: 'margin:0;padding:8px;background:var(--bg3);border-radius:6px;overflow:auto' }, text) : h('div', { class: 'muted' }, T.adv.cliEmpty),
    text ? h('div', { class: 'muted small' }, T.adv.cliNote) : null));
  // примерка фильтров должна быть готова для кнопки «открыть в примерке»
  ensureFilters();
  return out;
}
