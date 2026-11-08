// Letter values, bag and reward rules, ported from spacetimedb/src/letters.ts
// and game.ts (playWord). Letters are indexed 0..25 (A..Z) throughout.

export const A_CODE = 65;
export const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const VALUE: readonly number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

// Standard Scrabble distribution without blanks: 98 tiles.
export const BAG_COUNTS: readonly number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;
export const STARTING_BALANCE = 100;
export const STARTING_RACK = 5;
export const RESERVE = 1;

export const VOWELS = new Set([0, 4, 8, 14, 20]);

export function idx(c: string): number {
  return c.charCodeAt(0) - A_CODE;
}

export function letterValue(c: string): number {
  const i = idx(c);
  return i >= 0 && i < 26 ? VALUE[i]! : 0;
}

// totalReward = base * num / denom with integer division, as the module does.
export function multiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function baseScore(word: string): number {
  let s = 0;
  for (let i = 0; i < word.length; i++) s += VALUE[word.charCodeAt(i) - A_CODE]!;
  return s;
}

export function rewardFor(base: number, len: number): number {
  const [n, d] = multiplier(len);
  return Math.floor((base * n) / d);
}

export function wordReward(word: string): number {
  return rewardFor(baseScore(word), word.length);
}

export type Counts = Uint8Array; // length 26

export function emptyCounts(): Counts {
  return new Uint8Array(26);
}

export function countsOf(s: string | Iterable<string>): Counts {
  const c = new Uint8Array(26);
  for (const ch of s) c[idx(ch)]!++;
  return c;
}

export function countsFromMap(m: Map<string, number>): Counts {
  const c = new Uint8Array(26);
  for (const [k, v] of m) {
    const i = idx(k);
    if (i >= 0 && i < 26) c[i] = Math.min(255, c[i]! + v);
  }
  return c;
}

export function total(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]!;
  return t;
}

export function countsToString(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += ALPHA[i]!.repeat(c[i]!);
  return s;
}

export function canSpell(c: Counts, word: string): boolean {
  const need = new Uint8Array(26);
  for (let i = 0; i < word.length; i++) {
    const k = word.charCodeAt(i) - A_CODE;
    if (++need[k]! > c[k]!) return false;
  }
  return true;
}

export function subtractWord(c: Counts, word: string): Counts {
  const out = new Uint8Array(c);
  for (let i = 0; i < word.length; i++) out[word.charCodeAt(i) - A_CODE]!--;
  return out;
}
