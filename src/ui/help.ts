// Подсказки «?» в три уровня. Тексты — src/content/help/*.md и src/content/glossary.md,
// подгружаются при сборке (в dev — горячая перезагрузка при правке .md).

import { T } from '../i18n/ru';
import { h } from './dom';

interface Topic {
  id: string;
  title: string;
  short: string;
  detail: string;
  tuner: string;
}

interface GlossaryEntry {
  id: string;
  term: string;
  text: string;
}

const files = import.meta.glob('../content/help/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const glossaryRaw = (import.meta.glob('../content/glossary.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)['../content/glossary.md'] ?? '';

function parseTopic(id: string, src: string): Topic {
  let body = src.replace(/\r\n/g, '\n');
  let title = id;
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const t = fm[1].match(/title:\s*(.+)/);
    if (t) title = t[1].trim();
    body = body.slice(fm[0].length);
  }
  const sec: Record<string, string> = {};
  let cur = '';
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      cur = m[1].trim().toLowerCase();
      sec[cur] = '';
    } else if (cur) sec[cur] += line + '\n';
  }
  return { id, title, short: (sec['коротко'] ?? '').trim(), detail: (sec['подробно'] ?? '').trim(), tuner: (sec['для тюнера'] ?? '').trim() };
}

export const topics = new Map<string, Topic>();
for (const [path, src] of Object.entries(files)) {
  const id = path.split('/').pop()!.replace(/\.md$/, '');
  topics.set(id, parseTopic(id, src));
}

export const glossary = new Map<string, GlossaryEntry>();
{
  let cur: GlossaryEntry | null = null;
  for (const line of glossaryRaw.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*\{#([\w-]+)\}\s*$/);
    if (m) {
      cur = { id: m[2], term: m[1], text: '' };
      glossary.set(cur.id, cur);
    } else if (cur && !line.startsWith('---') && !line.startsWith('title:')) cur.text += line + '\n';
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[\[([^\]|]+)\|([\w-]+)\]\]/g, '<a class="gl" data-ref="$2">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t: string) => `<a class="gl" data-ref="${t.toLowerCase()}">${t}</a>`);
}

/** маленький Markdown: абзацы, списки, цитаты, **жирный**, `код`, [[термин|id]] */
export function md(src: string): string {
  const out: string[] = [];
  let list = false;
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('>')) { flush(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    para.push(line.trim());
  }
  flush();
  if (list) out.push('</ul>');
  return out.join('\n');
}

let drawer: HTMLElement | null = null;

export function closeHelp(): void {
  drawer?.remove();
  drawer = null;
}

export function openHelp(id: string, level: 'short' | 'detail' | 'tuner' = 'detail'): void {
  closeHelp();
  const topic = topics.get(id);
  const gl = glossary.get(id);
  const body = h('div', { class: 'body' });
  const seg = h('div', { class: 'seg' });
  const title = topic?.title ?? gl?.term ?? id;

  const render = (lv: typeof level): void => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lv === lv));
    if (topic) {
      // «Коротко» всегда сверху, ниже — выбранный уровень
      const parts = [`<p><b>${inline(topic.short || T.help.missing)}</b></p>`];
      if (lv === 'detail') parts.push(md(topic.detail || T.help.missing));
      if (lv === 'tuner') parts.push(md(topic.tuner || T.help.missing));
      body.innerHTML = parts.join('');
    } else if (gl) {
      body.innerHTML = md(gl.text);
    } else body.innerHTML = `<p>${T.help.missing} <code>${esc(id)}</code></p>`;
    body.querySelectorAll<HTMLAnchorElement>('a.gl').forEach((a) => {
      a.addEventListener('click', () => openHelp(a.dataset.ref!, 'detail'));
    });
  };

  if (topic) {
    for (const [lv, name] of [['short', T.help.short], ['detail', T.help.detail], ['tuner', T.help.tuner]] as const) {
      seg.append(h('button', { 'data-lv': lv, onclick: () => render(lv) }, name));
    }
  }
  drawer = h('aside', { class: 'drawer' },
    h('header', null, h('span', { class: 't' }, gl && !topic ? `${T.help.glossary}: ${title}` : title), h('button', { class: 'btn small', onclick: closeHelp }, T.help.close)),
    topic ? seg : null,
    body,
    h('div', { class: 'body small muted', style: 'border-top:1px solid var(--line);margin-top:auto' },
      h('a', { class: 'gl', onclick: () => openGlossary() }, T.help.glossary)),
  );
  document.body.append(drawer);
  render(level);
}

export function openGlossary(): void {
  closeHelp();
  const body = h('div', { class: 'body' });
  for (const g of glossary.values()) {
    const d = h('div', null, h('h4', null, g.term));
    d.insertAdjacentHTML('beforeend', md(g.text));
    body.append(d);
  }
  body.querySelectorAll<HTMLAnchorElement>('a.gl').forEach((a) => a.addEventListener('click', () => openHelp(a.dataset.ref!, 'detail')));
  drawer = h('aside', { class: 'drawer' }, h('header', null, h('span', { class: 't' }, T.help.glossary), h('button', { class: 'btn small', onclick: closeHelp }, T.help.close)), body);
  document.body.append(drawer);
}

/** кнопка «?» рядом с графиком/метрикой */
export function helpBtn(id: string | undefined): HTMLElement | null {
  if (!id) return null;
  const t = topics.get(id);
  return h('button', {
    class: 'help-btn',
    title: t ? t.short : '',
    onclick: (e: Event) => {
      e.stopPropagation();
      openHelp(id);
    },
  }, '?');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHelp();
});
