// The ENABLE dictionary, packed for fast rack queries.
//
// Words are stored sorted by length, so every query scans just the length
// range it needs. Each word carries a 26-bit letter mask (cheap rejection)
// and its distinct letters with counts (exact checks and deficit counting).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { A_CODE, VALUE, rewardFor, type Counts } from "./letters.js";

export class Dict {
  readonly words: string[];
  readonly len: Uint8Array;
  readonly mask: Int32Array;
  readonly base: Uint16Array;
  readonly reward: Uint16Array;
  // Distinct letters of word i are dl[dOff[i] .. dOff[i+1]), counts in dc.
  readonly dOff: Uint32Array;
  readonly dl: Uint8Array;
  readonly dc: Uint8Array;
  // lenStart[L] = index of the first word with length >= L.
  readonly lenStart: Int32Array;
  readonly maxLen: number;
  private readonly set: Set<string>;

  constructor(raw: string[]) {
    const words = [...new Set(raw.map((w) => w.trim().toUpperCase()))]
      .filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w))
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    const n = words.length;
    this.words = words;
    this.set = new Set(words);
    this.len = new Uint8Array(n);
    this.mask = new Int32Array(n);
    this.base = new Uint16Array(n);
    this.reward = new Uint16Array(n);
    this.dOff = new Uint32Array(n + 1);
    const dl: number[] = [];
    const dc: number[] = [];
    const tmp = new Uint8Array(26);
    for (let i = 0; i < n; i++) {
      const w = words[i]!;
      this.len[i] = w.length;
      tmp.fill(0);
      let m = 0;
      let b = 0;
      for (let j = 0; j < w.length; j++) {
        const k = w.charCodeAt(j) - A_CODE;
        tmp[k]!++;
        m |= 1 << k;
        b += VALUE[k]!;
      }
      this.mask[i] = m;
      this.base[i] = b;
      this.reward[i] = rewardFor(b, w.length);
      this.dOff[i] = dl.length;
      for (let k = 0; k < 26; k++) {
        if (tmp[k]) {
          dl.push(k);
          dc.push(tmp[k]!);
        }
      }
    }
    this.dOff[n] = dl.length;
    this.dl = Uint8Array.from(dl);
    this.dc = Uint8Array.from(dc);
    this.maxLen = n ? this.len[n - 1]! : 0;
    this.lenStart = new Int32Array(this.maxLen + 2);
    let i = 0;
    for (let L = 0; L <= this.maxLen + 1; L++) {
      while (i < n && this.len[i]! < L) i++;
      this.lenStart[L] = i;
    }
  }

  isValid(word: string): boolean {
    return this.set.has(word.toUpperCase());
  }

  // Index range [start, end) of words with minLen <= length <= maxLen.
  range(minLen: number, maxLen: number): [number, number] {
    const lo = Math.max(0, Math.min(minLen, this.maxLen + 1));
    const hi = Math.max(0, Math.min(maxLen + 1, this.maxLen + 1));
    return [this.lenStart[lo]!, this.lenStart[hi]!];
  }

  fits(i: number, rack: Counts): boolean {
    for (let p = this.dOff[i]!, e = this.dOff[i + 1]!; p < e; p++) {
      if (this.dc[p]! > rack[this.dl[p]!]!) return false;
    }
    return true;
  }

  // Indices of every word spellable from `rack`.
  findWords(rack: Counts, minLen = 2, maxLen = 99): number[] {
    let tiles = 0;
    let rmask = 0;
    for (let k = 0; k < 26; k++) {
      tiles += rack[k]!;
      if (rack[k]) rmask |= 1 << k;
    }
    const [s, e] = this.range(minLen, Math.min(maxLen, tiles));
    const out: number[] = [];
    const notMask = ~rmask;
    for (let i = s; i < e; i++) {
      if (this.mask[i]! & notMask) continue;
      if (this.fits(i, rack)) out.push(i);
    }
    return out;
  }
}

let shared: Dict | undefined;

export function defaultWordlistPath(): string {
  if (process.env.WORDLIST) return process.env.WORDLIST;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/engine -> bot-starter -> repo root
  return path.resolve(here, "..", "..", "..", "spacetimedb", "wordlist.txt");
}

export function loadDict(file = defaultWordlistPath()): Dict {
  if (!shared) shared = new Dict(fs.readFileSync(file, "utf8").split("\n"));
  return shared;
}
