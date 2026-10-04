// Побайтовое чтение и кодировки полей. Порт класса Stream из bb-tools/bbdec.js.
// Отличие одно: TAG2_3SVAR сделан как в официальном blackbox-tools (5-5-4 и 8-7-7 бит);
// в bbdec.js была заглушка, но на логах 4.5.2/2026.6.1 эта кодировка не встречается.

export function signExtend(v: number, bits: number): number {
  const m = 1 << (bits - 1);
  return ((v & ((1 << bits) - 1)) ^ m) - m;
}

export class Stream {
  b: Uint8Array;
  p: number;
  end: number;
  eof = false;

  constructor(buf: Uint8Array, pos: number, end: number) {
    this.b = buf;
    this.p = pos;
    this.end = end;
  }

  byte(): number {
    if (this.p >= this.end) {
      this.eof = true;
      return 0;
    }
    return this.b[this.p++];
  }

  peek(): number {
    return this.p < this.end ? this.b[this.p] : -1;
  }

  uvb(): number {
    let r = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.byte();
      r += (c & 0x7f) * Math.pow(2, shift);
      if (!(c & 0x80)) break;
      shift += 7;
    }
    return r >>> 0;
  }

  svb(): number {
    const u = this.uvb();
    return (u >>> 1) ^ -(u & 1);
  }

  tag2_3s32(out: Int32Array): void {
    const lead = this.byte();
    switch (lead >> 6) {
      case 0:
        out[0] = signExtend((lead >> 4) & 3, 2);
        out[1] = signExtend((lead >> 2) & 3, 2);
        out[2] = signExtend(lead & 3, 2);
        break;
      case 1: {
        out[0] = signExtend(lead & 0x0f, 4);
        const b = this.byte();
        out[1] = signExtend(b >> 4, 4);
        out[2] = signExtend(b & 0x0f, 4);
        break;
      }
      case 2:
        out[0] = signExtend(lead & 0x3f, 6);
        out[1] = signExtend(this.byte() & 0x3f, 6);
        out[2] = signExtend(this.byte() & 0x3f, 6);
        break;
      default: {
        let sel = lead;
        for (let i = 0; i < 3; i++) {
          switch (sel & 3) {
            case 0:
              out[i] = signExtend(this.byte(), 8);
              break;
            case 1: {
              const a = this.byte(), b = this.byte();
              out[i] = signExtend(a | (b << 8), 16);
              break;
            }
            case 2: {
              const a = this.byte(), b = this.byte(), c = this.byte();
              out[i] = signExtend(a | (b << 8) | (c << 16), 24);
              break;
            }
            default: {
              const a = this.byte(), b = this.byte(), c = this.byte(), d = this.byte();
              out[i] = a | (b << 8) | (c << 16) | (d << 24);
              break;
            }
          }
          sel >>= 2;
        }
      }
    }
  }

  tag2_3svar(out: Int32Array): void {
    const lead = this.byte();
    switch (lead >> 6) {
      case 0:
        out[0] = signExtend((lead >> 4) & 3, 2);
        out[1] = signExtend((lead >> 2) & 3, 2);
        out[2] = signExtend(lead & 3, 2);
        break;
      case 1: {
        // 5-5-4 бита
        out[0] = signExtend((lead & 0x3e) >> 1, 5);
        const b1 = this.byte();
        out[1] = signExtend(((lead & 0x01) << 4) | ((b1 & 0xf0) >> 4), 5);
        out[2] = signExtend(b1 & 0x0f, 4);
        break;
      }
      case 2: {
        // 8-7-7 бит
        const b1 = this.byte();
        out[0] = signExtend(((lead & 0x3f) << 2) | ((b1 & 0xc0) >> 6), 8);
        const b2 = this.byte();
        out[1] = signExtend(((b1 & 0x3f) << 1) | ((b2 & 0x80) >> 7), 7);
        out[2] = signExtend(b2 & 0x7f, 7);
        break;
      }
      default:
        this.tag2_3s32Wide(lead, out);
    }
  }

  private tag2_3s32Wide(lead: number, out: Int32Array): void {
    let sel = lead;
    for (let i = 0; i < 3; i++) {
      switch (sel & 3) {
        case 0:
          out[i] = signExtend(this.byte(), 8);
          break;
        case 1: {
          const a = this.byte(), b = this.byte();
          out[i] = signExtend(a | (b << 8), 16);
          break;
        }
        case 2: {
          const a = this.byte(), b = this.byte(), c = this.byte();
          out[i] = signExtend(a | (b << 8) | (c << 16), 24);
          break;
        }
        default: {
          const a = this.byte(), b = this.byte(), c = this.byte(), d = this.byte();
          out[i] = a | (b << 8) | (c << 16) | (d << 24);
        }
      }
      sel >>= 2;
    }
  }

  tag8_4s16(out: Int32Array): void {
    let sel = this.byte();
    let nib = 0;
    let buf = 0;
    for (let i = 0; i < 4; i++) {
      switch (sel & 3) {
        case 0:
          out[i] = 0;
          break;
        case 1:
          if (nib === 0) {
            buf = this.byte();
            out[i] = signExtend(buf >> 4, 4);
            nib = 1;
          } else {
            out[i] = signExtend(buf & 0x0f, 4);
            nib = 0;
          }
          break;
        case 2:
          if (nib === 0) out[i] = signExtend(this.byte(), 8);
          else {
            let c = (buf & 0x0f) << 4;
            buf = this.byte();
            c |= buf >> 4;
            out[i] = signExtend(c, 8);
          }
          break;
        default:
          if (nib === 0) {
            const a = this.byte(), b = this.byte();
            out[i] = signExtend((a << 8) | b, 16);
          } else {
            const a = this.byte(), b = this.byte();
            out[i] = signExtend(((buf & 0x0f) << 12) | (a << 4) | (b >> 4), 16);
            buf = b;
          }
          break;
      }
      sel >>= 2;
    }
  }

  tag8_8svb(out: Int32Array, n: number): void {
    if (n === 1) {
      out[0] = this.svb();
      return;
    }
    let h = this.byte();
    for (let i = 0; i < 8; i++, h >>= 1) out[i] = h & 1 ? this.svb() : 0;
  }

  rawFloat(): number {
    const a = this.byte(), b = this.byte(), c = this.byte(), d = this.byte();
    const dv = new DataView(new Uint8Array([a, b, c, d]).buffer);
    return dv.getFloat32(0, true);
  }

  str(): string {
    let s = '';
    for (;;) {
      const c = this.byte();
      if (c === 0 || this.eof) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}
