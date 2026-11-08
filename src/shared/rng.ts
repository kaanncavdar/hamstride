/** sfc32: a small deterministic PRNG that uses only 32-bit integer maths, so it gives the same
 *  numbers in every browser and in the Worker. Seeded from a hex string (a SHA-256 hash). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seedHex: string) {
    const h = (seedHex + '0'.repeat(32)).slice(0, 32);
    this.a = parseInt(h.slice(0, 8), 16) >>> 0;
    this.b = parseInt(h.slice(8, 16), 16) >>> 0;
    this.c = parseInt(h.slice(16, 24), 16) >>> 0;
    this.d = parseInt(h.slice(24, 32), 16) >>> 0;
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Uniform number in [0, 1). */
  next(): number {
    let { a, b, c, d } = this;
    const t0 = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const t = (t0 + d) | 0;
    c = (c + t) | 0;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return (t >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
