// Измеренный step response оси: импульсная характеристика setpoint → gyro методом
// наименьших квадратов (уравнения Винера–Хопфа) по всем пригодным кадрам полёта,
// её накопленная сумма — переходная характеристика.
//
// Почему не спектральное деление по окнам (PID-Analyzer): у настоящих движений стиков
// мощность сосредоточена ниже ~5 Гц, и регуляризация, нужная против шума, «душит»
// середину спектра — ответ на логах получался заниженным (уровень 0.7–0.8 при трекинге
// 1.01). МНК по всему полёту несмещён при шуме в гироскопе (ветер, пропвош, вибрации
// не коррелируют со стиками) и на синтетике восстанавливает перерегулирование ±2 п.п.
//
// Перед оценкой оба ряда пропускаются через «отбеливающий» фильтр 1 − a·z⁻¹: спектр
// стиков сильно падает с частотой, и без этого регуляризация «размазывает» задержку
// к нулю (кривая стартует не с 0). Импульсная характеристика от фильтра не меняется.
//
// Реализация: ряды прореживаются до ~500 Гц (среднее по блоку) и остаются непрерывными;
// непригодные кадры (земля, удары, насыщение моторов, режимы ANGLE…) выкидываются из
// уравнений, а не из рядов: точные нормальные уравнения A·h = b с выбором строк,
// A[a][c] = Σ_j m_j·s(j−a)·s(j−c). Такая A положительно определена по построению и не
// смещена на краях кусков. Считается быстро: соседние диагонали A отличаются только
// в точках, где меняется маска m (O(N·R + R²·T), T — число переходов маски).
// Решение — Холецкий с малой гребневой регуляризацией. Разброс — по K частям полёта.

export interface StepOptions {
  respS: number;
  /** частота, до которой прореживаем, Гц */
  decimHz: number;
  /** гребневая регуляризация (доля от r(0)) */
  ridge: number;
  /** «секунда с движением стиков»: размах setpoint в 1-с блоке не меньше, °/с */
  minInputDps: number;
  /** на сколько частей резать полёт для оценки разброса */
  parts: number;
  /** коэффициент «отбеливающего» фильтра 1 − a·z⁻¹ (0 — нет, 1 — первая разность) */
  whiten: number;
}

export interface StepResult {
  /** время, с */
  t: Float32Array;
  /** переходная характеристика (1 = гироскоп догнал setpoint) */
  mean: Float32Array;
  /** разброс оценки по частям полёта (СКО) — полоса на графике */
  std: Float32Array;
  /** секунд с движением стиков (основа оценки) */
  activeS: number;
  /** пригодных секунд всего */
  usedS: number;
}

export interface StepMetrics {
  /** перерегулирование над 1, % (0, если нет) */
  overshootPct: number;
  peak: number;
  peakMs: number;
  /** время до 50 % — «задержка отклика», мс */
  delayMs: number;
  /** время нарастания 10 → 90 %, мс */
  riseMs: number;
  /** средний уровень на 200 мс…конец (≈1 — догоняет; < 1 — «проседает») */
  settle: number;
}

/** Холецкий для симметричной A (заполнен нижний треугольник), A + ridge·mean(diag)·I */
function cholSolve(A: Float64Array, b: Float64Array, R: number, ridge: number): Float64Array | null {
  let tr = 0;
  for (let i = 0; i < R; i++) tr += A[i * R + i];
  const add = (ridge * tr) / R;
  const L = new Float64Array(R * R);
  for (let i = 0; i < R; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * R + j] + (i === j ? add : 0);
      for (let k = 0; k < j; k++) s -= L[i * R + k] * L[j * R + k];
      if (i === j) {
        if (!(s > 1e-12 * (tr / R))) return null;
        L[i * R + i] = Math.sqrt(s);
      } else L[i * R + j] = s / L[j * R + j];
    }
  }
  const y = new Float64Array(R);
  for (let i = 0; i < R; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * R + k] * y[k];
    y[i] = s / L[i * R + i];
  }
  const x = new Float64Array(R);
  for (let i = R - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < R; k++) s -= L[k * R + i] * x[k];
    x[i] = s / L[i * R + i];
  }
  return x;
}

/**
 * Нормальные уравнения МНК для строк j с m[j] = 1 (j ≥ R−1): A[a][c] = Σ m_j s(j−a) s(j−c),
 * b[a] = Σ m_j g(j) s(j−a). Возвращает переходную характеристику (накопленную сумму h).
 */
function solveRows(s: Float64Array, g: Float64Array, m: Uint8Array, R: number, ridge: number): Float64Array | null {
  const n = s.length;
  const A = new Float64Array(R * R);
  const b = new Float64Array(R);
  let rows = 0;
  // первый столбец и правая часть: O(N·R)
  for (let j = R - 1; j < n; j++) {
    if (!m[j]) continue;
    rows++;
    const sj = s[j], gj = g[j];
    for (let a = 0; a < R; a++) {
      const sa = s[j - a];
      A[a * R] += sa * sj;
      b[a] += gj * sa;
    }
  }
  if (rows < 10 * R) return null;
  // переходы маски: A[a+1][c+1] = A[a][c] + Σ_t (m(t+1) − m(t))·s(t−a)·s(t−c)
  const tr: number[] = [], sg: number[] = [];
  for (let t = R - 2; t < n - 1; t++) {
    const m0 = t >= R - 1 ? m[t] : 0, m1 = m[t + 1];
    if (m0 !== m1) { tr.push(t); sg.push(m1 - m0); }
  }
  for (let a = 0; a < R - 1; a++) {
    for (let c = 0; c <= a; c++) {
      let v = A[a * R + c];
      for (let k = 0; k < tr.length; k++) {
        const t = tr[k];
        if (t - a < 0) continue;
        v += sg[k] * s[t - a] * s[t - c];
      }
      A[(a + 1) * R + (c + 1)] = v;
    }
  }
  const h = cholSolve(A, b, R, ridge);
  if (!h) return null;
  for (let k = 1; k < R; k++) h[k] += h[k - 1];
  return h;
}

