// Универсальный линейный график X–Y на uPlot (АЧХ, задержка, дорожки нотчей).

import uPlot from 'uplot';
import { clear, cssVar, h } from '../dom';
import { helpBtn } from '../help';

export interface Line {
  label: string;
  color: string;
  data: ArrayLike<number> | null;
  width?: number;
  dash?: number[];
}

export interface LineSpec {
  title: string;
  help?: string;
  x: ArrayLike<number>;
  lines: Line[];
  height?: number;
  yRange?: [number, number];
  xRange?: [number, number];
  marks?: { x: number; label: string; color: string }[];
  /** горизонтальная линия (например, шум округления) */
  hline?: { y: number; label: string; color: string };
  extraTitle?: HTMLElement | string | null;
  note?: string;
}

const color = (c: string): string => (c.startsWith('--') ? cssVar(c) : c);

export function lineChart(spec: LineSpec): { el: HTMLElement; destroy: () => void } {
  const box = h('div');
  const lines = spec.lines.filter((l) => l.data);
  const legend = h('div', { class: 'legend-inline' }, lines.map((l) => h('span', { style: `--c:${color(l.color)}${l.dash ? ';opacity:.85' : ''}` }, l.label)));
  const el = h('div', { class: 'chart-box' },
    h('div', { class: 'chart-title' }, spec.title, helpBtn(spec.help), spec.extraTitle ?? null, h('span', { style: 'flex:1' }), legend),
    box,
    spec.note ? h('div', { class: 'muted small', style: 'margin:2px 0 4px' }, spec.note) : null);
  let u: uPlot | null = null;
  const data: uPlot.AlignedData = [Array.from(spec.x), ...lines.map((l) => Array.from(l.data!, (v) => (Number.isFinite(v) ? v : null)))] as uPlot.AlignedData;
  const build = (): void => {
    clear(box);
    const grid = { stroke: cssVar('--grid'), width: 1 };
    const fg = cssVar('--fg2');
    const scales: uPlot.Scales = { x: { time: false } };
    if (spec.xRange) scales.x = { time: false, auto: false, range: () => spec.xRange! };
    if (spec.yRange) scales.y = { auto: false, range: () => spec.yRange! };
    u = new uPlot({
      width: Math.max(300, box.clientWidth || 600),
      height: spec.height ?? 240,
      legend: { show: false },
      cursor: { drag: { x: true, y: false }, points: { size: 5 } },
      scales,
      axes: [{ stroke: fg, grid, ticks: grid, size: 28 }, { stroke: fg, grid, ticks: grid, size: 46 }],
      series: [{ label: 'x' }, ...lines.map((l) => ({ label: l.label, stroke: color(l.color), width: l.width ?? 1.5, dash: l.dash, points: { show: false }, spanGaps: false }))],
      hooks: {
        draw: [(pl: uPlot) => {
          const ctx = pl.ctx;
          const dpr = devicePixelRatio || 1;
          ctx.save();
          ctx.font = `${11 * dpr}px system-ui`;
          for (const m of spec.marks ?? []) {
            const px = pl.valToPos(m.x, 'x', true);
            if (px < pl.bbox.left || px > pl.bbox.left + pl.bbox.width) continue;
            ctx.strokeStyle = color(m.color); ctx.fillStyle = color(m.color);
            ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
            ctx.beginPath(); ctx.moveTo(px, pl.bbox.top); ctx.lineTo(px, pl.bbox.top + pl.bbox.height); ctx.stroke();
            ctx.fillText(m.label, px + 3 * dpr, pl.bbox.top + 12 * dpr);
          }
          if (spec.hline) {
            const py = pl.valToPos(spec.hline.y, 'y', true);
            ctx.strokeStyle = color(spec.hline.color); ctx.fillStyle = color(spec.hline.color);
            ctx.setLineDash([2 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
            ctx.beginPath(); ctx.moveTo(pl.bbox.left, py); ctx.lineTo(pl.bbox.left + pl.bbox.width, py); ctx.stroke();
            ctx.fillText(spec.hline.label, pl.bbox.left + 6 * dpr, py - 4 * dpr);
          }
          ctx.restore();
        }],
      },
    }, data, box);
  };
  const ro = new ResizeObserver(() => {
    if (!u) return;
    const w = Math.max(300, box.clientWidth);
    if (Math.abs(w - u.width) > 2) u.setSize({ width: w, height: spec.height ?? 240 });
  });
  requestAnimationFrame(() => { build(); ro.observe(box); });
  return { el, destroy: () => { ro.disconnect(); u?.destroy(); } };
}
