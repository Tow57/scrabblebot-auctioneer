// Lala: the tournament strategy. Shared by the live bot and the simulator.
//
// Each auction: (1) play any word that beats holding its tiles, (2) bid the
// letter's marginal value converted to coins at the current shadow price of
// money (mu, points per coin). mu rises when coins are scarce relative to
// what the rest of the match will cost and falls to ~0 as the match runs
// out, because leftover coins are worth nothing.

import type { Dict } from "../engine/dict.js";
import { VALUE, VOWELS, type Counts } from "../engine/letters.js";
import { bestPartition, playable, removeWord } from "../engine/words.js";
import type { Action, Agent, View } from "../sim/types.js";
import { Valuer, LIVE_USE, USEFUL, type ValueParams } from "./value.js";
import { phasePrice, coinValue } from "./tables.js";
import { LIVE_PAID } from "../sim/agents.js";
import { Rng } from "../engine/rng.js";

export interface LalaParams extends ValueParams {
  mu0: number;        // points per coin when the budget is on track
  muAlpha: number;    // how strongly budget pressure moves mu
  muMin: number;
  muMax: number;
  share: number;      // share of remaining auctions we expect to buy
  incomeW: number;    // weight of the rack's value as future coins
  premium: number;    // bid multiplier on marginal value
  liq: number;        // bonus per point for cashing a word in early
  playMargin: number; // points a play must beat holding by
  coinW: number;      // weight on the coins a play returns, valued at the leave table's own
                      // learned points-per-coin (0.56 early/mid x leaveScale). v2.5 valued
                      // held tiles by that model but coins at 0, so it hoarded while broke.
  affordK: number;    // >0: scale the chance of winning missing letters by what we can
                      // afford, min(1, coins / (affordK x average price)). Without it a
                      // broke rack is valued as if its missing letters were 90% likely,
                      // so Lala held complete words for 25+ rounds with 1 coin.
  starveMinLen: number; // shortest word the starvation rule may cash (7 keeps the 3x bonus)
  starveBal: number;  // below this many coins, with starveT+ auctions left, cash the best
  starveT: number;    // 4+ letter word even if holding might pay more (live: starved
                      // hoarders lose 15+ auctions in a row; 0 = off)
  playK: number;      // leftover value scale when deciding whether to play
  minPlayLen: number; // shortest word played before the last few auctions
  kappaT: number;     // auctions over which leftover value fades out
  kappaMin: number;
  phasePrices: number; // 1: price prior follows the live stage curve (tables.ts); 2: recent refit
  priceN0: number;    // prior weight (in observations) on the price table
  shadeSigma: number; // first-price: spread of the rival-max distribution
  earlyN: number;     // the first earlyN auctions multiply bids by earlyPremium (Lala's
  earlyPremium: number; // bottom-two finishes had 66 coins unspent at round 20)
  paceRate: number;   // >0: target tiles bought per auction (winners buy ~16 a match). When
  paceK: number;      // behind it by more than one tile, raise bids by paceK per missing
  paceMax: number;    // tile, up to paceMax x. v2's last places bought 7.5 tiles with 66
                      // coins still unspent at round 20.
  hiBoost: number;    // extra marginal value for 4+ point letters (top bots buy 2.2-2.8 of
                      // them per match, v2 bought 1.87; they return more points per coin)
  completeMul: number; // bid at least completeMul x the going price for a letter that
  completeMin: number; // completes a completeLen+ letter word worth completeMin+ more points
  completeLen: number; // than the best word now (top bots pay 1.2-1.4x for these; v2 paid 1.18x)
  vowelBal: number;   // extra value for a vowel on a vowel-poor rack (or a consonant on a vowel-rich one)
  capMul: number;     // never bid more than capMul x the going price, except in the last 3 auctions
  muMode: number;     // 0: mu0 * (need/have)^muAlpha; 1: re-solve mu each auction so the
                      // expected spend over the remaining auctions equals coins + income
  focusMul: number;   // Lambi-style focus: bid at least focusMul x the going price for a letter
  focusCut: number;   // the best target word still needs, and focusCut x for other letters while
  focusT: number;     // more than focusT auctions remain (0 = off)
  chaseN: number;     // over the last chaseN auctions, if projected 2nd within chaseGap points
  chaseGap: number;   // of the leader, multiply bids on useful letters by chaseUp (above the
  chaseUp: number;    // usual price cap): go for the win when it is in reach
  riskN: number;      // over the last riskN auctions, if projected 5th or 6th within reach,
  riskUp: number;     // multiply bids by riskUp (rating punishes low finishes most)
  riskGap: number;    // "within reach": projected gap to 4th place, in points
  midN: number;       // between midN and lateN auctions left, mu * midMu: be thrifty after the
  midMu: number;      // second big word so coins remain for the last lateN auctions
  lateN: number;      // the last lateN auctions use mu * lateMu (rivals keep a reserve for them)
  lateMu: number;
  bidNoise: number;   // lognormal noise on bids (0 for the real bot; used to diversify sim rivals)
  seed: number;
}

