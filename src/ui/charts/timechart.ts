// Временные графики на uPlot: общий курсор, общий зум (state.view), данные
// подгружаются из воркера под текущую ширину (min/max-прореживание).
// Протянуть мышью — зум всех графиков; Shift+протянуть — участок анализа;
// двойной клик — весь лог.

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { clear, cssVar, h } from '../dom';
import { helpBtn } from '../help';
import { fetchSeries, set, setAnalysisRange, state, subscribe } from '../store';

export interface SeriesSpec {
  key: string;
  label: string;
  /** имя CSS-переменной цвета или цвет */
  color: string;
  width?: number;
  fill?: string;
  dash?: number[];
  scale?: string;
}

export interface TimeChartSpec {
  title: string;
  help?: string;
  series: SeriesSpec[];
  height?: number;
  /** обзор: всегда весь лог, рамка текущего зума, маска заливкой */
  overview?: boolean;
  yRange?: [number, number];
  scales?: Record<string, { range?: [number, number] }>;
}

const live = new Set<TimeChart>();
let shiftDown = false;
window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftDown = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; });

const color = (c: string): string => (c.startsWith('--') ? cssVar(c) : c);

export class TimeChart {
  el: HTMLElement;
  private u: uPlot | null = null;
  private plotBox: HTMLElement;
  private spec: TimeChartSpec;
  private unsub: () => void;
  private reqToken = 0;
  private ro: ResizeObserver;
  private dragShift = false;

  constructor(spec: TimeChartSpec) {
    this.spec = spec;
    this.plotBox = h('div');
    const legend = h('div', { class: 'legend-inline' }, spec.series.map((s) => h('span', { style: `--c:${color(s.color)}` }, s.label)));
    this.el = h('div', { class: 'chart-box' }, h('div', { class: 'chart-title' }, spec.title, helpBtn(spec.help), h('span', { class: 'spacer', style: 'flex:1' }), legend), this.plotBox);
    this.unsub = subscribe((_s, ch) => {
      if (ch.has('view') && !this.spec.overview) this.reload();
      if (ch.has('analysis') || ch.has('view')) this.u?.redraw(false, false);
    });
    this.ro = new ResizeObserver(() => this.resize());
    live.add(this);
    requestAnimationFrame(() => {
      this.build();
      this.ro.observe(this.plotBox);
    });
  }

  destroy(): void {
    this.unsub();
    this.ro.disconnect();
    this.u?.destroy();
    live.delete(this);
  }

  private width(): number {
    return Math.max(300, this.plotBox.clientWidth || 800);
  }

  private build(): void {
    clear(this.plotBox);
    const spec = this.spec;
    const grid = { stroke: cssVar('--grid'), width: 1 };
    const axisStroke = cssVar('--fg2');
    const scales: uPlot.Scales = { x: { time: false, auto: false, range: () => this.xRange() } };
    if (spec.yRange) scales.y = { auto: false, range: () => spec.yRange! };
    for (const [k, v] of Object.entries(spec.scales ?? {})) scales[k] = v.range ? { auto: false, range: () => v.range! } : { auto: true };
    const opts: uPlot.Options = {
      width: this.width(),
      height: spec.height ?? 180,
      legend: { show: false },
      cursor: {
        sync: { key: 'bb-time' },
        drag: { x: true, y: false, setScale: false },
        points: { size: 5 },
        bind: {
          mousedown: (u, _targ, handler) => (e: MouseEvent) => {
            this.dragShift = e.shiftKey || shiftDown;
            u.root.querySelector('.u-select')?.classList.toggle('shift', this.dragShift);
            return handler(e);
          },
          dblclick: () => () => {
            if (state.info) set({ view: { t0: 0, t1: state.info.durationS } });
            return null;
          },
        },
      },
      scales,
      axes: [
        { stroke: axisStroke, grid, ticks: grid, size: 28, values: (_u, v) => v.map((x) => `${x.toFixed(x < 10 && v.length > 1 && Math.abs(v[1] - v[0]) < 1 ? 1 : 0)}`) },
        { stroke: axisStroke, grid, ticks: grid, size: 46 },
        ...Object.keys(spec.scales ?? {}).filter((k) => k !== 'y').map((k) => ({ scale: k, side: 1, stroke: axisStroke, grid: { show: false }, size: 46 })),
      ],
      series: [
        { label: 'с' },
        ...spec.series.map((s) => ({
          label: s.label,
          stroke: color(s.color),
          width: s.width ?? 1,
          fill: s.fill ? color(s.fill) : undefined,
          dash: s.dash,
          scale: s.scale ?? 'y',
          points: { show: false },
        })),
      ],
      hooks: {
        setSelect: [(u) => this.onSelect(u)],
        drawClear: [(u) => this.drawUnder(u)],
        draw: [(u) => this.drawOver(u)],
      },
    };
    const empty: uPlot.AlignedData = [[], ...spec.series.map(() => [])];
    this.u = new uPlot(opts, empty, this.plotBox);
    this.reload(true);
  }

