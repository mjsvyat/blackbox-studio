// Видео из очков рядом с логом (D): открыть MOV/MP4 (URL.createObjectURL — без загрузки в
// память), сдвиг «видео = лог + offset» по часам и по движению кадра, ручная подстройка,
// общий курсор с графиками, переход к событию, покадровый режим, оверлей.

import { T } from '../i18n/ru';
import { MovMeta, codecMime, fileByteReader, readMovMeta } from '../video/mov';
import { CoarseSync, coarseOffset, fineOffset, frameDiff, logStartMs } from '../video/sync';
import { onCursorTime, setCursorTime } from './charts/timechart';
import { fmtTime, h } from './dom';
import { helpBtn } from './help';
import { fetchSeries, saveVideoToSession, set, state, subscribe } from './store';

interface VideoState {
  file: File;
  url: string;
  meta: MovMeta | null;
  metaErr: string | null;
  /** canPlayType: '' — точно нет; 'decode-error' — не смог декодировать */
  codec: 'ok' | 'no' | 'decode-error';
  offsetS: number;
  source: 'clock' | 'motion' | 'manual' | 'saved' | 'none';
  coarse: CoarseSync | null;
  msg: string | null;
  busy: number | null;
  overlay: boolean;
}

let V: VideoState | null = null;
let el: HTMLVideoElement | null = null;
let ov: HTMLCanvasElement | null = null;
/** ряды для оверлея: время, газ %, |ω|, напряжение */
let ovData: { x: Float64Array; thr: Float32Array; rate: Float32Array; vbat: Float32Array } | null = null;
let logKey = '';

const tick = (): void => set({ videoTick: state.videoTick + 1 });
const fps = (): number => V?.meta?.video?.fps || 30;

function storageKey(): string | null {
  if (!state.info || !V) return null;
  return `bb-video-${state.fileName}#${state.info.index}#${state.info.datetime}#${V.file.name}#${V.file.size}`;
}

/** открытый лог сменился — видео к прошлому логу закрываем */
subscribe((_s, ch) => {
  if (!ch.has('info')) return;
  const k = state.info ? `${state.fileName}#${state.info.index}` : '';
  if (k !== logKey) {
    logKey = k;
    if (V) closeVideo();
  }
});

// курсор графиков → видео (если видео на паузе)
let seekRaf = 0;
onCursorTime((t) => {
  if (!el || !V || !el.paused) return;
  cancelAnimationFrame(seekRaf);
  seekRaf = requestAnimationFrame(() => seekLog(t));
});

export function videoLoaded(): boolean {
  return !!V;
}

/** перейти к моменту лога (с) */
export function seekLog(t: number): void {
  if (!el || !V) return;
  const vt = t + V.offsetS;
  if (vt >= 0 && (!Number.isFinite(el.duration) || vt <= el.duration)) el.currentTime = vt;
  drawOverlay();
}

export async function openVideo(file: File): Promise<void> {
  if (V) closeVideo();
  V = { file, url: URL.createObjectURL(file), meta: null, metaErr: null, codec: 'ok', offsetS: 0, source: 'none', coarse: null, msg: null, busy: null, overlay: false };
  try {
    V.meta = await readMovMeta(fileByteReader(file));
  } catch (e) {
    V.metaErr = e instanceof Error ? e.message : String(e);
  }
  const probe = document.createElement('video');
  if (V.meta?.video && probe.canPlayType(codecMime(V.meta.video.codec)) === '') V.codec = 'no';
  // сохранённый сдвиг для этой пары «лог + видео», иначе — по часам
  const k = storageKey();
  let saved: number | null = null;
  try {
    saved = k ? JSON.parse(localStorage.getItem(k) ?? 'null') : null;
  } catch {
    saved = null;
  }
  if (state.info && V.meta) V.coarse = coarseOffset(logStartMs(state.info.datetime), state.info.durationS, V.meta.createdMs, V.meta.durationS);
  if (typeof saved === 'number') setOffset(saved, 'saved', false);
  else if (V.coarse?.offsetS !== null && V.coarse?.offsetS !== undefined) setOffset(V.coarse.offsetS, 'clock', false);
  else V.msg = T.video.noClock;
  makeElement();
  tick();
}

export function closeVideo(): void {
  if (!V) return;
  el?.pause();
  URL.revokeObjectURL(V.url);
  V = null;
  el = null;
  ov = null;
  tick();
}

