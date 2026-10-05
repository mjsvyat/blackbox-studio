// Классы бортов (E2.2): переопределения порогов analysis.json по классу (65 мм … 10").
// Модули читают пороги из общего объекта cfg (часть кэширует разделы: const C = cfg.compare),
// поэтому класс применяется НА МЕСТЕ: значения листьев переписываются в тех же объектах, а при
// смене класса сначала восстанавливается база (копия на момент загрузки). Анализ синхронный —
// класс ставится перед ним (воркер — по борту открытого лога, тесты — явно).

import cfg from './analysis.json';

export type BoardClass = '65mm' | '85mm' | '3in' | '5in' | '7in' | '10in';

interface ClassDef {
  calibrated: boolean;
  like?: string;
  overrides: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const BASE = structuredClone(cfg) as unknown as Obj;
delete BASE.classes;

function list(): Record<string, ClassDef> {
  return (cfg.classes.list as unknown as Record<string, ClassDef>);
}

export const CLASSES = Object.keys(cfg.classes.list) as BoardClass[];
export const DEFAULT_CLASS = cfg.classes.default as BoardClass;

/** записать листья src в target, не меняя сами объекты-разделы */
function assignDeep(target: Obj, src: Obj, path: string, touched: string[]): void {
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_')) continue;
    const cur = target[k];
    if (isObj(v) && isObj(cur)) assignDeep(cur, v, `${path}${k}.`, touched);
    else if (Array.isArray(v) && Array.isArray(cur)) {
      cur.length = 0;
      cur.push(...structuredClone(v));
      touched.push(path + k);
    } else {
      target[k] = structuredClone(v);
      touched.push(path + k);
    }
  }
}

export interface ClassInfo {
  cls: BoardClass;
  calibrated: boolean;
  /** класс, по аналогии с которым взяты пороги */
  like: string | null;
  /** переопределённые пороги (пути) */
  overridden: string[];
}

let active: BoardClass = DEFAULT_CLASS;

export function classInfo(cls: string | null | undefined): ClassInfo {
  const c = cls && cls in list() ? (cls as BoardClass) : DEFAULT_CLASS;
  const d = list()[c];
  const ov: string[] = [];
  const collect = (o: Obj, p: string): void => {
    for (const [k, v] of Object.entries(o)) if (isObj(v)) collect(v, `${p}${k}.`); else ov.push(p + k);
  };
  collect(d.overrides as Obj, '');
  return { cls: c, calibrated: d.calibrated, like: d.calibrated ? null : d.like ?? DEFAULT_CLASS, overridden: ov };
}

/** поставить класс: база + переопределения класса (неизвестный/пустой — класс по умолчанию) */
export function setBoardClass(cls: string | null | undefined): ClassInfo {
  const info = classInfo(cls);
  const touched: string[] = [];
  assignDeep(cfg as unknown as Obj, BASE, '', touched);
  assignDeep(cfg as unknown as Obj, list()[info.cls].overrides as Obj, '', []);
  active = info.cls;
  return info;
}

export function activeClass(): BoardClass {
  return active;
}