export const DEFAULT_LALA: LalaParams = {
  winP: 0.6, maxMissing: 3, rho: 1.0, kappa0: 2.5, kappa1: 0.5, dupDecay: 0.6, liveUse: 0, vowelUse: 0, leaveCapN: 0, leaveW: 0, leaveLive: 0, leaveScale: 1, minLen: 2, maxLen: 8,
  mu0: 0.25, muAlpha: 1.0, muMin: 0.05, muMax: 1.5, share: 0.2, incomeW: 0.7,
  premium: 1.0, liq: 0.1, playMargin: 0, coinW: 0, affordK: 0, starveBal: 0, starveMinLen: 4, starveT: 8, playK: 1, minPlayLen: 2, kappaT: 15, kappaMin: 0.3,
  phasePrices: 0, priceN0: 8, shadeSigma: 0.35, earlyN: 0, earlyPremium: 1, paceRate: 0, paceK: 0.1, paceMax: 1.4, hiBoost: 0, completeMul: 0, completeMin: 12, completeLen: 6, vowelBal: 0, capMul: 99, muMode: 0, focusMul: 0, focusCut: 1, focusT: 0, chaseN: 0, chaseGap: 15, chaseUp: 1.5, riskN: 0, riskUp: 1, riskGap: 25, midN: 0, midMu: 1, lateN: 12, lateMu: 1, bidNoise: 0, seed: 1,
};

export interface Decision extends Action {
  value: number;
  marginal: number;
  mu: number;
  ms: number;
}

export class Lala implements Agent {
  readonly name: string;
  readonly p: LalaParams;
  private valuer: Valuer;
  private rng: Rng;
  last?: Decision;

  constructor(private dict: Dict, params: Partial<LalaParams> = {}, name = "Lala") {
    this.p = { ...DEFAULT_LALA, ...params };
    this.valuer = new Valuer(dict);
    this.rng = new Rng(this.p.seed);
    this.name = name;
  }

  // Expected coins per letter: the live price table scaled by how this
  // match's prices compare with it so far.
  prices(v: View): Float64Array {
    const prior = (round: number, k: number): number =>
      (this.p.phasePrices ? phasePrice(round, k, this.p.phasePrices === 2) : null) ?? LIVE_PAID[k]!;
    let sum = 0;
    let n = 0;
    for (const o of v.tracker.prices) {
      if (o.winner === null || o.paid <= 0) continue;
      sum += o.paid / prior(o.round, o.letter);
      n++;
    }
    const scale = (sum + this.p.priceN0) / (n + this.p.priceN0);
    const out = new Float64Array(26);
    for (let k = 0; k < 26; k++) out[k] = Math.max(1, prior(v.round, k) * scale);
    return out;
  }

  private mu(v: View, balance: number, rackValue: number, prices: Float64Array, futureDraws: number): number {
    if (this.p.muMode === 1) return this.solveMu(v, balance, rackValue, prices, futureDraws);
    const unseen = v.tracker.unseen;
    let tot = 0;
    let avg = 0;
    for (let k = 0; k < 26; k++) {
      tot += unseen[k]!;
      avg += unseen[k]! * prices[k]!;
    }
    avg = tot > 0 ? avg / tot : 10;
    const need = (futureDraws + 1) * this.p.share * avg;
    const have = Math.max(1, balance + this.p.incomeW * Math.max(0, rackValue));
    let m = this.p.mu0 * Math.pow(need / have, this.p.muAlpha);
    const left = futureDraws + 2;
    if (left <= this.p.lateN) m *= this.p.lateMu;
    else if (left <= this.p.midN) m *= this.p.midMu;
    return Math.min(this.p.muMax, Math.max(this.p.muMin, m));
  }

