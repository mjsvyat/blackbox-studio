// Регрессионные проверки случаев (cases/INC-xxxx/case.json → regression.checks):
// «на этих логах советчик НЕ предлагает X / предупреждает о Y / метрика в пределах».
// Запускаются в tests/cases/cases.test.ts тем же конвейером, что видит пользователь.

import type { AdvisorResult } from '../advisor/advisor';

export interface Check {
  type: 'not-selected' | 'not-fired' | 'fired' | 'selected' | 'first' | 'metric';
  rule?: string;
  /** путь в снимке сессии, например pid.axes.0.overshootPct */
  path?: string;
  min?: number;
  max?: number;
}

function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o === null || o === undefined ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/** список нарушений (пусто — случай не повторяется) */
export function evaluateChecks(adv: AdvisorResult, snap: unknown, checks: Check[]): string[] {
  const fails: string[] = [];
  const fired = (r: string) => adv.advice.find((a) => a.id === r);
  for (const c of checks) {
    const a = c.rule ? fired(c.rule) : undefined;
    switch (c.type) {
      case 'not-selected': if (a?.selected) fails.push(`${c.rule} выбрано, а не должно`); break;
      case 'selected': if (!a?.selected) fails.push(`${c.rule} не выбрано`); break;
      case 'not-fired': if (a) fails.push(`${c.rule} сработало, а не должно`); break;
      case 'fired': if (!a) fails.push(`${c.rule} не сработало`); break;
      case 'first': if (adv.advice[0]?.id !== c.rule) fails.push(`первым должно быть ${c.rule}, а стоит ${adv.advice[0]?.id ?? '—'}`); break;
      case 'metric': {
        const v = Number(at(snap, c.path ?? ''));
        if (!Number.isFinite(v)) fails.push(`${c.path}: нет значения`);
        else if ((c.min !== undefined && v < c.min) || (c.max !== undefined && v > c.max)) fails.push(`${c.path} = ${v} вне [${c.min ?? '−∞'}, ${c.max ?? '∞'}]`);
        break;
      }
    }
  }
  return fails;
}
