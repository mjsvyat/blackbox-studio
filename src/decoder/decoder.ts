// Декодер блэкбокса Betaflight. TS-порт bb-tools/bbdec.js с сохранением логики
// (предикторы, кодировки, ресинхронизация по следующему 'I'), плюс:
//  - колоночное хранение всех полей (Int16/Int32), без копии кадра на каждый шаг;
//  - время разворачивается в Float64 (uint32-счётчик мкс может перевалить 2^31);
//  - учёт «дыр» (битые участки) с временем и смещением в байтах;
//  - predictor INC учитывает P interval (как официальный декодер);
//  - LOGGING_RESUME сбрасывает историю (следом обязан идти I-кадр);
//  - INFLIGHT_ADJUSTMENT с float-значением читает 4 байта, как в blackbox-tools.

import { DISARM_REASONS, ENC, EVENT, FLIGHT_MODES, PRED, bitNames } from './constants';
import { FieldDef, frameDef, loopTiming, parseHeader } from './header';
import { Stream } from './stream';

export interface LogEvent {
  /** время последнего основного кадра перед событием, мкс (развёрнутое) */
  t: number;
  type: number;
  name: string;
  reason?: string;
  time?: number;
  iter?: number;
  newFlags?: number;
  lastFlags?: number;
  on?: string[];
  off?: string[];
  adjFunction?: number;
  adjValue?: number;
  msg?: string;
}

export interface SlowRecord {
  t: number;
  v: number[];
}

export interface Hole {
  /** время последнего хорошего кадра до дыры, мкс; null — дыра в самом начале */
  t0: number | null;
  /** время первого хорошего кадра после дыры, мкс; null — дыра до конца лога */
  t1: number | null;
  byteStart: number;
  byteEnd: number;
}

export interface FrameCounts {
  I: number; P: number; G: number; H: number; S: number; E: number;
  bad: number; resync: number;
}

export type Column = Int16Array | Int32Array;

export interface DecodedLog {
  header: Record<string, string>;
  fieldNames: string[];
  index: Record<string, number>;
  /** число основных кадров (I+P) */
  n: number;
  /** время каждого кадра, мкс, развёрнутое (монотонное в пределах лога) */
  time: Float64Array;
  /** cols[i] — значения поля fieldNames[i]; пустой массив, если хранение выключено */
  cols: Column[];
  events: LogEvent[];
  slow: SlowRecord[];
  slowFieldNames: string[];
  gps: number[][];
  gpsFieldNames: string[];
  gpsHome: number[] | null;
  frames: FrameCounts;
  end: 'LOG_END' | 'TRUNCATED' | 'STOP';
  holes: Hole[];
  /** байт данных, которые пришлось пропустить при ресинхронизации */
  lostBytes: number;
  dataBytes: number;
  dataStart: number;
  repairedHeader: boolean;
}

export interface DecodeOptions {
  /** хранить все поля по кадрам (по умолчанию true) */
  store?: boolean;
  /** вызов на каждый принятый основной кадр (совместимость с bbdec.js) */
  onFrame?: (cur: Int32Array, timeUs: number, index: Record<string, number>, isI: boolean) => void;
  onProgress?: (fraction: number) => void;
  /** начать разбор данных не с начала (быстрая оценка хвоста лога) */
  dataOffset?: number;
}

const isFrameType = (c: number): boolean =>
  c === 0x49 || c === 0x50 || c === 0x47 || c === 0x48 || c === 0x53 || c === 0x45;

class ColumnStore {
  data: Int32Array[];
  cap: number;
  n = 0;
  time: Float64Array;
  constructor(nFields: number, cap: number) {
    this.cap = Math.max(1024, cap);
    this.data = Array.from({ length: nFields }, () => new Int32Array(this.cap));
    this.time = new Float64Array(this.cap);
  }
  push(cur: Int32Array, t: number): void {
    if (this.n === this.cap) {
      const nc = Math.ceil(this.cap * 1.5);
      this.data = this.data.map((a) => {
        const b = new Int32Array(nc);
        b.set(a);
        return b;
      });
      const tt = new Float64Array(nc);
      tt.set(this.time);
      this.time = tt;
      this.cap = nc;
    }
    const n = this.n;
    const d = this.data;
    for (let f = 0; f < d.length; f++) d[f][n] = cur[f];
    this.time[n] = t;
    this.n++;
  }
  /** обрезка до n и упаковка в Int16 там, где значения помещаются */
  finish(): { cols: Column[]; time: Float64Array } {
    const n = this.n;
    const cols = this.data.map((a) => {
      let mn = 0, mx = 0;
      for (let i = 0; i < n; i++) {
        const v = a[i];
        if (v < mn) mn = v;
        else if (v > mx) mx = v;
      }
      if (mn >= -32768 && mx <= 32767) {
        const s = new Int16Array(n);
        for (let i = 0; i < n; i++) s[i] = a[i];
        return s;
      }
      return a.slice(0, n);
    });
    return { cols, time: this.time.slice(0, n) };
  }
}