  // Shadow price of coins as the market-clearing mu (Balseiro-Gur pacing,
  // re-solved rather than stepped because a match is only 68 auctions).
  // For each letter still to come, our bid is its generic tile value / mu;
  // the rivals' top bid is lognormal around 1.25x the going price, and we
  // pay it when it is below ours. Bisect mu so the expected spend over the
  // remaining auctions matches what we can spend: coins plus the rack's
  // expected cash-in. With no auctions left mu falls to zero by itself.
  private solveMu(v: View, balance: number, rackValue: number, prices: Float64Array, futureDraws: number): number {
    const p = this.p;
    const unseen = v.tracker.unseen;
    let tot = 0;
    for (let k = 0; k < 26; k++) tot += unseen[k]!;
    if (tot === 0 || futureDraws <= 0) return p.muMin;
    const budget = Math.max(1, balance + p.incomeW * Math.max(0, rackValue));
    const s = p.shadeSigma;
    const ks = this.kappaScale(futureDraws);
    const spend = (mu: number): number => {
      let e = 0;
      for (let k = 0; k < 26; k++) {
        if (!unseen[k]) continue;
        const use = p.liveUse ? LIVE_USE[k]! : p.vowelUse > 0 && VOWELS.has(k) ? p.vowelUse : Math.min(1.6, USEFUL[k]!);
        const value = (ks * p.kappa0 * use + p.kappa1 * VALUE[k]!) * p.premium;
        const bid = value / mu;
        const m = Math.log(Math.max(1, prices[k]! * 1.25));
        // E[M; M < bid] for lognormal M (partial expectation).
        const z = (Math.log(bid) - m - s * s) / s;
        const partial = Math.exp(m + (s * s) / 2) * 0.5 * (1 + erf(z / Math.SQRT2));
        e += (unseen[k]! / tot) * partial;
      }
      return e * (futureDraws + 1);
    };
    let lo = p.muMin;
    let hi = p.muMax;
    if (spend(lo) <= budget) return lo;
    if (spend(hi) >= budget) return hi;
    for (let i = 0; i < 30; i++) {
      const mid = Math.sqrt(lo * hi);
      if (spend(mid) > budget) lo = mid;
      else hi = mid;
    }
    let mu = Math.sqrt(lo * hi) * p.mu0 / 0.3;
    if (futureDraws + 2 <= p.lateN) mu *= p.lateMu;
    return Math.min(p.muMax, Math.max(p.muMin, mu));
  }

  private kappaScale(futureDraws: number): number {
    return Math.max(this.p.kappaMin, Math.min(1, futureDraws / this.p.kappaT));
  }

