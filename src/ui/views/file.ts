// «Что внутри файла»: структура дампа, заворот, список логов.

import { MiB } from '../../decoder/scan';
import { T } from '../../i18n/ru';
import { fmtBytes, fmtTime, h } from '../dom';
import { helpBtn } from '../help';
import { openLog, state } from '../store';

let showDup = false;

export function fileView(rerender: () => void): HTMLElement {
  const st = state.structure;
  if (!st) return h('div');
  const uniq = st.logs.filter((l) => l.duplicateOf === null);
  const dups = st.logs.length - uniq.length;

  const wrap = st.wrapPeriod
    ? h('div', { class: 'panel bad' },
        h('h3', null, T.file.wrapTitle, helpBtn('card-integrity')),
        h('p', null, T.file.wrapText(st.wrapPeriod / MiB, dups)),
        h('p', null, h('b', null, T.file.wrapAdvice)))
    : null;

  const rows = st.logs
    .filter((l) => showDup || l.duplicateOf === null)
    .map((l) => {
      const notes: (HTMLElement | string)[] = [];
      if (l.duplicateOf !== null) notes.push(h('span', { class: 'badge' }, T.file.dup(l.duplicateOf)));
      if (l.crossesWrap) notes.push(h('span', { class: 'badge red' }, T.file.crossWrap));
      if (l.damage !== null && l.damage > 0.2) notes.push(h('span', { class: 'badge red' }, T.file.damaged(l.damage * 100)));
      else if (l.damage !== null && l.damage > 0.01) notes.push(h('span', { class: 'badge yellow' }, T.file.damaged(l.damage * 100)));
      if (l.empty) notes.push(h('span', { class: 'badge yellow' }, T.file.empty));
      if (!l.headerOk) notes.push(h('span', { class: 'badge red' }, T.file.badHeader));
      const canOpen = l.headerOk && l.duplicateOf === null;
      const isOpen = state.info?.index === l.index;
      return h('tr', { class: `${l.duplicateOf !== null ? 'dim' : ''} ${canOpen ? 'click' : ''}`, onclick: canOpen ? () => openLog(l.index) : null },
        h('td', null, String(l.index)),
        h('td', null, l.datetime.replace('T', ' ').replace(/\.\d+\+00:00$/, ' UTC')),
        h('td', null, l.durationS !== null ? fmtTime(l.durationS) : '—'),
        h('td', null, l.firmware.version, h('div', { class: 'muted small' }, l.board)),
        h('td', null, `${l.logHz.toFixed(0)} Гц`),
        h('td', null, fmtBytes(l.size), h('div', { class: 'muted small' }, `@ ${l.start.toLocaleString('ru')}`)),
        h('td', null, notes),
        h('td', null, canOpen ? h('button', { class: isOpen ? 'btn small primary' : 'btn small' }, T.file.open) : null));
    });

  return h('div', null,
    h('h2', null, T.file.title, helpBtn('file-structure')),
    h('div', { class: 'panel row' },
      h('span', null, `${T.file.size}: `, h('b', null, fmtBytes(st.size))),
      h('span', null, `${T.file.logsFound}: `, h('b', null, String(st.logs.length)), ` (${uniq.length} ${T.file.unique})`),
      h('span', null, `${T.file.dataEnd}: `, h('b', null, fmtBytes(st.dataEnd))),
      st.erased.length ? h('span', null, `${T.file.erased}: ${st.erased.map((e) => `${fmtBytes(e.start)}–${fmtBytes(e.end)}`).join(', ')}`) : null,
    ),
    wrap,
    h('div', { class: 'panel' },
      dups ? h('label', { class: 'small muted' }, h('input', { type: 'checkbox', checked: showDup, onchange: (e: Event) => { showDup = (e.target as HTMLInputElement).checked; rerender(); } }), ` ${T.file.showDup} (${dups})`) : null,
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, [T.file.colIdx, T.file.colDate, T.file.colDur, T.file.colFw, T.file.colRate, T.file.colSize, T.file.colNote, ''].map((c) => h('th', null, c)))),
        h('tbody', null, rows))),
  );
}