export function decodeLog(buf: Uint8Array, start = 0, endLimit = buf.length, opts: DecodeOptions = {}): DecodedLog {
  const { H, dataStart } = parseHeader(buf, start);
  const defI = frameDef(H, 'I');
  if (!defI) throw new Error('В заголовке нет описания I-кадров (Field I name) — это не лог Betaflight или он обрезан.');
  const defP = frameDef(H, 'P', 'I')!;
  const defG = frameDef(H, 'G');
  const defHm = frameDef(H, 'H');
  const defS = frameDef(H, 'S');
  const nMain = defI.count;
  const idx: Record<string, number> = {};
  defI.names.forEach((n, i) => {
    idx[n] = i;
  });

  const minthrottle = Number(H['minthrottle'] || 1070);
  const motorOutput = (H['motorOutput'] || '158,2047').split(',').map(Number);
  const minmotor = motorOutput[0];
  const vbatref = Number(H['vbatref'] || 0);
  const pInterval = Math.max(1, Math.round(loopTiming(H).pInterval));

  // история: prev1 — последний кадр, prev2 — предыдущий; три буфера по кругу
  let prev1 = new Int32Array(nMain);
  let prev2 = new Int32Array(nMain);
  let spare = new Int32Array(nMain);
  let cur = new Int32Array(nMain);
  let valid = false;
  const vals = new Int32Array(8);

  const firstData = opts.dataOffset !== undefined ? Math.max(dataStart, opts.dataOffset) : dataStart;
  const st = new Stream(buf, firstData, endLimit);
  const store = opts.store !== false ? new ColumnStore(nMain, Math.ceil((endLimit - firstData) / 30)) : null;

  const res: DecodedLog = {
    header: H,
    fieldNames: defI.names,
    index: idx,
    n: 0,
    time: new Float64Array(0),
    cols: [],
    events: [],
    slow: [],
    slowFieldNames: defS ? defS.names : [],
    gps: [],
    gpsFieldNames: defG ? defG.names : [],
    gpsHome: null,
    frames: { I: 0, P: 0, G: 0, H: 0, S: 0, E: 0, bad: 0, resync: 0 },
    end: 'STOP',
    holes: [],
    lostBytes: 0,
    dataBytes: endLimit - firstData,
    dataStart,
    repairedHeader: !!(defI.repairedNames || defP.repairedNames || defS?.repairedNames || defG?.repairedNames),
  };

  const iTime = idx['time'];
  const iMotor0 = idx['motor[0]'];
  const curRef = { v: cur };

  // развёртка uint32-времени
  let lastRaw: number | null = null;
  let wrapAdd = 0;
  let lastTimeUnwrapped: number | null = null;

  // учёт дыр
  let lostSince: number | null = null;
  const markBad = (pos: number): void => {
    if (lostSince === null) lostSince = pos;
  };

  function applyPred(fi: number, pred: number, v: number): number {
    switch (pred) {
      case PRED.ZERO:
        return v;
      case PRED.PREVIOUS:
        return valid ? v + prev1[fi] : v;
      case PRED.STRAIGHT_LINE:
        return valid ? v + (2 * prev1[fi] - prev2[fi]) : v;
      case PRED.AVERAGE_2:
        return valid ? v + Math.trunc((prev1[fi] + prev2[fi]) / 2) : v;
      case PRED.MINTHROTTLE:
        return v + minthrottle;
      case PRED.MOTOR_0:
        return v + curRef.v[iMotor0];
      case PRED.INC:
        return (valid ? prev1[fi] : 0) + pInterval;
      case PRED.C1500:
        return v + 1500;
      case PRED.VBATREF:
        return v + vbatref;
      case PRED.MINMOTOR:
        return v + minmotor;
      case PRED.LAST_MAIN_TIME:
        return v + (valid ? prev1[iTime] : 0);
      default:
        return v;
    }
  }

  /** чтение полей кадра с группировкой по кодировкам; pred(i, v) применяет предиктор */
  function readFields(def: FieldDef, target: Int32Array, pred: (i: number, v: number) => number): void {
    for (let i = 0; i < def.count; i++) {
      const e = def.enc[i];
      if (e === ENC.TAG2_3S32 || e === ENC.TAG2_3SVAR) {
        if (e === ENC.TAG2_3S32) st.tag2_3s32(vals);
        else st.tag2_3svar(vals);
        for (let k = 0; k < 3 && i + k < def.count; k++) target[i + k] = pred(i + k, vals[k]);
        i += 2;
        continue;
      }
      if (e === ENC.TAG8_4S16) {
        st.tag8_4s16(vals);
        for (let k = 0; k < 4 && i + k < def.count; k++) target[i + k] = pred(i + k, vals[k]);
        i += 3;
        continue;
      }
      if (e === ENC.TAG8_8SVB) {
        let j = i + 1;
        while (j < def.count && j < i + 8 && def.enc[j] === ENC.TAG8_8SVB) j++;
        const g = j - i;
        st.tag8_8svb(vals, g);
        for (let k = 0; k < g; k++) target[i + k] = pred(i + k, vals[k]);
        i += g - 1;
        continue;
      }
      let v: number;
      switch (e) {
        case ENC.SVB:
          v = st.svb();
          break;
        case ENC.UVB:
          v = st.uvb();
          break;
        case ENC.NEG14: {
          const u = st.uvb() & 0x3fff;
          v = -((u ^ 0x2000) - 0x2000);
          break;
        }
        case ENC.NULL:
          v = 0;
          break;
        default:
          v = st.svb();
          break;
      }
      target[i] = pred(i, v);
    }
  }

  const mainPredI = (i: number, v: number): number => applyPred(i, defI.pred[i], v);
  const mainPredP = (i: number, v: number): number => applyPred(i, defP.pred[i], v);

  const sv = defS ? new Int32Array(defS.count) : null;
  const gv = defG ? new Int32Array(defG.count) : null;
  const gPrev = defG ? new Int32Array(defG.count) : null;
  const hv = defHm ? new Int32Array(defHm.count) : null;

  const progressStep = 1 << 18;
  let nextProgress = firstData + progressStep;
  const total = Math.max(1, endLimit - firstData);

  let guard = 0;
  while (st.p < endLimit && !st.eof) {
    if (++guard > 80_000_000) break;
    if (opts.onProgress && st.p >= nextProgress) {
      opts.onProgress((st.p - firstData) / total);
      nextProgress = st.p + progressStep;
    }
    const fp = st.p;
    const t = st.byte();
    if (t === 0x49 || t === 0x50) {
      const isI = t === 0x49;
      if (!isI && !valid) {
        res.frames.bad++;
        markBad(fp);
        st.p = fp + 1;
        continue;
      }
      cur.fill(0);
      curRef.v = cur;
      readFields(isI ? defI : defP, cur, isI ? mainPredI : mainPredP);
      const nb = st.peek();
      if (!isFrameType(nb) && st.p < endLimit) {
        res.frames.bad++;
        markBad(fp);
        let q = fp + 1;
        while (q < endLimit && buf[q] !== 0x49) q++;
        st.p = q;
        valid = false;
        res.frames.resync++;
        continue;
      }
      const tm = cur[iTime];
      if (isI) {
        valid = true;
      } else {
        const dt = (tm - prev1[iTime]) | 0;
        if (dt < 0 || dt > 200000) {
          res.frames.bad++;
          markBad(fp);
          valid = false;
          continue;
        }
      }
      // развёрнутое время
      const raw = tm >>> 0;
      if (lastRaw !== null && raw < lastRaw && lastRaw - raw > 0x80000000) wrapAdd += 0x100000000;
      lastRaw = raw;
      const tu = raw + wrapAdd;

      if (lostSince !== null) {
        res.holes.push({ t0: lastTimeUnwrapped, t1: tu, byteStart: lostSince, byteEnd: fp });
        res.lostBytes += fp - lostSince;
        lostSince = null;
      }
      lastTimeUnwrapped = tu;

      // ротация истории без аллокаций
      if (isI) {
        prev2.set(cur);
        const tmp = prev1;
        prev1 = cur;
        cur = tmp;
      } else {
        const tmp = prev2;
        prev2 = prev1;
        prev1 = cur;
        cur = spare;
        spare = tmp;
      }
      res.frames[isI ? 'I' : 'P']++;
      if (store) store.push(prev1, tu);
      if (opts.onFrame) opts.onFrame(prev1, tm, idx, isI);
    } else if (t === 0x53 && defS && sv) {
      sv.fill(0);
      readFields(defS, sv, (_i, v) => v);
      res.frames.S++;
      const rec: SlowRecord = { t: lastTimeUnwrapped ?? 0, v: Array.from(sv) };
      const prev = res.slow.length ? res.slow[res.slow.length - 1].v : null;
      if (!prev || prev.some((x, i) => x !== rec.v[i])) res.slow.push(rec);
    } else if (t === 0x47 && defG && gv && gPrev) {
      readFields(defG, gv, (i, v) => {
        switch (defG.pred[i]) {
          case PRED.LAST_MAIN_TIME:
            return v + (prev1[iTime] || 0);
          case PRED.HOME_COORD:
            return v + (res.gpsHome ? res.gpsHome[i - 2] ?? 0 : 0);
          case PRED.PREVIOUS:
            return v + gPrev[i];
          default:
            return v;
        }
      });
      gPrev.set(gv);
      res.frames.G++;
      if (res.gps.length < 200000) res.gps.push(Array.from(gv));
    } else if (t === 0x48 && defHm && hv) {
      readFields(defHm, hv, (_i, v) => v);
      res.gpsHome = Array.from(hv);
      res.frames.H++;
    } else if (t === 0x45) {
      const etype = st.byte();
      res.frames.E++;
      const ev: LogEvent = { t: lastTimeUnwrapped ?? 0, type: etype, name: '' };
      if (etype === EVENT.SYNC_BEEP) {
        ev.name = 'SYNC_BEEP';
        ev.time = st.uvb();
      } else if (etype === EVENT.INFLIGHT_ADJUSTMENT) {
        ev.name = 'INFLIGHT_ADJUSTMENT';
        const f = st.byte();
        ev.adjFunction = f & 127;
        ev.adjValue = f & 128 ? st.rawFloat() : st.svb();
      } else if (etype === EVENT.LOGGING_RESUME) {
        ev.name = 'LOGGING_RESUME';
        ev.iter = st.uvb();
        ev.time = st.uvb();
        valid = false;
      } else if (etype === EVENT.DISARM) {
        ev.name = 'DISARM';
        const r = st.uvb();
        ev.reason = DISARM_REASONS[r] || '#' + r;
      } else if (etype === EVENT.FLIGHT_MODE) {
        ev.name = 'FLIGHTMODE';
        ev.newFlags = st.uvb();
        ev.lastFlags = st.uvb();
        ev.on = bitNames(ev.newFlags & ~ev.lastFlags, FLIGHT_MODES);
        ev.off = bitNames(ev.lastFlags & ~ev.newFlags, FLIGHT_MODES);
      } else if (etype === EVENT.LOG_END) {
        ev.name = 'LOG_END';
        ev.msg = st.str();
        res.events.push(ev);
        res.end = 'LOG_END';
        break;
      } else {
        ev.name = 'UNKNOWN_' + etype;
        res.frames.bad++;
      }
      res.events.push(ev);
    } else {
      // мусор — ресинхронизация на следующий 'I'
      res.frames.bad++;
      markBad(fp);
      let q = fp + 1;
      while (q < endLimit && buf[q] !== 0x49) q++;
      if (q >= endLimit) break;
      st.p = q;
      valid = false;
      res.frames.resync++;
    }
  }
  if (res.end !== 'LOG_END') res.end = st.p >= endLimit ? 'TRUNCATED' : 'STOP';
  if (lostSince !== null) {
    res.holes.push({ t0: lastTimeUnwrapped, t1: null, byteStart: lostSince, byteEnd: endLimit });
    res.lostBytes += endLimit - lostSince;
  }
  if (store) {
    const f = store.finish();
    res.cols = f.cols;
    res.time = f.time;
    res.n = store.n;
  } else res.n = res.frames.I + res.frames.P;
  opts.onProgress?.(1);
  return res;
}

/** колонка по имени поля или null */
export function col(log: DecodedLog, name: string): Column | null {
  const i = log.index[name];
  return i === undefined ? null : log.cols[i];
}
