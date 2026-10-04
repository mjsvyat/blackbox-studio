// Радикс-2 БПФ с кэшем поворотных множителей и окна.

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function plan(n: number) {
  let p = twiddleCache.get(n);
  if (p) return p;
  if (n & (n - 1)) throw new Error('FFT: длина должна быть степенью двойки');
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  p = { cos, sin, rev };
  twiddleCache.set(n, p);
  return p;
}

/** БПФ на месте: re/im длины n (степень двойки) */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const { cos, sin, rev } = plan(n);
  for (let i = 1; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = i + k, b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
      }
    }
  }
}

const hannCache = new Map<number, { w: Float64Array; sumSq: number }>();
export function hann(n: number): { w: Float64Array; sumSq: number } {
  let h = hannCache.get(n);
  if (h) return h;
  const w = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    s += w[i] * w[i];
  }
  h = { w, sumSq: s };
  hannCache.set(n, h);
  return h;
}

export const nextPow2 = (x: number): number => 1 << Math.ceil(Math.log2(Math.max(2, x)));