  private xRange(): [number, number] {
    const d = state.info?.durationS ?? 1;
    if (this.spec.overview || !state.view) return [0, d];
    return [state.view.t0, state.view.t1];
  }

  private resize(): void {
    if (!this.u) return;
    const w = this.width();
    if (Math.abs(w - this.u.width) > 2) {
      this.u.setSize({ width: w, height: this.spec.height ?? 180 });
      this.reload();
    }
  }

  async reload(_first = false): Promise<void> {
    if (!this.u || !state.info) return;
    const [t0, t1] = this.xRange();
    const token = ++this.reqToken;
    const r = await fetchSeries(this.spec.series.map((s) => s.key), t0, t1, this.width());
    if (token !== this.reqToken || !this.u) return;
    this.u.setData([r.x as unknown as number[], ...r.ys.map((y) => y as unknown as number[])], true);
  }

  private onSelect(u: uPlot): void {
    const s = u.select;
    if (s.width < 3) return;
    const a = u.posToVal(s.left, 'x');
    const b = u.posToVal(s.left + s.width, 'x');
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (this.dragShift) {
      setAnalysisRange({ t0: Math.min(a, b), t1: Math.max(a, b) });
    } else {
      set({ view: { t0: Math.max(0, Math.min(a, b)), t1: Math.max(a, b) } });
    }
  }

  /** подложка: чистый полёт, дыры, участок анализа */
  private drawUnder(u: uPlot): void {
    const an = state.analysis;
    const info = state.info;
    if (!an || !info) return;
    const ctx = u.ctx;
    const top = u.bbox.top, hgt = u.bbox.height;
    const x = (t: number): number => u.valToPos(t, 'x', true);
    ctx.save();
    if (this.spec.overview) {
      ctx.fillStyle = cssVar('--mask');
      for (const [a, b] of an.maskSegments) ctx.fillRect(x(a), top, Math.max(1, x(b) - x(a)), hgt);
    }
    ctx.fillStyle = cssVar('--hole');
    for (const [a, b] of info.holes) {
      const xa = x(a ?? 0), xb = x(b ?? info.durationS);
      ctx.fillRect(xa, top, Math.max(2, xb - xa), hgt);
    }
    ctx.restore();
  }

  /** поверх: события, аномалии, рамки */
  private drawOver(u: uPlot): void {
    const an = state.analysis;
    const info = state.info;
    if (!an || !info) return;
    const ctx = u.ctx;
    const top = u.bbox.top, hgt = u.bbox.height;
    const x = (t: number): number => u.valToPos(t, 'x', true);
    const dpr = devicePixelRatio || 1;
    ctx.save();
    ctx.strokeStyle = cssVar('--event');
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    for (const a of an.anomalies) {
      const xa = x(a.t0);
      if (xa < u.bbox.left || xa > u.bbox.left + u.bbox.width) continue;
      ctx.beginPath();
      ctx.moveTo(xa, top);
      ctx.lineTo(xa, top + hgt);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (an.range) {
      ctx.strokeStyle = cssVar('--green');
      ctx.lineWidth = 2 * dpr;
      for (const t of [an.range.t0, an.range.t1]) {
        ctx.beginPath();
        ctx.moveTo(x(t), top);
        ctx.lineTo(x(t), top + hgt);
        ctx.stroke();
      }
    }
    if (this.spec.overview && state.view && (state.view.t0 > 0.01 || state.view.t1 < info.durationS - 0.01)) {
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(x(state.view.t0), top + dpr, x(state.view.t1) - x(state.view.t0), hgt - 2 * dpr);
    }
    ctx.restore();
  }
}

export function destroyAllTimeCharts(): void {
  for (const c of [...live]) c.destroy();
}

/** приблизить все графики к моменту t (клик по событию) */
export function zoomTo(t: number, half = 1.5): void {
  const d = state.info?.durationS ?? 0;
  set({ view: { t0: Math.max(0, t - half), t1: Math.min(d, t + half) } });
}