function makeElement(): void {
  if (!V) return;
  el = h('video', { src: V.url, controls: true, preload: 'metadata', playsinline: true, class: 'video-el' }) as HTMLVideoElement;
  el.muted = true;
  el.addEventListener('error', () => {
    if (V) {
      V.codec = 'decode-error';
      tick();
    }
  });
  ov = h('canvas', { class: 'video-ov' }) as HTMLCanvasElement;
  // видео → курсор графиков (во время воспроизведения и после перемотки)
  const follow = (): void => {
    if (!el || !V || !state.info) return;
    const t = el.currentTime - V.offsetS;
    if (t >= 0 && t <= state.info.durationS) setCursorTime(t);
    drawOverlay();
  };
  type RVFC = (cb: () => void) => number;
  const rvfc = (el as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(el);
  const loop = (): void => {
    if (!el) return;
    follow();
    if (!el.paused && rvfc) rvfc(loop);
  };
  el.addEventListener('play', () => (rvfc ? rvfc(loop) : undefined));
  el.addEventListener('timeupdate', () => { if (!rvfc || el?.paused) follow(); });
  el.addEventListener('seeked', follow);
}

function setOffset(o: number, source: VideoState['source'], persist = true): void {
  if (!V) return;
  V.offsetS = Math.round(o * 1000) / 1000;
  V.source = source;
  if (!persist) return;
  const k = storageKey();
  try {
    if (k) localStorage.setItem(k, JSON.stringify(V.offsetS));
  } catch {
    /* приватный режим */
  }
  void saveVideoToSession({ name: V.file.name, size: V.file.size, offsetS: V.offsetS });
}

function nudge(ds: number): void {
  if (!V || !el) return;
  // картинка стоит на месте, сдвигается привязка: тот же кадр теперь соответствует другому моменту лога
  setOffset(V.offsetS + ds, 'manual');
  const t = el.currentTime - V.offsetS;
  if (state.info && t >= 0 && t <= state.info.durationS) setCursorTime(t);
  drawOverlay();
  tick();
}

function stepFrame(n: number): void {
  if (!el) return;
  el.pause();
  el.currentTime = Math.max(0, el.currentTime + n / fps());
}

async function loadOverlayData(): Promise<void> {
  if (ovData || !state.info) return;
  const d = state.info.durationS;
  const r = await fetchSeries(['thr', 'rate', 'vbat'], 0, d, Math.min(20000, Math.ceil(d * 10)));
  ovData = { x: r.x, thr: r.ys[0], rate: r.ys[1], vbat: r.ys[2] };
}

function at(x: Float64Array, t: number): number {
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (x[m] <= t) lo = m;
    else hi = m;
  }
  return lo;
}

function drawOverlay(): void {
  if (!ov || !el || !V) return;
  const c = ov.getContext('2d');
  if (!c) return;
  ov.width = el.clientWidth;
  ov.height = el.clientHeight;
  c.clearRect(0, 0, ov.width, ov.height);
  if (!V.overlay || !ovData || !state.info) return;
  const t = el.currentTime - V.offsetS;
  const text = t < 0 || t > state.info.durationS
    ? T.video.outside
    : (() => {
        const i = at(ovData.x, t);
        const v = ovData.vbat[i];
        return T.video.ov(ovData.thr[i], ovData.rate[i], Number.isFinite(v) && state.info.cells ? v / state.info.cells : null);
      })();
  c.font = '600 15px system-ui, sans-serif';
  const w = c.measureText(text).width + 16;
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.fillRect(8, 8, w, 26);
  c.fillStyle = '#fff';
  c.fillText(text, 16, 27);
}

/**
 * Сдвиг по движению: второе (скрытое) видео проигрывается ускоренно, каждый кадр уменьшается до
 * 64×36 и сравнивается с прошлым; ряд «движение кадра» коррелируется с |ω| из лога.
 */
