// «Сводка»: светофор из 8 карточек + что попало в анализ.

import { T } from '../../i18n/ru';
import { fmt, fmtTime, h } from '../dom';
import { helpBtn } from '../help';
import { set, state } from '../store';

export function summaryView(): HTMLElement {
  const an = state.analysis, info = state.info;
  if (!an || !info) return h('div');
  const ex = Object.entries(an.excluded).filter(([, v]) => v >= 0.05);
  const head = h('div', { class: 'panel row' },
    h('span', null, h('b', null, info.datetime.replace('T', ' ').replace(/\.\d+\+00:00$/, ' UTC'))),
    h('span', { class: 'muted' }, info.firmware),
    h('span', { class: 'muted' }, info.board),
    h('span', null, `${T.summary.flightTime}: `, h('b', null, fmtTime(an.maskSeconds)), ` ${T.summary.of} ${fmtTime(info.durationS)}`, helpBtn('flight-mask')),
    an.range ? h('span', { class: 'badge' }, T.flight.rangeSet(an.range.t0, an.range.t1)) : null,
    ex.length ? h('span', { class: 'muted small' }, `${T.summary.excludedTitle}: ${ex.map(([k, v]) => `${T.summary.excl[k] ?? k} ${fmt(v, 1)} с`).join(', ')}`) : null,
  );
  const lowData = an.maskSeconds < 5 ? h('div', { class: 'panel warn' }, T.summary.lowData) : null;
  const cards = h('div', { class: 'cards' }, an.cards.map((c) =>
    h('div', { class: `card ${c.status}`, onclick: () => set({ tab: c.tab }) },
      h('div', { class: 'head' }, h('span', { class: `dot ${c.status}` }), h('span', { class: 'title' }, c.title), h('span', { class: 'muted small' }, T.status[c.status]), helpBtn(c.help)),
      h('div', { class: 'phrase' }, c.phrase),
      c.extra.map((e) => h('div', { class: 'extra' }, e)),
      c.metrics.length
        ? h('div', { class: 'metrics' }, c.metrics.map((m) =>
            h('div', { class: 'm' }, m.status ? h('span', { class: `dot ${m.status}` }) : h('span', { class: 'dot', style: 'visibility:hidden' }), h('span', { class: 'l' }, m.label), h('b', null, m.value), helpBtn(m.help))))
        : null,
    )));
  const warn = info.warnings.length ? h('div', { class: 'panel warn' }, info.warnings.map((w) => h('div', null, w))) : null;
  return h('div', null, h('h2', null, T.summary.title), head, lowData, warn, cards);
}
