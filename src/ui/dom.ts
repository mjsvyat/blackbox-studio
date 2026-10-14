// Мини-хелпер построения DOM без фреймворка.

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : nbsp(String(c)));
  }
}

/** число и единица не разрываются переносом строки («10 %», «2.63 мс», «≥ 30») */
const UNIT = /(\d) (?=(?:%|мс|мкс|Гц|кГц|с|дБ|°\/с|°|В|А|мА|мОм|об\/мин|мм|КиБ|МиБ|Б|S)(?!\p{L}))/gu;
export function nbsp(s: string): string {
  return s.replace(UNIT, '$1\u00A0').replace(/([≥≤<>±≈×]) (?=\d)/g, '$1\u00A0');
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const fmt = (v: number | null | undefined, d = 1, unit = ''): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`;

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${r.toFixed(1)} с`;
}

export function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} МиБ`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} КиБ`;
  return `${b} Б`;
}