async function autoSync(): Promise<void> {
  if (!V || !state.info || !V.meta || V.busy !== null) return;
  const dur = V.meta.durationS || 0;
  const logDur = state.info.durationS;
  const coarse = V.coarse?.offsetS ?? null;
  // окно видео: вокруг лога по часам ±20 с, без часов — всё видео (до 10 мин)
  const a = coarse !== null ? Math.max(0, coarse - 20) : 0;
  const b = coarse !== null ? Math.min(dur, coarse + logDur + 20) : Math.min(dur, 600);
  V.busy = 0;
  V.msg = null;
  tick();
  try {
    const motion = await sampleMotion(V.url, a, b, (p) => {
      if (V) {
        V.busy = p;
        tick();
      }
    });
    const r = await fetchSeries(['rate'], 0, logDur, Math.ceil(logDur * 25));
    // min/max-пары → максимум за бин: огибающая вращения
    const lt: number[] = [], lv: number[] = [];
    if (r.raw) r.x.forEach((x, i) => { lt.push(x); lv.push(r.ys[0][i]); });
    else for (let i = 0; i + 1 < r.x.length; i += 2) { lt.push(r.x[i]); lv.push(Math.max(r.ys[0][i], r.ys[0][i + 1])); }
    const center = coarse ?? (dur - logDur) / 2;
    const range = coarse !== null ? 15 : (dur + logDur) / 2;
    const f = fineOffset(lt, lv, motion.t, motion.v, center, range, 30);
    if (!V) return;
    if (!f) V.msg = T.video.autoFail;
    else {
      setOffset(f.offsetS, 'motion');
      const o = T.video.sec(f.offsetS, 3);
      V.msg = f.score > 0.35 && f.margin > 1.3 ? T.video.autoOk(o, f.score) : T.video.autoWeak(o, f.score);
    }
  } catch {
    if (V) V.msg = T.video.autoFail;
  } finally {
    if (V) V.busy = null;
    tick();
  }
}

function sampleMotion(url: string, a: number, b: number, onProgress: (p: number) => void): Promise<{ t: number[]; v: number[] }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    // за краем экрана, но в документе: иначе браузер не отдаёт кадры (requestVideoFrameCallback)
    v.setAttribute('style', 'position:fixed;left:-4000px;top:0;width:160px;height:90px');
    document.body.append(v);
    v.src = url;
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 36;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null;
    let prevT = -1;
    let finished = false;
    const t: number[] = [], m: number[] = [];
    type RVFC = (cb: (now: number, md: { mediaTime: number }) => void) => number;
    const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
    const grab = (mt: number): void => {
      cx.drawImage(v, 0, 0, 64, 36);
      const d = cx.getImageData(0, 0, 64, 36).data;
      if (prev && mt > prevT) {
        t.push((mt + prevT) / 2);
        m.push(frameDiff(prev, d) / Math.max(1e-3, mt - prevT) / 30);
      }
      prev = new Uint8ClampedArray(d);
      prevT = mt;
      onProgress(Math.min(100, ((mt - a) / Math.max(1e-6, b - a)) * 100));
    };
    const done = (): void => {
      if (finished) return;
      finished = true;
      v.pause();
      v.removeAttribute('src');
      v.remove();
      resolve({ t, v: m });
    };
    // запасной путь: перемотка по 1/20 с (медленнее, но работает везде)
    const seekMode = (): void => {
      v.pause();
      const stepS = 1 / 20;
      prev = null;
      v.addEventListener('seeked', () => {
        if (finished) return;
        grab(v.currentTime);
        if (v.currentTime + stepS > b) done();
        else v.currentTime += stepS;
      });
      v.currentTime = Math.max(a, prevT > a ? prevT : a);
    };
    v.addEventListener('error', () => { v.remove(); reject(new Error('decode')); });
    v.addEventListener('loadedmetadata', () => { v.currentTime = a; }, { once: true });
    v.addEventListener('seeked', () => {
      if (!rvfc) return seekMode();
      let got = false;
      const cb = (_now: number, md: { mediaTime: number }): void => {
        if (finished) return;
        got = true;
        grab(md.mediaTime);
        if (md.mediaTime >= b || v.ended) done();
        else rvfc(cb);
      };
      rvfc(cb);
      v.playbackRate = 4;
      void v.play().catch(() => seekMode());
      v.addEventListener('ended', done, { once: true });
      setTimeout(() => { if (!got && !finished) seekMode(); }, 2000);
    }, { once: true });
  });
}

