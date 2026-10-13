// «Перенос настроек»: diff со старой прошивки → строки для новой (params/convert.ts).

import { T } from '../../i18n/ru';
import { BF_VERSIONS, BfVersion, convertDiff } from '../../params/convert';
import { h } from '../dom';
import { helpBtn } from '../help';

let from: BfVersion = '4.5.0';
let to: BfVersion = '2026.6.1';
let input = '';

export function convertView(): HTMLElement {
  const C = T.conv;
  const res = input.trim() ? convertDiff(input, from, ORD(from) <= ORD(to) ? to : from) : null;
  const sel = (v: BfVersion, on: (x: BfVersion) => void): HTMLElement =>
    h('select', { class: 'btn', onchange: (e: Event) => { on((e.target as HTMLSelectElement).value as BfVersion); rerender(); } }, BF_VERSIONS.map((x) => h('option', { value: x, selected: x === v }, x)));
  const area = h('textarea', { class: 'conv-in', placeholder: C.placeholder, spellcheck: 'false' }) as HTMLTextAreaElement;
  area.value = input;
  area.addEventListener('input', () => { input = area.value; rerender(); });
  const outText = res ? res.lines.join('\n') : '';
  const copy = h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(outText); copy.textContent = T.filt.cliCopied; } catch { /* нет доступа к буферу */ } } }, T.filt.cliCopy);
  const box = h('div', { id: 'conv' },
    h('h2', null, C.title, helpBtn('convert')),
    h('p', { class: 'muted' }, C.intro),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, C.from, sel(from, (x) => { from = x; }), '→', C.to, sel(to, (x) => { to = x; }),
      ORD(from) > ORD(to) ? h('span', { class: 'warn-text small' }, C.backwards) : null),
    h('div', { class: 'two' },
      h('div', null, h('div', { class: 'small muted' }, C.inLabel), area),
      h('div', null, h('div', { class: 'row small muted' }, C.outLabel, res ? copy : null), h('pre', { class: 'cli conv-out' }, outText || C.empty))),
    res && res.notes.length
      ? h('div', { class: 'panel', style: 'margin-top:12px' }, h('b', null, C.notes(res.notes.length)),
          h('ul', { class: 'small' }, res.notes.map((n) => h('li', { class: n.kind === 'removed' || n.kind === 'changed' ? 'warn-text' : '' }, C.kind[n.kind], ': ', n.text))))
      : null,
    h('p', { class: 'muted small' }, C.warn));
  return box;
}

const ORD = (v: BfVersion): number => BF_VERSIONS.indexOf(v);

function rerender(): void {
  const el = document.getElementById('conv');
  if (!el) return;
  const focused = document.activeElement?.classList.contains('conv-in');
  const pos = (document.activeElement as HTMLTextAreaElement | null)?.selectionStart ?? 0;
  const next = convertView();
  el.replaceWith(next);
  if (focused) {
    const a = next.querySelector('.conv-in') as HTMLTextAreaElement;
    a.focus();
    a.selectionStart = a.selectionEnd = pos;
  }
}
