// «Сводка»: сверху «Главное» — общий светофор и что делать сейчас (советы, выбранные на эту
// итерацию), ниже — 8 карточек. В карточке видно только то, что требует внимания; показатели
// в норме свёрнуты, чтобы глаз цеплялся за проблемы, а не за цифры.

import { T } from '../../i18n/ru';
import { fmt, fmtTime, h } from '../dom';
import { helpBtn } from '../help';
import { ensureAdvice, set, state } from '../store';

const RANK: Record<string, number> = { red: 3, yellow: 2, green: 1, grey: 0 };

export function summaryView(): HTMLElement {
  const an = state.analysis, info = state.info;
  if (!an || !info) return h('div');
  const ex = Object.entries(an.excluded).filter(([, v]) => v >= 0.05);
  const meta = h('div', { class: 'meta' },
    h('span', null, h('b', null, info.datetime.replace('T', ' ').replace(/\.\d+\+00:00$/, ' UTC'))),
    h('span', null, info.firmware),
    h('span', null, info.board),
    h('span', null, `${T.summary.flightTime}: `, h('b', null, fmtTime(an.maskSeconds)), ` ${T.summary.of} ${fmtTime(info.durationS)}`, ' ', helpBtn('flight-mask')),
    an.range ? h('span', { class: 'badge' }, T.flight.rangeSet(an.range.t0, an.range.t1)) : null,
    an.cls ? h('span', { class: `badge ${an.cls.calibrated ? '' : 'yellow'}` }, T.cls.badge(T.cls.names[an.cls.cls]), ' ', helpBtn('board-class')) : null,
  );
  const exLine = ex.length ? h('div', { class: 'muted small', style: 'margin:-8px 0 14px' }, `${T.summary.excludedTitle}: ${ex.map(([k, v]) => `${T.summary.excl[k] ?? k} ${fmt(v, 1)} с`).join(', ')}`) : null;
  const uncal = an.cls && !an.cls.calibrated ? h('div', { class: 'panel warn' }, T.cls.uncal(T.cls.names[an.cls.cls], T.cls.names[an.cls.like ?? ''] ?? '')) : null;
  const lowData = an.maskSeconds < 5 ? h('div', { class: 'panel warn' }, T.summary.lowData) : null;
  const warn = info.warnings.length ? h('div', { class: 'panel warn' }, info.warnings.map((w) => h('div', null, w))) : null;

  const cards = h('div', { class: 'cards' }, an.cards.map((c) => {
    const hot = c.metrics.filter((m) => m.status === 'red' || m.status === 'yellow');
    const rest = c.metrics.filter((m) => !(m.status === 'red' || m.status === 'yellow'));
    const row = (m: (typeof c.metrics)[number]): HTMLElement =>
      h('div', { class: 'm' }, m.status ? h('span', { class: `dot ${m.status}` }) : h('span', { class: 'dot', style: 'visibility:hidden' }), h('span', { class: 'l' }, m.label), h('b', null, m.value), helpBtn(m.help));
    return h('div', { class: `card ${c.status}`, onclick: () => set({ tab: c.tab }) },
      h('div', { class: 'head' }, h('span', { class: `dot ${c.status}` }), h('span', { class: 'title' }, c.title), h('span', { class: 'st-label' }, T.status[c.status]), helpBtn(c.help)),
      h('div', { class: 'phrase' }, c.phrase),
      c.extra.map((e) => h('div', { class: 'extra' }, e)),
      c.metrics.length
        ? h('div', { class: 'metrics' }, hot.map(row),
            rest.length ? h('details', { class: 'fold', onclick: (e: Event) => e.stopPropagation() }, h('summary', null, hot.length ? T.summary.more(rest.length) : T.summary.metrics(rest.length)), rest.map(row)) : null)
        : null,
    );
  }));
  return h('div', null, h('h2', null, T.summary.title), meta, exLine, hero(), uncal, lowData, warn, cards);
}

/** общий светофор по карточкам + до трёх советов, выбранных на эту итерацию */
function hero(): HTMLElement {
  const an = state.analysis!;
  const worst = an.cards.reduce((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'grey' as string);
  const R = state.advice;
  if (!R) ensureAdvice();
  const top = R ? R.advice.filter((a) => a.selected && (a.kind === 'mechanic' || a.kind === 'tune' || a.severity !== 'info')).sort((a, b) => a.priority - b.priority).slice(0, 3) : [];
  const body = !R
    ? h('div', { class: 'muted' }, T.summary.adviceLoading)
    : top.length
      ? h('ol', null, top.map((a) => h('li', null, T.adv.rules[a.id]?.title ?? a.id)))
      : h('div', { class: 'muted' }, T.summary.allOk);
  return h('div', { class: 'panel hero' },
    h('span', { class: `big-dot ${worst}` }),
    h('div', null, h('div', { class: 'lead' }, T.summary.mainTitle), body),
    R && top.length ? h('button', { class: 'btn primary small', onclick: () => set({ tab: 'tuning' }) }, T.summary.toAdvice) : h('span'));
}