  act(v: View, firstWordOnly = false): Decision {
    const t0 = performance.now();
    const p = this.p;
    const T = v.auctionsLeft;
    let rack: Counts = new Uint8Array(v.rack);
    let balance = v.balance;
    const words: string[] = [];

    // The final auction: its tile can never be played. Cash out everything.
    if (T <= 1) {
      const part = bestPartition(this.dict, rack, 2, 60);
      return { words: part.words, bid: 0, value: part.reward, marginal: 0, mu: 0, ms: performance.now() - t0 };
    }

    // Second to last: a tile won now can still be played in the final
    // window, and coins are worth nothing after it. Bid everything on any
    // letter that improves the cash-out.
    if (T === 2) {
      const now = bestPartition(this.dict, rack, 2, 30);
      const plus = new Uint8Array(rack);
      plus[v.letter]!++;
      const withL = bestPartition(this.dict, plus, 2, 30);
      const gain = withL.reward - now.reward;
      const bid = gain > 0 ? balance : 0;
      // Words in both plans are safe to play now, leaving less to do in the
      // final one-second window.
      const rest = [...withL.words];
      const safe: string[] = [];
      for (const w of now.words) {
        const j = rest.indexOf(w);
        if (j >= 0) {
          safe.push(w);
          rest.splice(j, 1);
        }
      }
      return { words: safe, bid, value: now.reward, marginal: gain, mu: 0, ms: performance.now() - t0 };
    }

    const futureDraws = Math.max(0, T - 2);
    const prices = this.prices(v);
    const ks = this.kappaScale(futureDraws);
    // Average price of an unseen letter, for affordability.
    let avgPrice = 0;
    let unseenTot = 0;
    for (let k = 0; k < 26; k++) {
      avgPrice += v.tracker.unseen[k]! * prices[k]!;
      unseenTot += v.tracker.unseen[k]!;
    }
    avgPrice = unseenTot ? avgPrice / unseenTot : 11;
    const withCoins = (coins: number): ValueParams =>
      p.affordK > 0 ? { ...p, winP: p.winP * Math.max(0.05, Math.min(1, coins / (p.affordK * avgPrice))) } : p;
    const evalRack = (r: Counts, mu: number, kMul = 1, coins = balance) =>
      this.valuer.evaluate(r, v.letter, v.tracker.unseen, futureDraws, prices, mu, withCoins(coins), ks, kMul);

    // Word plays: take a word whenever cashing it beats holding its tiles.
    let mu = this.mu(v, balance, 0, prices, futureDraws);
    // Held tiles are valued with playK so the leftover estimate (tuned for
    // bidding) doesn't stop us cashing in words we already have.
    let hold = evalRack(rack, mu, p.playK);
    for (let iter = 0; iter < 4; iter++) {
      const cands = playable(this.dict, rack, futureDraws <= 3 ? 2 : p.minPlayLen, 8);
      if (!cands.length) break;
      const phi = futureDraws / 60;
      const perCoin = p.coinW * coinValue(T) * p.leaveScale;
      // A tie goes to playing: same points, but the coins arrive sooner.
      let bestGain = p.playMargin - 1e-6;
      let bestIdx = -1;
      let bestAfter = hold;
      for (const i of cands) {
        // Holding never loses value by having more tiles, so a play gains
        // at most its own reward: stop once that can't beat the best.
        if (this.dict.reward[i]! * (1 + p.liq * mu * phi + perCoin) <= bestGain) break;
        const w = this.dict.words[i]!;
        const after = evalRack(removeWord(rack, w), mu, p.playK, balance + this.dict.reward[i]!);
        // Coins from a play are worth more the scarcer coins are (mu) and
        // the more auctions are left to spend them in (phi).
        const gain = this.dict.reward[i]! * (1 + p.liq * mu * phi + perCoin) + after.base - hold.base;
        if (gain > bestGain) {
          bestGain = gain;
          bestIdx = i;
          bestAfter = after;
        }
      }
      // Starving: coins buy the tiles that win, and live matches showed
      // Lala holding a 26-27 point word for 30+ rounds with no coins.
      if (bestIdx < 0 && balance < p.starveBal && futureDraws >= p.starveT) {
        let bestTotal = -Infinity;
        for (const i of cands) {
          if (this.dict.len[i]! < p.starveMinLen) continue;
          const after = evalRack(removeWord(rack, this.dict.words[i]!), mu, p.playK);
          const total = this.dict.reward[i]! + after.base;
          if (total > bestTotal) {
            bestTotal = total;
            bestIdx = i;
            bestAfter = after;
          }
        }
      }
      if (bestIdx < 0) break;
      const w = this.dict.words[bestIdx]!;
      words.push(w);
      // The integrating client submits only this first word and then waits
      // for authoritative rack/balance before deciding again. Later words
      // and their hypothetical bid are discarded by that serial protocol.
      if (firstWordOnly) return { words, bid: 0, value: hold.base, marginal: 0, mu, ms: performance.now() - t0 };
      rack = removeWord(rack, w);
      balance += this.dict.reward[bestIdx]!;
      hold = bestAfter;
    }

    mu = this.mu(v, balance, hold.base, prices, futureDraws);
    const val = evalRack(rack, mu);
    let marginal = Math.max(0, val.withLetter - val.base);
    if (p.vowelBal > 0) marginal *= this.balanceFactor(rack, v.letter);
    if (p.hiBoost > 0 && VALUE[v.letter]! >= 4) marginal *= 1 + p.hiBoost;
    let bid = (marginal / mu) * p.premium;
    if (v.round <= p.earlyN) bid *= p.earlyPremium;
    if (p.paceRate > 0 && T > 8 && marginal > 0) {
      let won = 0;
      for (const o of v.tracker.prices) if (o.winner === v.me) won++;
      const behind = p.paceRate * (v.round - 1) - won;
      if (behind > 1) bid *= Math.min(p.paceMax, 1 + p.paceK * (behind - 1));
    }
    if (T > 3) bid = Math.min(bid, p.capMul * prices[v.letter]!);
    // Finishing a word now is worth more than the letter's average value:
    // the points are certain and the coins come back for the next buy.
    if (p.completeMul > 0) {
      const gain = this.completionGain(rack, v.letter, p.completeLen);
      if (gain >= p.completeMin) bid = Math.max(bid, p.completeMul * prices[v.letter]!);
    }
    if (T <= p.riskN && marginal > 0 && this.chasingFourth(v, val.base)) bid *= p.riskUp;
    if (T <= p.chaseN && T > 1 && marginal > 0 && this.chasingFirst(v, val.base)) bid *= p.chaseUp;
    // Focus (Lambi Lambiii completes a 7-letter word by round ~25 with fewer
    // early buys): pay up for letters the best target word still needs, and
    // spend less on letters it doesn't while the match is young.
    if ((p.focusMul > 0 || p.focusCut < 1) && T > 3 && val.bestWord >= 0) {
      const d = this.dict;
      let needed = false;
      for (let q = d.dOff[val.bestWord]!; q < d.dOff[val.bestWord + 1]!; q++) {
        if (d.dl[q] === v.letter && d.dc[q]! > rack[v.letter]!) needed = true;
      }
      if (needed && p.focusMul > 0) bid = Math.max(bid, p.focusMul * prices[v.letter]!);
      else if (!needed && T > p.focusT) bid *= p.focusCut;
    }
    if (p.bidNoise > 0) bid *= Math.exp(p.bidNoise * this.rng.normal());
    if (v.auctionType === "FirstPrice") bid = this.shade(bid, prices[v.letter]!);
    bid = Math.max(0, Math.min(balance, Math.floor(bid)));
    return { words, bid, value: val.base, marginal, mu, ms: performance.now() - t0 };
  }

