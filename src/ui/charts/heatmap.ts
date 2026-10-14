// Тепловая карта спектрограммы на canvas: частота по X, газ (снизу вверх) или
// время (сверху вниз) по Y, линии гармоник моторов поверх.

import type { Spectrogram } from '../../dsp/spectrum';
import { cssVar, h } from '../dom';
import { helpBtn } from '../help';

export interface HeatmapSpec {
  title: string;
  help?: string;
  spec: Spectrogram;
  maxHz: number;
  mode: 'throttle' | 'time';
  height?: number;
  harmonics?: number;
  yLabel: string;
  xLabel: string;
  onRowClick?: (value: number) => void;
  extraTitle?: HTMLElement | null;
}

// палитра «inferno» по опорным точкам
const STOPS: [number, number, number, number][] = [
  [0, 0, 0, 4], [0.13, 31, 12, 72], [0.25, 85, 15, 109], [0.38, 136, 34, 106], [0.5, 186, 54, 85],
  [0.63, 227, 89, 51], [0.75, 249, 140, 10], [0.88, 249, 201, 50], [1, 252, 255, 164],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, r0, g0, b0] = STOPS[k];
    const [t1, r1, g1, b1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    lut[i * 3] = r0 + (r1 - r0) * f;
    lut[i * 3 + 1] = g0 + (g1 - g0) * f;
    lut[i * 3 + 2] = b0 + (b1 - b0) * f;
  }
  return lut;
})();

export function heatmap(hs: HeatmapSpec): { el: HTMLElement; destroy: () => void } {
  const canvas = h('canvas');
  const tip = h('div', { class: 'tip' });
  const wrap = h('div', { class: 'heat' }, canvas, tip);
  const el = h('div', { class: 'chart-box' }, h('div', { class: 'chart-title' }, hs.title, helpBtn(hs.help), hs.extraTitle ?? null), wrap);
  const S = hs.spec;
  const colsShown = Math.min(S.cols, Math.floor(hs.maxHz / S.df) + 1);
  const firstCol = Math.max(1, Math.ceil(10 / S.df));
  const ML = 46, MB = 34, MT = 6, MR = 8;

  // диапазон цвета по перцентилям
  const vals: number[] = [];
  for (let r = 0; r < S.rows; r++) for (let c = firstCol; c < colsShown; c += 2) {
    const v = S.data[r * S.cols + c];
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const lo = vals.length ? vals[Math.floor(vals.length * 0.03)] : -60;
  const hi = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.998))] : 0;

  // картинка в «родном» разрешении: colsShown × rows
  const img = document.createElement('canvas');
  img.width = colsShown - firstCol;
  img.height = S.rows;
  {
    const ictx = img.getContext('2d')!;
    const id = ictx.createImageData(img.width, img.height);
    for (let r = 0; r < S.rows; r++) {
      // газ: 0 % внизу → строка 0 рисуется снизу
      const y = hs.mode === 'throttle' ? S.rows - 1 - r : r;
      for (let c = firstCol; c < colsShown; c++) {
        const v = S.data[r * S.cols + c];
        const o = (y * img.width + (c - firstCol)) * 4;
        if (!Number.isFinite(v)) { id.data[o + 3] = 0; continue; }
        const k = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo || 1)) * 255)));
        id.data[o] = LUT[k * 3]; id.data[o + 1] = LUT[k * 3 + 1]; id.data[o + 2] = LUT[k * 3 + 2]; id.data[o + 3] = 255;
      }
    }
    ictx.putImageData(id, 0, 0);
  }

  const draw = (): void => {
    const dpr = devicePixelRatio || 1;
    const W = Math.max(300, wrap.clientWidth || 600);
    const H = hs.height ?? 260;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const pw = W - ML - MR, ph = H - MT - MB;
    ctx.fillStyle = cssVar('--bg3');
    ctx.fillRect(ML, MT, pw, ph);
    ctx.imageSmoothingEnabled = S.rows > ph;
    ctx.drawImage(img, ML, MT, pw, ph);
    const fx = (hz: number): number => ML + ((hz - firstCol * S.df) / ((colsShown - firstCol) * S.df)) * pw;
    const fy = (r: number): number => (hs.mode === 'throttle' ? MT + ph - ((r + 0.5) / S.rows) * ph : MT + ((r + 0.5) / S.rows) * ph);

    // гармоники моторов
    const nh = hs.harmonics ?? 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2;
    for (let k = 1; k <= nh; k++) {
      ctx.setLineDash(k === 1 ? [] : [4, 3]);
      ctx.beginPath();
      let started = false;
      for (let r = 0; r < S.rows; r++) {
        const m = S.motorHz[r];
        if (!Number.isFinite(m) || m <= 0 || (hs.mode === 'throttle' && S.counts[r] < 2)) { started = false; continue; }
        const xx = fx(m * k), yy = fy(r);
        if (xx > ML + pw) { started = false; continue; }
        if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // оси
    ctx.fillStyle = cssVar('--fg2');
    ctx.strokeStyle = cssVar('--line');
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    const step = hs.maxHz > 600 ? 100 : 50;
    for (let f = step; f < hs.maxHz; f += step) {
      const xx = fx(f);
      if (xx < ML) continue;
      ctx.fillText(String(f), xx, H - MB + 14);
      ctx.beginPath(); ctx.moveTo(xx, MT + ph); ctx.lineTo(xx, MT + ph + 4); ctx.stroke();
    }
    ctx.fillText(hs.xLabel, ML + pw / 2, H - 2);
    ctx.textAlign = 'right';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const r = (i / ticks) * (S.rows - 1);
      const val = S.rowValue[Math.round(r)];
      const yy = fy(r);
      ctx.fillText(hs.mode === 'throttle' ? `${(((i / ticks) * 100)).toFixed(0)}` : val.toFixed(0), ML - 6, yy + 4);
    }
    ctx.save();
    ctx.translate(11, MT + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(hs.yLabel, 0, 0);
    ctx.restore();
  };

  const rowAt = (py: number): number => {
    const H = hs.height ?? 260;
    const ph = H - MT - MB;
    const t = (py - MT) / ph;
    const r = hs.mode === 'throttle' ? Math.floor((1 - t) * S.rows) : Math.floor(t * S.rows);
    return Math.max(0, Math.min(S.rows - 1, r));
  };

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const W = rect.width, H = rect.height;
    const pw = W - ML - MR;
    if (px < ML || px > W - MR || py < MT || py > H - MB) { tip.style.display = 'none'; return; }
    const hz = firstCol * S.df + ((px - ML) / pw) * (colsShown - firstCol) * S.df;
    const r = rowAt(py);
    const v = S.data[r * S.cols + Math.round(hz / S.df)];
    const rowTxt = hs.mode === 'throttle' ? `газ ${S.rowValue[r].toFixed(0)} %` : `${S.rowValue[r].toFixed(2)} с`;
    const m = S.motorHz[r];
    tip.textContent = `${hz.toFixed(0)} Гц · ${rowTxt} · ${Number.isFinite(v) ? v.toFixed(1) + ' дБ' : 'нет данных'}${Number.isFinite(m) ? ` · моторы ${m.toFixed(0)} Гц` : ''}`;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(px + 12, W - 260)}px`;
    tip.style.top = `${py + 12}px`;
  });
  canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  if (hs.onRowClick) {
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      hs.onRowClick!(S.rowValue[rowAt(e.clientY - rect.top)]);
    });
  }

  const ro = new ResizeObserver(() => draw());
  requestAnimationFrame(() => { draw(); ro.observe(wrap); });
  return { el, destroy: () => ro.disconnect() };
}