/**
 * sp, gy — setpoint и гироскоп (°/с) на частоте лога fs; use — пригодные кадры (1/0).
 * null — нечего оценивать.
 */
export function stepResponse(sp: ArrayLike<number>, gy: ArrayLike<number>, use: Uint8Array, fs: number, o: StepOptions): StepResult | null {
  const n = sp.length;
  const f = Math.max(1, Math.round(fs / o.decimHz));
  const fsd = fs / f;
  const nd = Math.floor(n / f);
  const sd = new Float64Array(nd), gd = new Float64Array(nd);
  const ud = new Uint8Array(nd);
  let usedD = 0;
  for (let j = 0; j < nd; j++) {
    let ok = 1, s = 0, g = 0;
    for (let k = 0; k < f; k++) {
      const i = j * f + k;
      if (!use[i]) ok = 0;
      s += sp[i];
      g += gy[i];
    }
    sd[j] = s / f;
    gd[j] = g / f;
    ud[j] = ok;
    usedD += ok;
  }
  if (usedD < fsd) return null;
  // «отбеливание» по непрерывным рядам
  const sw = new Float64Array(nd), gw = new Float64Array(nd);
  for (let j = 1; j < nd; j++) {
    sw[j] = sd[j] - o.whiten * sd[j - 1];
    gw[j] = gd[j] - o.whiten * gd[j - 1];
  }
  // секунды с движением стиков
  const blk = Math.max(1, Math.round(fsd));
  let active = 0;
  for (let j0 = 0; j0 + blk <= nd; j0 += blk) {
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let j = j0; j < j0 + blk; j++) {
      if (!ud[j]) { ok = false; break; }
      if (sd[j] < mn) mn = sd[j];
      if (sd[j] > mx) mx = sd[j];
    }
    if (ok && mx - mn >= o.minInputDps) active++;
  }
  const R = Math.max(2, Math.round(o.respS * fsd));
  // строки уравнений: пригодный кадр и пригодный предыдущий (отбеливание)
  const m = new Uint8Array(nd);
  for (let j = 1; j < nd; j++) m[j] = ud[j] && ud[j - 1] ? 1 : 0;
  const h = solveRows(sw, gw, m, R, o.ridge);
  if (!h) return null;
  // части полёта — по порядку пригодных строк, поровну
  const K = Math.max(2, o.parts);
  let total = 0;
  for (let j = 0; j < nd; j++) total += m[j];
  const hs: Float64Array[] = [];
  for (let p = 0; p < K; p++) {
    const mp = new Uint8Array(nd);
    let seen = 0;
    for (let j = 0; j < nd; j++) {
      if (!m[j]) continue;
      if (Math.min(K - 1, Math.floor((seen++ * K) / total)) === p) mp[j] = 1;
    }
    const x = solveRows(sw, gw, mp, R, o.ridge);
    if (x && x.every(Number.isFinite)) hs.push(x);
  }
  const t = new Float32Array(R), mean = new Float32Array(R), std = new Float32Array(R);
  for (let i = 0; i < R; i++) {
    t[i] = i / fsd;
    mean[i] = h[i];
    std[i] = NaN;
    if (hs.length > 1) {
      let mu = 0;
      for (const x of hs) mu += x[i];
      mu /= hs.length;
      let v = 0;
      for (const x of hs) v += (x[i] - mu) ** 2;
      std[i] = Math.sqrt(v / (hs.length - 1));
    }
  }
  return { t, mean, std, activeS: active * (blk / fsd), usedS: usedD / fsd };
}

export function stepMetrics(r: { t: ArrayLike<number>; mean: ArrayLike<number> }, settleFromS = 0.2): StepMetrics {
  const { t, mean } = r;
  const n = mean.length;
  let peak = -Infinity, iPk = 0;
  for (let i = 0; i < n; i++) if (mean[i] > peak) { peak = mean[i]; iPk = i; }
  // время первого пересечения уровня (линейная интерполяция)
  const cross = (lvl: number): number => {
    if (mean[0] >= lvl) return t[0];
    for (let i = 1; i < n; i++) if (mean[i] >= lvl && mean[i - 1] < lvl) return t[i - 1] + ((lvl - mean[i - 1]) / (mean[i] - mean[i - 1])) * (t[i] - t[i - 1]);
    return NaN;
  };
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) if (t[i] >= settleFromS) { s += mean[i]; c++; }
  return {
    overshootPct: Math.max(0, (peak - 1) * 100),
    peak,
    peakMs: t[iPk] * 1000,
    delayMs: cross(0.5) * 1000,
    riseMs: (cross(0.9) - cross(0.1)) * 1000,
    settle: c ? s / c : NaN,
  };
}
