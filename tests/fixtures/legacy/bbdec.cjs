'use strict';
// Minimal Betaflight blackbox decoder (header-driven), Node.js, no deps.

const ENC = { SVB: 0, UVB: 1, NEG14: 3, TAG8_8SVB: 6, TAG2_3S32: 7, TAG8_4S16: 8, NULL: 9, TAG2_3SVAR: 10 };
const PRED = {
  ZERO: 0, PREVIOUS: 1, STRAIGHT_LINE: 2, AVERAGE_2: 3, MINTHROTTLE: 4, MOTOR_0: 5,
  INC: 6, HOME_COORD: 7, C1500: 8, VBATREF: 9, LAST_MAIN_TIME: 10, MINMOTOR: 11,
};

function se(v, bits) { const m = 1 << (bits - 1); return (v ^ m) - m; }

class Stream {
  constructor(buf, pos, end) { this.b = buf; this.p = pos; this.end = end; this.eof = false; }
  byte() { if (this.p >= this.end) { this.eof = true; return 0; } return this.b[this.p++]; }
  peek() { return this.p < this.end ? this.b[this.p] : -1; }
  uvb() {
    let r = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.byte();
      r |= (c & 0x7f) * Math.pow(2, shift);
      if (!(c & 0x80)) break;
      shift += 7;
    }
    return r >>> 0;
  }
  svb() { const u = this.uvb(); return (u >>> 1) ^ -(u & 1); }
  tag2_3s32(out) {
    const lead = this.byte();
    switch (lead >> 6) {
      case 0:
        out[0] = se((lead >> 4) & 3, 2); out[1] = se((lead >> 2) & 3, 2); out[2] = se(lead & 3, 2); break;
      case 1: {
        out[0] = se(lead & 0x0f, 4);
        const b = this.byte();
        out[1] = se(b >> 4, 4); out[2] = se(b & 0x0f, 4); break;
      }
      case 2:
        out[0] = se(lead & 0x3f, 6);
        out[1] = se(this.byte() & 0x3f, 6);
        out[2] = se(this.byte() & 0x3f, 6);
        break;
      default: {
        let sel = lead;
        for (let i = 0; i < 3; i++) {
          switch (sel & 3) {
            case 0: out[i] = se(this.byte(), 8); break;
            case 1: { const a = this.byte(), b = this.byte(); out[i] = se(a | (b << 8), 16); break; }
            case 2: { const a = this.byte(), b = this.byte(), c = this.byte(); out[i] = se(a | (b << 8) | (c << 16), 24); break; }
            default: { const a = this.byte(), b = this.byte(), c = this.byte(), d = this.byte(); out[i] = (a | (b << 8) | (c << 16) | (d << 24)) | 0; break; }
          }
          sel >>= 2;
        }
      }
    }
  }
  tag2_3svar(out) {
    const lead = this.byte();
    switch (lead >> 6) {
      case 0:
        out[0] = se((lead >> 4) & 3, 2); out[1] = se((lead >> 2) & 3, 2); out[2] = se(lead & 3, 2); break;
      case 1: {
        out[0] = se(lead & 0x0f, 4);
        const b = this.byte();
        out[1] = se(b >> 4, 4); out[2] = se(b & 0x0f, 4); break;
      }
      case 2: {
        // 6 bits, 5 bits, 5 bits
        const b1 = this.byte();
        out[0] = se(((lead & 0x3f) << 0), 6);
        out[1] = se(b1 >> 3, 5);
        const b2 = this.byte();
        out[2] = se(((b1 & 0x07) << 2) | (b2 >> 6), 5);
        break;
      }
      default: {
        // 8,8,8 / etc - fallback: three signed VB
        out[0] = this.svb(); out[1] = this.svb(); out[2] = this.svb();
      }
    }
  }
  tag8_4s16(out) {
    let sel = this.byte();
    let nib = 0, buf = 0;
    for (let i = 0; i < 4; i++) {
      switch (sel & 3) {
        case 0: out[i] = 0; break;
        case 1:
          if (nib === 0) { buf = this.byte(); out[i] = se(buf >> 4, 4); nib = 1; }
          else { out[i] = se(buf & 0x0f, 4); nib = 0; }
          break;
        case 2:
          if (nib === 0) out[i] = se(this.byte(), 8);
          else { let c = (buf & 0x0f) << 4; buf = this.byte(); c |= buf >> 4; out[i] = se(c, 8); }
          break;
        default:
          if (nib === 0) { const a = this.byte(), b = this.byte(); out[i] = se((a << 8) | b, 16); }
          else { const a = this.byte(), b = this.byte(); out[i] = se(((buf & 0x0f) << 12) | (a << 4) | (b >> 4), 16); buf = b; }
          break;
      }
      sel >>= 2;
    }
  }
  tag8_8svb(out, n) {
    if (n === 1) { out[0] = this.svb(); return; }
    let h = this.byte();
    for (let i = 0; i < 8; i++, h >>= 1) out[i] = (h & 1) ? this.svb() : 0;
  }
  str() { // null-terminated
    let s = '';
    for (;;) { const c = this.byte(); if (c === 0 || this.eof) break; s += String.fromCharCode(c); }
    return s;
  }
}

