// Standalone experiment: never enabled by the production worker.
import { StrategyEngine, type StrategyContext, type StrategyDecision } from "../../../../bot-starter/src/strategy.js";
import { countsKey, DictionaryIndex, rackToCounts, type TileCounts } from "../../../../bot-starter/src/dictionary.js";
import type { SearchBudget } from "../../../../bot-starter/src/optimizer.js";

const TILE_DISTRIBUTION = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
const compatibleIndices = new WeakMap<object, DictionaryIndex>();

export interface RolloutDecision extends StrategyDecision {
  rolloutUsed: boolean;
  rolloutSamples: number;
  rolloutMean?: number;
  rolloutSE?: number;
  rolloutValue?: number;
  baseBid: number;
  searchStates: number;
}

export function futureAcquisitions(rackSize: number, bagTotal: number, participants: number): number {
  return Math.max(0, Math.min(3, Math.floor(Math.max(0, bagTotal - 1) / Math.max(1, participants)), 9 - rackSize));
}

export function conservativeMarginal(gains: readonly number[]): { mean: number; se: number; value: number } {
  if (gains.length === 0) return { mean: 0, se: 0, value: 0 };
  const mean = gains.reduce((sum, gain) => sum + gain, 0) / gains.length;
  const variance = gains.length > 1
    ? gains.reduce((sum, gain) => sum + (gain - mean) ** 2, 0) / (gains.length - 1) : 0;
  const se = Math.sqrt(variance / gains.length);
  return { mean, se, value: Math.max(0, mean - 0.5 * se) };
}

/**
 * Fixed common futures for both valuation arms. This is an uncertainty prior,
 * not the private bag: it ignores spent tiles and opponents' starting racks.
 */
export function sampleCommonFutures(
  rack: TileCounts, offered: number, acquisitions: number, sampleCount: number, seedText: string,
): TileCounts[] {
  const prior = TILE_DISTRIBUTION.map((count, letter) => Math.max(0, count - rack[letter] - (letter === offered ? 1 : 0)));
  let seed = 2166136261;
  for (const character of countsKey(rack) + `/${offered}/${acquisitions}/${seedText}`) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const samples: TileCounts[] = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const pool = [...prior];
    const future = new Uint8Array(26);
    for (let tile = 0; tile < acquisitions; tile++) {
      const total = pool.reduce((sum, count) => sum + count, 0);
      if (total === 0) break;
      let draw = Math.floor(random() * total);
      for (let letter = 0; letter < 26; letter++) {
        draw -= pool[letter];
        if (draw < 0) {
          pool[letter]--;
          future[letter]++;
          break;
        }
      }
    }
    samples.push(future);
  }
  return samples;
}

function bidFromMarginal(value: number, immediate: number, balance: number, ctx: StrategyContext): number {
  if (value <= 0 || balance <= 0) return 0;
  const participants = Number.isFinite(ctx.participantCount) ? Math.max(1, ctx.participantCount) : 6;
  const price = Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 3;
  const expectedWins = Math.max(1, ctx.bagTotal / participants);
  const pacing = Math.max(0.5, Math.min(3, balance / (expectedWins * price)));
  const fundedWins = immediate > 0 ? expectedWins : Math.max(3, expectedWins);
  const allowance = balance / fundedWins * (ctx.auctionType === "FirstPrice" ? 0.5 : 1);
  let bid = Math.min(balance, Math.max(Math.ceil(value * pacing), Math.ceil(value + allowance)));
  if (ctx.auctionType === "FirstPrice") bid = Math.max(1, Math.floor(bid * 0.8));
  return bid;
}

export function makeRolloutCandidate(dictionary: DictionaryIndex): { decide(ctx: StrategyContext): RolloutDecision } {
  // tsx can load separate class identities across the work/package boundary.
  // Normalize once per shared source index rather than rebuilding every match.
  const words = dictionary.words;
  let compatible = dictionary;
  if (!(dictionary instanceof DictionaryIndex)) {
    compatible = compatibleIndices.get(dictionary) ?? new DictionaryIndex([...words]);
    compatibleIndices.set(dictionary, compatible);
  }
  const engine = new StrategyEngine(compatible, { capitalAllowance: true });
  // Include the base engine's searches in the same 10,000-state accounting.
  const optimize = engine.optimizer.optimize.bind(engine.optimizer);
  let states = 0;
  engine.optimizer.optimize = (counts, budget) => {
    const result = optimize(counts, budget);
    states += result.states;
    return result;
  };

  return {
    decide(ctx): RolloutDecision {
      const start = performance.now();
      const deadline = Math.min(start + 100, ctx.deadlineMs ?? Infinity);
      states = 0;
      const base = engine.decide({ ...ctx, deadlineMs: deadline });
      const fallback = (): RolloutDecision => ({
        ...base, elapsedMs: performance.now() - start,
        rolloutUsed: false, rolloutSamples: 0, baseBid: base.bid, searchStates: states,
      });
      const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
      // The unchanged base handles word turnover, the final two auctions, and
      // invalid offers. Its original bid is always retained.
      if (base.word || !base.exact || balance === 0 || ctx.bagTotal <= 1
        || !/^[A-Z]$/.test(ctx.letter) || performance.now() + 2 >= deadline || states >= 10_000) return fallback();
      const rack = rackToCounts(ctx.myRack);
      const rackSize = rack.reduce((sum, count) => sum + count, 0);
      const participants = Number.isFinite(ctx.participantCount) ? Math.max(1, ctx.participantCount) : 6;
      const horizon = futureAcquisitions(rackSize, ctx.bagTotal, participants);
      if (horizon === 0) return fallback();
      const offered = ctx.letter.charCodeAt(0) - 65;
      const budget: SearchBudget = { deadlineMs: deadline, maxStates: 10_000, states };
      const augmented = rack.slice();
      augmented[offered]++;
      const currentWithLetter = engine.optimizer.optimize(augmented, budget);
      if (!currentWithLetter.exact || performance.now() >= deadline) return fallback();
      const immediate = Math.max(0, currentWithLetter.score - base.cashout);
      const futures = sampleCommonFutures(rack, offered, horizon, 16, `${ctx.bagTotal}/${participants}`);
      const gains: number[] = [];
      const rolloutStart = performance.now();
      for (const future of futures) {
        if (performance.now() >= deadline) return fallback();
        const without = rack.slice();
        for (let letter = 0; letter < 26; letter++) without[letter] += future[letter];
        const withLetter = without.slice();
        withLetter[offered]++;
        const absent = engine.optimizer.optimize(without, budget);
        const present = engine.optimizer.optimize(withLetter, budget);
        if (!absent.exact || !present.exact || performance.now() >= deadline) return fallback();
        gains.push(Math.max(0, present.score - absent.score));
        if (gains.length === 8) {
          // Commit eight only when a second batch is not predicted to fit.
          // Any attempted inexact pair instead falls back to the original bid.
          const firstBatchMs = performance.now() - rolloutStart;
          if (performance.now() + firstBatchMs + 1 >= deadline) break;
        }
      }
      if (performance.now() >= deadline) return fallback();
      const estimate = conservativeMarginal(gains);
      const value = Math.max(immediate, estimate.value);
      const bid = Math.min(balance, Math.max(base.bid, bidFromMarginal(value, immediate, balance, ctx)));
      return {
        ...base, bid, elapsedMs: performance.now() - start,
        rolloutUsed: true, rolloutSamples: gains.length, rolloutMean: estimate.mean,
        rolloutSE: estimate.se, rolloutValue: value, baseBid: base.bid, searchStates: states,
      };
    },
  };
}
