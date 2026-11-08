// Small seeded PRNG (mulberry32) so simulator runs are reproducible.
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Inclusive on both ends, like ctx.random.integerInRange.
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  normal(): number {
    const u = Math.max(1e-12, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  shuffle<T>(xs: T[]): void {
    for (let i = xs.length - 1; i >= 1; i--) {
      const j = this.int(0, i);
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
  }
}
