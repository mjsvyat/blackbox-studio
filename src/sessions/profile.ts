// Профиль борта (E2.2): класс, банки, KV, вес, рама. Старые текстовые поля (props, kv, weight)
// разбираются в структурированные при чтении — без потерь (текст остаётся).

import { CLASSES, type BoardClass } from '../config/classes';
import type { BoardProfile } from './db';

/** класс по тексту про пропы: «5"», «7 дюймов», «65мм», «85 mm»… */
export function guessClass(text: string | undefined): BoardClass | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase().replace(',', '.');
  const mm = t.match(/(\d{2,3})\s*(мм|mm)/);
  if (mm) {
    const v = Number(mm[1]);
    if (v <= 70) return '65mm';
    if (v <= 100) return '85mm';
  }
  const inch = t.match(/(\d+(?:\.\d+)?)\s*("|''|in|inch|дюйм|д\b)/) ?? t.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (inch) {
    const v = Number(inch[1]);
    const opts: [number, BoardClass][] = [[3, '3in'], [5, '5in'], [7, '7in'], [10, '10in']];
    if (v > 0 && v < 13) return opts.reduce((b, o) => (Math.abs(o[0] - v) < Math.abs(b[0] - v) ? o : b))[1];
  }
  return undefined;
}

const num = (s: string | undefined): number | undefined => {
  const m = s?.replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
};

/** структурированный профиль (старые поля — подсказка, если новых нет) */
export function normalizeProfile(p: BoardProfile | undefined): BoardProfile {
  const pr = { ...(p ?? {}) };
  if (!pr.cls || !CLASSES.includes(pr.cls as BoardClass)) pr.cls = guessClass(pr.props);
  if (pr.kvRating === undefined) pr.kvRating = num(pr.kv);
  if (pr.weightG === undefined) pr.weightG = num(pr.weight);
  if (pr.cells === undefined) {
    const s = `${pr.props ?? ''} ${pr.notes ?? ''}`.match(/(\d{1,2})\s*s\b/i);
    if (s) pr.cells = Number(s[1]);
  }
  return pr;
}
