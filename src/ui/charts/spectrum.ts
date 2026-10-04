// Спектр (СПМ в дБ) на uPlot: несколько линий, вертикальные метки (гармоники
// моторов, Найквист), подсветка пиков.

import uPlot from 'uplot';
import { clear, cssVar, h } from '../dom';
import { helpBtn } from '../help';

export interface SpectrumLine {
  label: string;
  color: string;
  data: Float32Array | null;
  width?: number;
  dash?: number[];
}

export interface SpectrumSpec {
  title: string;
  help?: string;
  df: number;
  maxHz: number;
  lines: SpectrumLine[];
  marks?: { hz: number; label: string; color: string }[];
  peaks?: { hz: number; label: string }[];
  height?: number;
  extraTitle?: HTMLElement | string | null;
}

const color = (c: string): string => (c.startsWith('--') ? cssVar(c) : c);

export function spectrumChart(spec: SpectrumSpec): { el: HTMLElement; destroy: () => void } {
  const box = h('div');
  const legend = h('div', { class: 'legend-inline' }, spec.lines.filter((l) => l.data).map((l) => h('span', { style: `--c:${color(l.color)}` }, l.label)));
  const el = h('div', { class: 'chart-box' }, h('div', { class: 'chart-title' }, spec.title, helpBtn(spec.help), spec.extraTitle ?? null, h('span', { style: 'flex:1' }), legend), box);
  let u: uPlot | null = null;

  const lines = spec.lines.filter((l) => l.data);
  const n = Math.min(lines[0]?.data?.length ?? 0, Math.floor(spec.maxHz / spec.df) + 1);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = i * spec.df;
  // без бина 0 (постоянная составляющая) и 1–2 Гц — там движение стиков
  const from = Math.max(1, Math.ceil(2 / spec.df));
  const data: uPlot.AlignedData = [Array.from(x.subarray(from)), ...lines.map((l) => Array.from(l.data!.subarray(from, n)))];

  const build = (): void => {
    clear(box);
    const grid = { stroke: cssVar('--grid'), width: 1 };
    const fg = cssVar('--fg2');
    u = new uPlot({
      width: Math.max(300, box.clientWidth || 600),
      height: spec.height ?? 260,
      legend: { show: false },
      cursor: { drag: { x: true, y: false }, points: { size: 5 } },
      scales: { x: { time: false } },
      axes: [
        { stroke: fg, grid, ticks: grid, size: 28 },
        { stroke: fg, grid, ticks: grid, size: 42 },
      ],
      series: [{ label: 'Гц' }, ...lines.map((l) => ({ label: l.label, stroke: color(l.color), width: l.width ?? 1.4, dash: l.dash, points: { show: false } }))],
      hooks: {
        draw: [
          (pl: uPlot) => {
            const ctx = pl.ctx;
            const dpr = devicePixelRatio || 1;
            ctx.save();
            ctx.font = `${11 * dpr}px system-ui`;
            for (const m of spec.marks ?? []) {
              const px = pl.valToPos(m.hz, 'x', true);
              if (px < pl.bbox.left || px > pl.bbox.left + pl.bbox.width) continue;
              ctx.strokeStyle = color(m.color);
              ctx.fillStyle = color(m.color);
              ctx.setLineDash([5 * dpr, 4 * dpr]);
              ctx.lineWidth = dpr;
              ctx.beginPath();
              ctx.moveTo(px, pl.bbox.top);
              ctx.lineTo(px, pl.bbox.top + pl.bbox.height);
              ctx.stroke();
              ctx.fillText(m.label, px + 3 * dpr, pl.bbox.top + 12 * dpr);
            }
            ctx.setLineDash([]);
            ctx.fillStyle = cssVar('--fg');
            for (const p of spec.peaks ?? []) {
              const px = pl.valToPos(p.hz, 'x', true);
              const i = Math.round(p.hz / spec.df) - from;
              const yv = (data[1] as number[])[i];
              if (yv === undefined) continue;
              const py = pl.valToPos(yv, 'y', true);
              ctx.beginPath();
              ctx.arc(px, py, 3.5 * dpr, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillText(p.label, px + 5 * dpr, py - 5 * dpr);
            }
            ctx.restore();
          },
        ],
      },
    }, data, box);
  };

  const ro = new ResizeObserver(() => {
    if (!u) return;
    const w = Math.max(300, box.clientWidth);
    if (Math.abs(w - u.width) > 2) u.setSize({ width: w, height: spec.height ?? 260 });
  });
  requestAnimationFrame(() => {
    build();
    ro.observe(box);
  });
  return { el, destroy: () => { ro.disconnect(); u?.destroy(); } };
}
