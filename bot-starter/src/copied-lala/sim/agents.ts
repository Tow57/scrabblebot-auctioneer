// Reference opponents for the arena: the module's simulated bots (exact
// port of decideBid / simulateWordPlay), the bot-starter strategy, and a
// "market" bot calibrated to the prices real entrants pay.

import type { Dict } from "../engine/dict.js";
import { VALUE, VOWELS, type Counts } from "../engine/letters.js";
import { Rng } from "../engine/rng.js";
import { bestPartition, playable, removeWord } from "../engine/words.js";
import type { Action, Agent, View } from "./types.js";

// The module's findBestPlayable: longest word, ties alphabetical.
export function longestPlayable(dict: Dict, rack: Counts, minLen: number): string | undefined {
  let tiles = 0;
  for (let k = 0; k < 26; k++) tiles += rack[k]!;
  for (let L = Math.min(tiles, dict.maxLen); L >= minLen; L--) {
    const [s, e] = dict.range(L, L);
    for (let i = s; i < e; i++) if (dict.fits(i, rack)) return dict.words[i];
  }
  return undefined;
}

export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";

export class SimBot implements Agent {
  readonly name: string;
  private rng: Rng;
  constructor(private dict: Dict, private strategy: SimStrategy, seed: number, name?: string) {
    this.name = name ?? `${strategy}-sim`;
    this.rng = new Rng(seed);
  }
  act(v: View): Action {
    const words: string[] = [];
    let balance = v.balance;
    if (v.wonLast) {
      const w = longestPlayable(this.dict, v.rack, 3);
      if (w) {
        words.push(w);
        balance += rewardSimple(w);
      }
    }
    const value = VALUE[v.letter]!;
    const vowel = VOWELS.has(v.letter);
    const base = this.strategy === "Cheapskate" ? value - 1
      : this.strategy === "ValueBidder" ? value : value + (vowel ? 4 : 2);
    const jitter = this.rng.int(-2, 2);
    const bid = Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
    return { words, bid };
  }
}

function rewardSimple(w: string): number {
  let b = 0;
  for (let i = 0; i < w.length; i++) b += VALUE[w.charCodeAt(i) - 65]!;
  const L = w.length;
  const [n, d] = L <= 3 ? [1, 1] : L === 4 ? [3, 2] : L === 5 ? [2, 1] : L === 6 ? [5, 2] : [3, 1];
  return Math.floor((b * n) / d);
}

// bot-starter/src/strategy.ts as shipped: face value (+2 if new letter),
// and the longest playable word whenever the rack changes.
export class StarterBot implements Agent {
  readonly name = "starter";
  constructor(private dict: Dict) {}
  act(v: View): Action {
    const rack = new Uint8Array(v.rack);
    const words: string[] = [];
    let balance = v.balance;
    for (;;) {
      const w = longestPlayable(this.dict, rack, 2);
      if (!w) break;
      words.push(w);
      balance += rewardSimple(w);
      for (let i = 0; i < w.length; i++) rack[w.charCodeAt(i) - 65]!--;
    }
    const value = VALUE[v.letter]!;
    const want = rack[v.letter] === 0 ? value + 2 : Math.max(1, value);
    return { words, bid: Math.min(want, Math.max(0, balance)) };
  }
}

// Median price paid per letter over the last 600 live matches (all six
// seats real bots), used as the market prior. See ANALYSIS.md.
export const LIVE_PAID: readonly number[] = [
  11, 16, 17, 14, 11, 19, 12, 21, 10, 29, 23, 11, 17, 10, 10, 16, 28, 11, 12, 10, 10, 18, 18, 31, 21, 38,
];

export interface MarketParams {
  scale: number;      // bid = LIVE_PAID * scale * noise * fit
  sigma: number;      // lognormal noise
  holdLen: number;    // play words of at least this length mid-game
  dumpAt: number;     // cash everything out when this many auctions remain
  dupPenalty: number; // multiplier for a third copy of a letter
  lateBoost: number;  // extra bid scale over the last 10 auctions
  pace: number;       // budget pacing exponent: bids scale with (balance / need)^pace
  perAuction: number; // coins a typical entrant expects to spend per remaining auction
}

export const DEFAULT_MARKET: MarketParams = {
  scale: 1.1, sigma: 0.3, holdLen: 7, dumpAt: 1, dupPenalty: 0.5, lateBoost: 1.3,
  pace: 0.6, perAuction: 2.2,
};

// A plausible stand-in for a typical live entrant: bids around the going
// price with noise, adjusted for rack fit; holds for 7-letter words and
// dumps the rest at the end.
export class MarketBot implements Agent {
  readonly name: string;
  private rng: Rng;
  constructor(private dict: Dict, seed: number, private p: MarketParams = DEFAULT_MARKET, name = "market") {
    this.rng = new Rng(seed);
    this.name = name;
  }
  act(v: View): Action {
    let rack: Counts = new Uint8Array(v.rack);
    const words: string[] = [];
    let balance = v.balance;
    if (v.auctionsLeft <= this.p.dumpAt) {
      const part = bestPartition(this.dict, rack, 2, 15);
      for (const w of part.words) {
        words.push(w);
        balance += rewardSimple(w);
        rack = removeWord(rack, w);
      }
      return { words, bid: 0 };
    }
    for (;;) {
      const best = playable(this.dict, rack, this.p.holdLen, 1)[0];
      if (best === undefined) break;
      const w = this.dict.words[best]!;
      words.push(w);
      balance += this.dict.reward[best]!;
      rack = removeWord(rack, w);
    }
    let fit = 1;
    const have = rack[v.letter]!;
    if (have >= 2) fit *= this.p.dupPenalty;
    let vowels = 0;
    let tiles = 0;
    for (let k = 0; k < 26; k++) {
      tiles += rack[k]!;
      if (VOWELS.has(k)) vowels += rack[k]!;
    }
    const isV = VOWELS.has(v.letter);
    if (tiles >= 3) {
      const frac = vowels / tiles;
      if (isV && frac > 0.5) fit *= 0.7;
      if (!isV && frac < 0.25) fit *= 0.8;
    }
    if (v.letter === 16 && rack[20] === 0) fit *= 0.6; // Q without U
    const late = v.auctionsLeft <= 10 ? this.p.lateBoost : 1;
    const noise = Math.exp(this.p.sigma * this.rng.normal());
    // Live entrants pace their budget: prices hold up to the very end.
    const need = Math.max(1, (v.auctionsLeft - 1) * this.p.perAuction);
    const pace = Math.min(1.6, Math.max(0.4, Math.pow(balance / need, this.p.pace)));
    let bid = Math.round(LIVE_PAID[v.letter]! * this.p.scale * noise * fit * late * pace);
    if (v.auctionsLeft === 1) bid = 0;
    return { words, bid: Math.max(0, Math.min(bid, balance)) };
  }
}
