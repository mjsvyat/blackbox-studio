// Картинки для папки случая (plots/*.png): простые графики на canvas, светлый фон —
// чтобы читались в любом просмотрщике и в разборе.

import { AXIS_NAMES, T } from '../../i18n/ru';
import { predictedSpectrum } from '../../sessions/compare';
import type { SessionSnapshot } from '../../sessions/snapshot';

interface Series { label: string; color: string; y: number[]; dash?: number[] }

async function draw(title: string, x: number[], series: Series[], yRange?: [number, number]): Promise<Uint8Array> {
  const W = 900, H = 360, L = 56, R = 16, Tp = 36, B = 36;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const ys = series.flatMap((s) => s.y.filter(Number.isFinite));
  const y0 = yRange ? yRange[0] : Math.min(...ys), y1 = yRange ? yRange[1] : Math.max(...ys);
  const x0 = x[0], x1 = x[x.length - 1];
  const px = (v: number): number => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (v: number): number => H - B - ((v - y0) / (y1 - y0 || 1)) * (H - Tp - B);
  g.strokeStyle = '#ddd'; g.fillStyle = '#555'; g.font = '12px sans-serif';
  for (let i = 0; i <= 5; i++) {
    const yv = y0 + ((y1 - y0) * i) / 5, xv = x0 + ((x1 - x0) * i) / 5;
    g.beginPath(); g.moveTo(L, py(yv)); g.lineTo(W - R, py(yv)); g.stroke();
    g.fillText(yv.toFixed(Math.abs(y1 - y0) < 5 ? 2 : 0), 4, py(yv) + 4);
    g.fillText(xv.toFixed(0), px(xv) - 10, H - B + 16);
  }
  g.fillStyle = '#111'; g.font = 'bold 14px sans-serif'; g.fillText(title, L, 22);
  let lx = W - R;
  g.font = '12px sans-serif';
  for (const s of [...series].reverse()) {
    const w = g.measureText(s.label).width + 26;
    lx -= w;
    g.strokeStyle = s.color; g.setLineDash(s.dash ?? []); g.lineWidth = 2;
    g.beginPath(); g.moveTo(lx, 18); g.lineTo(lx + 16, 18); g.stroke();
    g.fillStyle = '#333'; g.fillText(s.label, lx + 20, 22);
  }
  for (const s of series) {
    g.strokeStyle = s.color; g.setLineDash(s.dash ?? []); g.lineWidth = 1.5;
    g.beginPath();
    let pen = false;
    for (let i = 0; i < x.length; i++) {
      const v = s.y[i];
      if (!Number.isFinite(v)) { pen = false; continue; }
      if (!pen) { g.moveTo(px(x[i]), py(v)); pen = true; } else g.lineTo(px(x[i]), py(v));
    }
    g.stroke();
  }
  const blob: Blob = await new Promise((res) => cv.toBlob((b) => res(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** спектры после фильтров, D-term и step response: было / прогноз / стало */
export async function casePlots(a: SessionSnapshot | null, b: SessionSnapshot): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const C = T.case;
  for (let ax = 0; ax < 3; ax++) {
    const n = Math.min(b.noise.axes[ax].filtDb.length, a ? a.noise.axes[ax].filtDb.length : Infinity, Math.floor(b.noise.nyquist / b.noise.df));
    const x = Array.from({ length: n }, (_, i) => i * b.noise.df);
    const ser: Series[] = [];
    if (a) ser.push({ label: C.was, color: '#888', y: a.noise.axes[ax].filtDb.slice(0, n) });
    const pr = a ? predictedSpectrum(a, ax, 'gyro') : null;
    if (pr) ser.push({ label: C.pred, color: '#2a9d4b', y: pr.slice(0, n), dash: [6, 4] });
    ser.push({ label: C.now, color: '#1f6feb', y: b.noise.axes[ax].filtDb.slice(0, n) });
    out[`spectrum-${ax}-${['roll', 'pitch', 'yaw'][ax]}.png`] = await draw(`${T.ses.specTitle(AXIS_NAMES[ax])}, дБ`, x, ser);
    const dB = b.noise.axes[ax].dtermDb;
    if (ax < 2 && dB) {
      const ds: Series[] = [];
      if (a?.noise.axes[ax].dtermDb) ds.push({ label: C.was, color: '#888', y: a.noise.axes[ax].dtermDb!.slice(0, n) });
      const dp = a ? predictedSpectrum(a, ax, 'dterm') : null;
      if (dp) ds.push({ label: C.pred, color: '#2a9d4b', y: dp.slice(0, n), dash: [6, 4] });
      ds.push({ label: C.now, color: '#1f6feb', y: dB.slice(0, n) });
      out[`dterm-${ax}-${['roll', 'pitch'][ax]}.png`] = await draw(`${T.ses.dSpecTitle(AXIS_NAMES[ax])}, дБ`, x, ds);
    }
    const sb = b.pid?.axes[ax];
    if (sb?.t.length) {
      const sa = a?.pid?.axes[ax];
      const ss: Series[] = [];
      if (sa?.t.length) ss.push({ label: C.was, color: '#888', y: sa.mean });
      ss.push({ label: C.now, color: '#1f6feb', y: sb.mean });
      out[`step-${ax}-${['roll', 'pitch', 'yaw'][ax]}.png`] = await draw(T.ses.stepTitle(AXIS_NAMES[ax]), sb.t.map((v) => v * 1000), ss, [0, 1.6]);
    }
  }
  return out;
}