  // Points the best word of at least minLen letters gains if we add `letter`.
  private completionGain(rack: Counts, letter: number, minLen: number): number {
    const best = (r: Counts): number => {
      const i = playable(this.dict, r, minLen, 1)[0];
      return i === undefined ? 0 : this.dict.reward[i]!;
    };
    const plus = new Uint8Array(rack);
    plus[letter]!++;
    return best(plus) - best(rack);
  }

  // Projected finish from public data: each rival's score plus ~3 points per
  // tile they hold (won tiles are public, starting tiles are counted blind).
  // True when we look 5th or 6th but within riskGap of 4th.
  // Projected finish (score + rack value; rivals: score + ~3 points per tile
  // held). True when exactly one rival is ahead and within chaseGap points.
  private chasingFirst(v: View, rackValue: number): boolean {
    const mine = v.score + Math.max(0, rackValue);
    const proj: number[] = [];
    for (const o of v.tracker.opps.values()) {
      let held = o.hidden;
      for (let k = 0; k < 26; k++) held += o.known[k]!;
      proj.push(o.score + 3 * held);
    }
    const ahead = proj.filter((x) => x > mine);
    return ahead.length === 1 && ahead[0]! - mine <= this.p.chaseGap;
  }

  private chasingFourth(v: View, rackValue: number): boolean {
    const mine = v.score + Math.max(0, rackValue);
    const proj: number[] = [];
    for (const o of v.tracker.opps.values()) {
      let held = o.hidden;
      for (let k = 0; k < 26; k++) held += o.known[k]!;
      proj.push(o.score + 3 * held);
    }
    proj.sort((a, b) => b - a);
    const ahead = proj.filter((x) => x > mine).length;
    if (ahead < 4) return false;
    return proj[3]! - mine <= this.p.riskGap;
  }

  // A vowel is worth more to a rack starved of vowels, a consonant to one
  // drowning in them; 7-letter words need roughly 3 vowels to 4 consonants.
  private balanceFactor(rack: Counts, letter: number): number {
    let tiles = 0;
    let vowels = 0;
    for (let k = 0; k < 26; k++) {
      tiles += rack[k]!;
      if (VOWELS.has(k)) vowels += rack[k]!;
    }
    if (tiles < 3) return 1;
    const frac = vowels / tiles;
    const isVowel = VOWELS.has(letter);
    const want = isVowel ? 0.4 - frac : frac - 0.45;
    return Math.max(0.5, 1 + this.p.vowelBal * want * 2.5);
  }

  // First-price: pick the bid maximising (value - bid) * P(rival max < bid),
  // the rival max modelled as lognormal around the going price.
  private shade(value: number, price: number): number {
    const s = this.p.shadeSigma;
    const mu = Math.log(Math.max(1, price * 1.25));
    let best = 0;
    let bestU = 0;
    for (let b = 1; b <= value; b++) {
      const z = (Math.log(b) - mu) / s;
      const F = 0.5 * (1 + erf(z / Math.SQRT2));
      const u = (value - b) * F;
      if (u > bestU) {
        bestU = u;
        best = b;
      }
    }
    return best;
  }
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

void VALUE;
