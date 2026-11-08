// The parameter set the live bot plays with. Arena-tuned; see ANALYSIS.md.
import type { LalaParams } from "./lala.js";

// Logged by the live bot so live results can be credited to a version.
export const VERSION = "v2.7.5";

export const TUNED: Partial<LalaParams> = {
  muAlpha: 0.6, kappa0: 3.5, winP: 0.9, dupDecay: 0.8, kappa1: 1, maxMissing: 2,
  liq: 0, share: 0.2, incomeW: 0.3, rho: 0.6,
  // v1.1 introduced the late reserve (lateMu) and the bid cap relative to the
  // going price (capMul); their values are set in v2.1 below.
  // v2.0a: vowels valued like 1-point consonants (v1 bought 30% vowels vs
  // 37-44% for the top bots) and a price prior that follows the live stage
  // curve (high-value letters get cheaper late).
  vowelUse: 1.0,
  // v2.0: leftover tile values learned from 218k simulated positions
  // (scripts/train-leave.ts); vowels come out worth more than 1-point
  // consonants. Paired check vs v1.1 (market, n=1000): win +4.6 pts.
  leaveW: 1,
  // v2.4: back to the v2.0 settings, its best live version. Live by version
  // (analysis/versions.ts): v2.0 17 games, 41% wins, place 2.29, score 103;
  // v2.2 (+ starvation cash-in) 38 games, place 2.97, score 81; v2.3 (+ lateMu 1)
  // 11 games, place 3.45, score 68. The starvation rule cashes 5-6 letter words
  // at 2-2.5x instead of building 7+ at 3x, and v2.2's own score fell 22 points
  // against weaker best rivals (101 vs 109). Both rules are off.
  mu0: 0.3, premium: 1.0, lateMu: 0.6, // capMul 1.6 until v2.7.5 (below)
  // v2.7.4: narrow starvation rule. Live games kept showing Lala broke for
  // 15-25 rounds while holding a complete 7-8 letter word (PIONEERS at 2
  // coins with 16 auctions left). Below 8 coins with 10+ auctions left, cash
  // the best word of 7+ letters (keeps the 3x bonus; v2.2's 4+ letter version
  // below 15 coins cost points). Paired sim (market, n=1200): win +3.8 +/- 1.9
  // pts, place -0.139 +/- 0.047, score +1.7, last places 2.9% -> 1.2%.
  starveBal: 8, starveT: 10, starveMinLen: 7,
  // v2.5: learned from the top bots (analysis/reverse.ts, last 1200 matches).
  // They pay 1.2-1.42x the going price for a letter that completes a word
  // within a round (vs 1.18-1.24x for other letters); v2 paid 1.18x vs 1.20x.
  // Bid at least 1.4x the price when the letter completes a 6+ letter word
  // worth 12+ more points. Paired sim (market, n=1200): place -0.128 +/- 0.081,
  // score +2.1 +/- 1.1, rating value +0.054 +/- 0.036. Decisions <= 25 ms.
  completeMul: 1.4, completeMin: 12, completeLen: 6,
  // v2.7: back to the v2.5.1 settings. Live: v2.5.1 23 games, place 2.57,
  // 26% wins; v2.6 + v2.6.1 (real-game leave table, recent prices) 12 games,
  // place ~3.2, rating 2031 -> 1929. The real-game table won in simulation but
  // not live; it was fitted to every bot's racks, weak bots included.
  leaveLive: 0, leaveScale: 0.7, phasePrices: 1,
  // v2.7.5: tighter price cap (1.6x -> 1.25x the going price). Live, the
  // leaders bid ~1.10-1.19x early while Lala bid 1.36x, won the expensive
  // early tiles and was broke by round 45. First sim field that reproduces
  // live Lala ("top": Waupus/james/Lambi-style rivals; Lala 17-22% wins,
  // 4.1 early tiles for 62 coins vs 4.3/66 live). Screen n=300: capMul 1.35
  // the only significant win among 9 variants. Fresh seeds n=900: capMul
  // 1.25 win +5.0 +/- 2.7 pts (21% -> 26%), place -0.23, score +2.8, rating
  // value +0.095 +/- 0.038; 1.35 win +4.6, place -0.16.
  capMul: 1.25,
};

// Simulated stand-in for strong live entrants (calibrated in ANALYSIS.md):
// they cash 7-letter words as soon as they have them and bid with noise.
export const LIVELIKE: Partial<LalaParams> = {
  playK: 0.3, minPlayLen: 7, liq: 0.5, bidNoise: 0.25, lateMu: 0.6, mu0: 0.34,
};

// v2 rival pool, one style per profiled live bot (analysis/topbots.ts, last
// 900 matches). All value letters with LIVE_USE, so they buy vowels at the
// live rate (~42%) instead of v1's 30%.
const RIVAL_BASE: Partial<LalaParams> = { ...LIVELIKE, liveUse: 1, kappa0: 3.5, kappa1: 0.6, mu0: 0.31 };
export const RIVAL_STYLES: Partial<LalaParams>[] = [
  // Lambi Lambiii: first word ~round 19, heavy early spend, ends near 0 coins.
  { ...RIVAL_BASE, premium: 1.15, minPlayLen: 6, playK: 0.25, lateMu: 0.7 },
  // Chinese Dante: cashes 7-letter words fast, spends early-mid.
  { ...RIVAL_BASE, premium: 1.05, minPlayLen: 7, playK: 0.3 },
  // Nijello: patient, first word ~round 42, spends late.
  { ...RIVAL_BASE, premium: 0.95, minPlayLen: 7, playK: 0.7, lateMu: 0.45 },
  // postturing: buys the most tiles (14/match).
  { ...RIVAL_BASE, premium: 1.1, share: 0.27, minPlayLen: 7, playK: 0.4 },
  // A typical mid-table entrant.
  { ...RIVAL_BASE, premium: 1.0, bidNoise: 0.35 },
];

// v2.8 field: the late-2026 leaders (analysis/study.ts, live profiles).
// Waupus (56% wins) and james (49%) bid ~1.10-1.19x the reference price over
// rounds 1-20 (Lala 1.36x), hold ~40 coins at round 45 (Lala 15) and buy
// 4.6 tiles in the last 23 auctions at up to 1.7x (Lala 2.5).
export const TOP_STYLES: Partial<LalaParams>[] = [
  // Waupus
  { earlyN: 20, earlyPremium: 0.8, premium: 0.95, lateMu: 0.45 },
  // james
  { earlyN: 20, earlyPremium: 0.88, premium: 0.97, lateMu: 0.5 },
  // Lambi Lambiii (from the v2 pool)
  RIVAL_STYLES[0]!,
  // Waupus again (two of the five seats: the leaders are in most games)
  { earlyN: 20, earlyPremium: 0.8, premium: 0.95, lateMu: 0.45 },
  // A v2.7-like rival
  {},
];

// Live A/B test (interleaved by match id, so both arms face the same field at
// the same time). Arm A plays TUNED; arm B plays TUNED + VARIANT_B.
// Set VARIANT_B to {} to switch the test off.
// Last test (earlyN 25, earlyPremium 1.15: bid 15% more over the first 25
// auctions) lost: arm A 11 games place 2.36, 0% bottom-two; arm B 7 games place
// 3.43, 14% bottom-two. Off until the next variant.
export const VARIANT_B: Partial<LalaParams> = {};