function parseHeader(buf, start) {
  const H = {};
  let p = start;
  const lines = [];
  while (p < buf.length - 2 && buf[p] === 0x48 && buf[p + 1] === 0x20) {
    const nl = buf.indexOf(0x0A, p);
    if (nl === -1) break;
    lines.push(buf.toString('latin1', p + 2, nl));
    p = nl + 1;
  }
  for (const l of lines) { const c = l.indexOf(':'); if (c > 0) H[l.slice(0, c)] = l.slice(c + 1); }
  return { H, dataStart: p };
}

function frameDef(H, letter, namesFrom) {
  let names = H[`Field ${letter} name`] || (namesFrom ? H[`Field ${namesFrom} name`] : null);
  if (!names) return null;
  // Betaflight <= 2026.6 can duplicate a 64-byte span inside a header line (fixed upstream by
  // PR #15525), splicing partial copies of the name list together separated by ":". Keep the
  // segment whose field count matches the signed/predictor/encoding rows.
  if (names.includes(':')) {
    const want = (H[`Field ${letter} signed`] || H[`Field ${letter} encoding`] || '').split(',').length;
    const segs = names.split(':');
    const good = segs.filter(s => s.split(',').length === want);
    names = good.length ? good[good.length - 1] : segs[segs.length - 1];
  }
  const n = names.split(',');
  const num = (k, def) => {
    const v = H[`Field ${letter} ${k}`];
    return v ? v.split(',').map(Number) : n.map(() => def);
  };
  return { names: n, count: n.length, signed: num('signed', 0), pred: num('predictor', 0), enc: num('encoding', 0) };
}

const DISARM = ['ARMING_DISABLED', 'FAILSAFE', 'THROTTLE_TIMEOUT', 'STICKS', 'SWITCH', 'CRASH_PROTECTION',
  'RUNAWAY_TAKEOFF', 'GPS_RESCUE', 'SERIAL_IO', 'SYSTEM'];

const FLIGHT_MODES = ['ARM', 'ANGLE', 'HORIZON', 'MAG', 'BARO', 'GPSHOME', 'GPSHOLD', 'HEADFREE', 'CHIRP',
  'PASSTHRU', 'RANGEFINDER', 'FAILSAFE', 'GPSRESCUE', 'ANTIGRAVITY', 'HEADADJ', 'CAMSTAB', 'BEEPERON',
  'LEDLOW', 'CALIB', 'OSD', 'TELEMETRY', 'SERVO1', 'SERVO2', 'SERVO3', 'BLACKBOX', 'AIRMODE', '3D',
  'FPVANGLEMIX', 'BLACKBOXERASE', 'CAMERA1', 'CAMERA2', 'CAMERA3'];
const STATE_FLAGS = ['GPS_FIX_HOME', 'GPS_FIX', 'CALIBRATE_MAG', 'SMALL_ANGLE', 'FIXED_WING'];
const FAILSAFE_PHASE = ['IDLE', 'RX_LOSS_DETECTED', 'LANDING', 'LANDED', 'RX_LOSS_MONITORING', 'RX_LOSS_RECOVERED', 'GPS_RESCUE'];

function bits(v, names) {
  const out = [];
  for (let i = 0; i < names.length; i++) if (v & (1 << i)) out.push(names[i]);
  return out;
}