/** панель «Видео из очков» (вкладка «Полёт и события») */
export function videoPanel(): HTMLElement {
  const fileIn = h('input', { type: 'file', accept: 'video/*,.mov,.MOV,.mp4,.MP4', style: 'display:none' }) as HTMLInputElement;
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    if (f) void openVideo(f);
    fileIn.value = '';
  });
  const box = h('div', { class: 'panel' }, h('h3', { style: 'margin-top:0' }, T.video.title, helpBtn('video-sync')), fileIn);
  if (!V) {
    box.append(h('p', { class: 'muted small' }, T.video.intro), h('button', { class: 'btn', onclick: () => fileIn.click() }, T.video.open));
    return box;
  }
  const m = V.meta;
  const info = h('div', { class: 'muted small' },
    V.file.name, ' · ',
    m?.video ? T.video.meta(m.video.codec, m.video.width, m.video.height, m.video.fps, fmtTime(m.durationS)) : '',
    h('br'),
    m?.createdMs ? T.video.created(new Date(m.createdMs).toISOString().slice(0, 19).replace('T', ' ')) : T.video.noCreated,
    V.coarse && V.coarse.tzHours ? h('span', null, ' · ', T.video.tz(V.coarse.tzHours)) : '');
  box.append(info);
  if (V.metaErr) box.append(h('div', { class: 'warn-text' }, T.video.notMov(V.metaErr)));
  if (V.codec === 'no') box.append(h('div', { class: 'panel warn small' }, T.video.codecNo(m?.video?.codec ?? '')));
  if (V.codec === 'decode-error') box.append(h('div', { class: 'panel warn small' }, T.video.codecErr));
  if (V.msg) box.append(h('div', { class: 'small', style: 'margin:6px 0' }, V.msg));

  const wrap = h('div', { class: 'video-wrap' });
  if (el && V.codec !== 'no') wrap.append(el, ov ?? '');
  const off = T.video.sec(V.offsetS, 3);
  const nb = (label: string, ds: number): HTMLElement => h('button', { class: 'btn small', onclick: () => nudge(ds) }, label);
  const f1 = 1 / fps();
  const controls = h('div', { class: 'video-ctl' },
    h('div', null, h('b', null, `${T.video.offset} ${off}`), h('span', { class: 'muted small' }, ` (${T.video.src[V.source]})`)),
    h('div', { class: 'row' }, nb(T.video.sec(-1), -1), nb('−0.1', -0.1), nb(`−${T.video.frame}`, -f1), nb(`+${T.video.frame}`, f1), nb('+0.1', 0.1), nb(T.video.sec(1), 1)),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', disabled: V.busy !== null || !V.meta || V.codec !== 'ok', onclick: () => autoSync() }, V.busy !== null ? T.video.autoBusy(V.busy) : T.video.auto),
      V.coarse?.offsetS !== null && V.coarse?.offsetS !== undefined ? h('button', { class: 'btn small', onclick: () => { setOffset(V!.coarse!.offsetS!, 'clock'); tick(); } }, T.video.src.clock) : ''),
    h('div', { class: 'row' },
      h('span', { class: 'small' }, T.video.step),
      h('button', { class: 'btn small', onclick: () => stepFrame(-1) }, '◀'),
      h('button', { class: 'btn small', onclick: () => stepFrame(1) }, '▶'),
      h('span', { class: 'small' }, T.video.rate),
      h('select', { class: 'btn small', onchange: (e: Event) => { if (el) el.playbackRate = Number((e.target as HTMLSelectElement).value); } },
        [0.1, 0.25, 0.5, 1].map((r) => h('option', { value: r, selected: (el?.playbackRate ?? 1) === r }, `${r}×`)))),
    h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: V.overlay, onchange: async (e: Event) => { V!.overlay = (e.target as HTMLInputElement).checked; if (V!.overlay) await loadOverlayData(); drawOverlay(); } }), ` ${T.video.overlay}`),
    eventsSelect(),
    h('button', { class: 'btn small', onclick: closeVideo }, T.video.close));
  box.append(h('div', { class: 'video-row' }, wrap, controls));
  requestAnimationFrame(drawOverlay);
  return box;
}

function eventsSelect(): HTMLElement | string {
  const ev = state.info?.events ?? [];
  if (!ev.length) return '';
  return h('div', { class: 'row small' }, T.video.events,
    h('select', { class: 'btn small', onchange: (e: Event) => { const t = Number((e.target as HTMLSelectElement).value); if (Number.isFinite(t)) { seekLog(t); setCursorTime(t); } } },
      h('option', { value: '' }, '—'), ev.slice(0, 200).map((x) => h('option', { value: x.t }, `${fmtTime(x.t)} ${x.name}`))));
}