function decodeLog(buf, start, endLimit, opts = {}) {
  const { H, dataStart } = parseHeader(buf, start);
  const defI = frameDef(H, 'I'), defP = frameDef(H, 'P', 'I'), defG = frameDef(H, 'G'),
    defHm = frameDef(H, 'H'), defS = frameDef(H, 'S');
  const nMain = defI.count;
  const idx = {};
  defI.names.forEach((n, i) => { idx[n] = i; });

  const minthrottle = Number(H['minthrottle'] || 1070);
  const motorOutput = (H['motorOutput'] || '158,2047').split(',').map(Number);
  const minmotor = motorOutput[0], maxmotor = motorOutput[1];
  const vbatref = Number(H['vbatref'] || 0);

  // history: prev1 = last frame, prev2 = frame before that
  let prev1 = new Int32Array(nMain), prev2 = new Int32Array(nMain);
  let valid = false;
  const vals = new Int32Array(8);

  const st = new Stream(buf, dataStart, endLimit);

  const res = {
    header: H, events: [], slow: [], gpsHome: null, gps: [],
    frames: { I: 0, P: 0, G: 0, H: 0, S: 0, E: 0, bad: 0, resync: 0 },
    samples: [], // decimated
    stats: null, end: null, dataStart,
  };

  const NF = opts.needFields || {};
  const cur = new Int32Array(nMain);

  function applyPred(fi, pred, v, isI) {
    switch (pred) {
      case PRED.ZERO: return v;
      case PRED.PREVIOUS: return valid ? v + prev1[fi] : v;
      case PRED.STRAIGHT_LINE: return valid ? v + (2 * prev1[fi] - prev2[fi]) : v;
      case PRED.AVERAGE_2: return valid ? v + Math.trunc((prev1[fi] + prev2[fi]) / 2) : v;
      case PRED.MINTHROTTLE: return v + minthrottle;
      case PRED.MOTOR_0: return v + cur[idx['motor[0]']];
      case PRED.INC: return (valid ? prev1[fi] : 0) + 1;
      case PRED.C1500: return v + 1500;
      case PRED.VBATREF: return v + vbatref;
      case PRED.MINMOTOR: return v + minmotor;
      case PRED.HOME_COORD: return v + (res.gpsHome ? res.gpsHome[fi <= 2 ? fi - 2 : 0] : 0);
      case PRED.LAST_MAIN_TIME: return v + (valid ? prev1[idx['time']] : 0);
      default: return v;
    }
  }

  function readFrame(def, target, isI) {
    for (let i = 0; i < def.count; i++) {
      const e = def.enc[i];
      if (e === ENC.TAG2_3S32 || e === ENC.TAG2_3SVAR) {
        if (e === ENC.TAG2_3S32) st.tag2_3s32(vals); else st.tag2_3svar(vals);
        for (let k = 0; k < 3 && i + k < def.count; k++) target[i + k] = applyPred(i + k, def.pred[i + k], vals[k], isI);
        i += 2; continue;
      }
      if (e === ENC.TAG8_4S16) {
        st.tag8_4s16(vals);
        for (let k = 0; k < 4 && i + k < def.count; k++) target[i + k] = applyPred(i + k, def.pred[i + k], vals[k], isI);
        i += 3; continue;
      }
      if (e === ENC.TAG8_8SVB) {
        let j = i + 1;
        while (j < def.count && j < i + 8 && def.enc[j] === ENC.TAG8_8SVB) j++;
        const g = j - i;
        st.tag8_8svb(vals, g);
        for (let k = 0; k < g; k++) target[i + k] = applyPred(i + k, def.pred[i + k], vals[k], isI);
        i += g - 1; continue;
      }
      let v;
      switch (e) {
        case ENC.SVB: v = st.svb(); break;
        case ENC.UVB: v = st.uvb(); break;
        case ENC.NEG14: v = -se(st.uvb(), 14); break;
        case ENC.NULL: v = 0; break;
        default: v = st.svb(); break;
      }
      target[i] = applyPred(i, def.pred[i], v, isI);
    }
  }

  const isFrameType = c => c === 0x49 || c === 0x50 || c === 0x47 || c === 0x48 || c === 0x53 || c === 0x45;

  // running stats
  const S = {
    tStart: null, tEnd: null,
    maxGyro: [0, 0, 0], maxAcc: 0, minVbat: 1e9, maxAmp: 0,
    motorSatSamples: 0, total: 0,
  };

  const iTime = idx['time'];
  const iGyro = [idx['gyroADC[0]'], idx['gyroADC[1]'], idx['gyroADC[2]']];
  const iGyroU = [idx['gyroUnfilt[0]'], idx['gyroUnfilt[1]'], idx['gyroUnfilt[2]']];
  const iAcc = [idx['accSmooth[0]'], idx['accSmooth[1]'], idx['accSmooth[2]']];
  const iMot = [idx['motor[0]'], idx['motor[1]'], idx['motor[2]'], idx['motor[3]']];
  const iRpm = [idx['eRPM[0]'], idx['eRPM[1]'], idx['eRPM[2]'], idx['eRPM[3]']];
  const iVbat = idx['vbatLatest'], iAmp = idx['amperageLatest'];
  const iRc = [idx['rcCommand[0]'], idx['rcCommand[1]'], idx['rcCommand[2]'], idx['rcCommand[3]']];
  const iSp = [idx['setpoint[0]'], idx['setpoint[1]'], idx['setpoint[2]'], idx['setpoint[3]']];
  const iP = [idx['axisP[0]'], idx['axisP[1]'], idx['axisP[2]']];
  const iI = [idx['axisI[0]'], idx['axisI[1]'], idx['axisI[2]']];
  const iD = [idx['axisD[0]'], idx['axisD[1]']];
  const iF = [idx['axisF[0]'], idx['axisF[1]'], idx['axisF[2]']];

  const every = opts.decimate || 8; // sample every Nth main frame
  const onFrame = opts.onFrame || null;
  const tailN = opts.tailFrames || 0;
  const tail = tailN ? new Array(tailN) : null;
  let tailPos = 0, tailFill = 0;
  let mainCount = 0;
  let lastTime = null;
  const gaps = [];

  let guard = 0;
  while (st.p < endLimit && !st.eof) {
    if (++guard > 50000000) break;
    const fp = st.p;
    const t = st.byte();
    if (t === 0x49 || t === 0x50) { // I / P
      const isI = t === 0x49;
      if (!isI && !valid) { res.frames.bad++; /* resync */ st.p = fp + 1; continue; }
      cur.fill(0);
      readFrame(isI ? defI : defP, cur, isI);
      const nb = st.peek();
      if (!isFrameType(nb) && st.p < endLimit) {
        res.frames.bad++;
        // resync: scan for next plausible frame start
        let q = fp + 1;
        while (q < endLimit && !(buf[q] === 0x49)) q++;
        st.p = q; valid = false; res.frames.resync++;
        continue;
      }
      // sanity on time
      const tm = cur[iTime];
      if (isI) {
        if (S.tStart === null) S.tStart = tm;
        valid = true;
      } else {
        const dt = tm - prev1[iTime];
        if (dt < 0 || dt > 200000) { res.frames.bad++; valid = false; continue; }
      }
      // commit + rotate history
      const snap = Int32Array.from(cur);
      if (isI) { prev1 = snap; prev2 = snap; } else { prev2 = prev1; prev1 = snap; }
      S.tEnd = tm;
      if (lastTime !== null) { const d = tm - lastTime; if (d > 2000) gaps.push([lastTime, tm, d]); }
      lastTime = tm;
      res.frames[isI ? 'I' : 'P']++;
      mainCount++;
      S.total++;
      // stats
      for (let a = 0; a < 3; a++) { const g = Math.abs(cur[iGyroU[a]]); if (g > S.maxGyro[a]) S.maxGyro[a] = g; }
      const ax = cur[iAcc[0]], ay = cur[iAcc[1]], az = cur[iAcc[2]];
      const am = Math.sqrt(ax * ax + ay * ay + az * az);
      if (am > S.maxAcc) S.maxAcc = am;
      if (cur[iVbat] < S.minVbat) S.minVbat = cur[iVbat];
      if (cur[iAmp] > S.maxAmp) S.maxAmp = cur[iAmp];
      if (onFrame) onFrame(cur, tm, idx, isI);
      if (tailN) { tail[tailPos] = Int32Array.from(cur); tailPos = (tailPos + 1) % tailN; tailFill = Math.min(tailFill + 1, tailN); }
      if (mainCount % every === 0) {
        res.samples.push([
          tm,
          cur[iGyro[0]], cur[iGyro[1]], cur[iGyro[2]],
          cur[iGyroU[0]], cur[iGyroU[1]], cur[iGyroU[2]],
          ax, ay, az,
          cur[iMot[0]], cur[iMot[1]], cur[iMot[2]], cur[iMot[3]],
          cur[iRpm[0]], cur[iRpm[1]], cur[iRpm[2]], cur[iRpm[3]],
          cur[iVbat], cur[iAmp],
          cur[iRc[0]], cur[iRc[1]], cur[iRc[2]], cur[iRc[3]],
          cur[iSp[0]], cur[iSp[1]], cur[iSp[2]], cur[iSp[3]],
          cur[iP[0]], cur[iP[1]], cur[iP[2]],
          cur[iI[0]], cur[iI[1]], cur[iI[2]],
          cur[iD[0]], cur[iD[1]],
          cur[iF[0]], cur[iF[1]], cur[iF[2]],
        ]);
      }
    } else if (t === 0x53) { // S slow
      const sv = new Int32Array(defS.count);
      for (let i = 0; i < defS.count; i++) {
        const e = defS.enc[i];
        if (e === ENC.TAG2_3S32) {
          st.tag2_3s32(vals);
          for (let k = 0; k < 3 && i + k < defS.count; k++) sv[i + k] = vals[k];
          i += 2; continue;
        }
        sv[i] = e === ENC.SVB ? st.svb() : st.uvb();
      }
      res.frames.S++;
      const rec = { t: S.tEnd, v: Array.from(sv) };
      const prev = res.slow.length ? res.slow[res.slow.length - 1].v : null;
      if (!prev || prev.some((x, i) => x !== rec.v[i])) res.slow.push(rec);
    } else if (t === 0x47) { // G
      if (defG) {
        const gv = new Int32Array(defG.count);
        for (let i = 0; i < defG.count; i++) {
          const e = defG.enc[i];
          let v = e === ENC.UVB ? st.uvb() : st.svb();
          const pr = defG.pred[i];
          if (pr === PRED.LAST_MAIN_TIME) v += (S.tEnd || 0);
          else if (pr === PRED.HOME_COORD) v += (res.gpsHome ? res.gpsHome[i - 2] : 0);
          gv[i] = v;
        }
        res.frames.G++;
        if (res.gps.length === 0 || res.gps.length < 200000) res.gps.push(Array.from(gv));
      }
    } else if (t === 0x48) { // H  gps home
      if (defHm) {
        const hv = [];
        for (let i = 0; i < defHm.count; i++) hv.push(defHm.enc[i] === ENC.UVB ? st.uvb() : st.svb());
        res.gpsHome = hv; res.frames.H++;
      }
    } else if (t === 0x45) { // E event
      const etype = st.byte();
      res.frames.E++;
      const ev = { t: S.tEnd, type: etype };
      if (etype === 0) { ev.name = 'SYNC_BEEP'; ev.time = st.uvb(); }
      else if (etype === 13) { ev.name = 'INFLIGHT_ADJUSTMENT'; ev.raw = st.byte(); if (ev.raw & 128) { ev.f = st.byte(); } else { ev.v = st.svb(); } }
      else if (etype === 14) { ev.name = 'LOGGING_RESUME'; ev.iter = st.uvb(); ev.time = st.uvb(); }
      else if (etype === 15) { ev.name = 'DISARM'; const r = st.uvb(); ev.reason = DISARM[r] || ('#' + r); }
      else if (etype === 30) {
        ev.name = 'FLIGHTMODE';
        ev.newFlags = st.uvb(); ev.lastFlags = st.uvb();
        ev.on = bits(ev.newFlags & ~ev.lastFlags, FLIGHT_MODES);
        ev.off = bits(ev.lastFlags & ~ev.newFlags, FLIGHT_MODES);
      }
      else if (etype === 255) {
        ev.name = 'LOG_END'; ev.msg = st.str();
        res.events.push(ev);
        res.end = 'LOG_END';
        break;
      } else { ev.name = 'UNKNOWN_' + etype; res.frames.bad++; }
      res.events.push(ev);
    } else {
      // garbage - resync to next I frame
      res.frames.bad++;
      let q = fp + 1;
      while (q < endLimit && buf[q] !== 0x49) q++;
      if (q >= endLimit) break;
      st.p = q; valid = false; res.frames.resync++;
    }
  }
  if (!res.end) res.end = st.p >= endLimit ? 'TRUNCATED' : 'STOP';
  S.gaps = gaps;
  res.stats = S;
  res.index = idx;
  if (tailN) {
    const out = [];
    for (let k = 0; k < tailFill; k++) out.push(tail[(tailPos - tailFill + k + tailN * 2) % tailN]);
    res.tail = out;
  }
  return res;
}

module.exports = { decodeLog, parseHeader, DISARM, FLIGHT_MODES, STATE_FLAGS, FAILSAFE_PHASE, bits };
