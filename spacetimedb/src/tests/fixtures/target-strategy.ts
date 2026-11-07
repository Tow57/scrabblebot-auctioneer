import { countsKey, DictionaryIndex, LETTER_VALUE, loadDictionary, rackToCounts, scoreWord, type TileCounts } from "../../../../bot-starter/src/dictionary.js";
import { RackOptimizer, type SearchBudget } from "../../../../bot-starter/src/optimizer.js";

export { canSpell, LETTER_VALUE, loadDictionary, rackToCounts, scoreWord } from "../../../../bot-starter/src/dictionary.js";

export type AuctionType = "Vickrey" | "FirstPrice";

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: ReadonlyMap<string, number>;
  bagTotal?: number;
  participantCount?: number;
  auctionType?: AuctionType;
  estimatedPrice?: number;
  deadlineMs?: number;
  dictionary?: readonly string[];
}

export interface StrategyContext extends BidContext {
  bagTotal: number;
  participantCount: number;
  auctionType: AuctionType;
  estimatedPrice: number;
}

export interface WordContext {
  myRack: ReadonlyMap<string, number>;
  dictionary: readonly string[];
  myBalance?: number;
  bagTotal?: number;
  deadlineMs?: number;
}

export interface StrategyDecision {
  bid: number;
  word: string | null;
  plan: string[];
  cashout: number;
  /** Whether the current rack's cashout partition was proved optimal. */
  exact: boolean;
  elapsedMs: number;
  /** Both bounded target-potential calculations completed; experiment only. */
  targetUsed?: boolean;
}

export interface StrategyOptions {
  /** Opt-in at the library level; the tournament worker enables this measured policy. */
  capitalAllowance?: boolean;
  /** Experimental controlled-completion valuation; production default is off. */
  targetPlanning?: boolean;
  targetDiscount?: 0.65 | 0.85;
  targetBidFactor?: 0.5 | 1 | 2;
  cashoutLength?: 6 | 7;
  /** Explicitly separates market liquidity from target valuation in ablations. */
  liquidityMultiplier?: 0 | 1 | 2;
  /** Keep experimental future reserves from suppressing the original core bid. */
  protectCoreBid?: boolean;
}

const TILE_DISTRIBUTION = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
const VALUES = TILE_DISTRIBUTION.map((_, letter) => LETTER_VALUE[String.fromCharCode(65 + letter)]);

/** Exact sampling-without-replacement tails for one letter: P(count >= 0..3). */
export function remainingLetterChances(available: number, total: number, draws: number): readonly number[] {
  const take = Math.max(0, Math.min(total, Math.floor(draws)));
  const distribution = [1, 0, 0];
  for (let draw = 0; draw < take; draw++) {
    for (let successes = 2; successes >= 0; successes--) {
      const stay = distribution[successes] * (1 - Math.max(0, available - successes) / (total - draw));
      const enter = successes > 0 ? distribution[successes - 1] * Math.max(0, available - successes + 1) / (total - draw) : 0;
      distribution[successes] = stay + enter;
    }
  }
  let below = 0;
  return [1, ...distribution.map(probability => {
    below += probability;
    return Math.max(0, Math.min(1, 1 - below));
  })];
}

interface TargetPotential {
  value: number;
  missing: number;
}

/** Stateful only for dictionary/search caches; decisions use this snapshot alone. */
export class StrategyEngine {
  readonly dictionary: DictionaryIndex;
  readonly optimizer: RackOptimizer;

  constructor(words: readonly string[] | DictionaryIndex, private readonly options: StrategyOptions = {}) {
    this.dictionary = words instanceof DictionaryIndex ? words : new DictionaryIndex(words);
    this.optimizer = new RackOptimizer(this.dictionary);
  }

  private targetPotential(
    counts: TileCounts, cashout: number, balance: number, price: number,
    availability: readonly (readonly number[])[], budget: SearchBudget,
  ): TargetPotential | undefined {
    const discount = this.options.targetDiscount ?? 0.65;
    const discounts = [1, discount, discount ** 2, discount ** 3];
    let size = 0;
    let face = 0;
    for (let letter = 0; letter < 26; letter++) {
      size += counts[letter];
      face += counts[letter] * VALUES[letter];
    }
    const leftovers = new Map<string, number>([[countsKey(counts), cashout]]);
    let best = 0;
    let bestMissing = 0;
    let checks = 0;
    for (const entry of this.dictionary.entries) {
      if ((checks++ & 127) === 0 && performance.now() >= budget.deadlineMs) return undefined;
      if (entry.length > size + 3) continue;
      let missing = 0;
      let probability = 1;
      let usedFace = 0;
      for (const [letter, count] of entry.tiles) {
        const deficit = Math.max(0, count - counts[letter]);
        missing += deficit;
        if (missing > 3) break;
        if (deficit) probability *= availability[letter][deficit];
        usedFace += Math.min(count, counts[letter]) * VALUES[letter];
      }
      // Current complete words are already accounted for by exact cashout.
      if (missing === 0 || missing > 3 || probability <= 0) continue;
      probability *= discounts[missing] * Math.min(1, (balance + cashout) / (missing * price));
      const futureCost = 0.5 * missing * price;
      // Three times remaining face value bounds any possible leftover partition.
      if (probability * (entry.score + 3 * (face - usedFace) - cashout - futureCost) <= best) continue;
      const remaining = counts.slice();
      for (const [letter, count] of entry.tiles) remaining[letter] = Math.max(0, remaining[letter] - count);
      const key = countsKey(remaining);
      let salvage = leftovers.get(key);
      if (salvage === undefined) {
        const result = this.optimizer.optimize(remaining, budget);
        if (!result.exact) return undefined;
        salvage = result.score;
        leftovers.set(key, salvage);
      }
      const improvement = probability * Math.max(0, entry.score + salvage - cashout - futureCost);
      if (improvement > best) {
        best = improvement;
        bestMissing = missing;
      }
    }
    return { value: cashout + best, missing: bestMissing };
  }

  decide(ctx: StrategyContext): StrategyDecision {
    const start = performance.now();
    const deadline = Math.min(start + 100, ctx.deadlineMs ?? Infinity);
    const counts = rackToCounts(ctx.myRack);
    const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
    const bagTotal = Number.isFinite(ctx.bagTotal) ? Math.max(0, Math.floor(ctx.bagTotal)) : 0;
    const price = Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 3;
    const budget: SearchBudget = { deadlineMs: Math.min(deadline, start + 40), maxStates: 10_000, states: 0 };
    const current = this.optimizer.optimize(counts, budget);
    const plan = [...current.words].sort((a, b) => scoreWord(b) - scoreWord(a) || a.localeCompare(b));
    let size = 0;
    for (const count of counts) size += count;
    const liquidityMultiplier = this.options.liquidityMultiplier ?? (this.options.targetPlanning ? 2 : 0);
    const liquidityThreshold = Math.max(12, liquidityMultiplier * price);
    const word = plan.find(candidate => candidate.length >= (this.options.cashoutLength ?? 7))
      ?? ((balance < liquidityThreshold || size >= 12 || bagTotal <= 3) ? plan[0] ?? null : null);
    let bid = 0;
    let targetUsed = false;
    if (balance > 0 && bagTotal > 0 && /^[A-Z]$/.test(ctx.letter)) {
      const letter = ctx.letter.charCodeAt(0) - 65;
      const augmented = counts.slice();
      augmented[letter]++;
      budget.deadlineMs = Math.min(deadline, start + 85);
      const withLetter = this.optimizer.optimize(augmented, budget);
      let copiesUsed = 0;
      for (const candidate of withLetter.words) {
        for (const used of candidate) if (used === ctx.letter) copiesUsed++;
      }
      // A bounded second search can improve an old plan without using this tile.
      const immediate = copiesUsed > counts[letter] ? Math.max(0, withLetter.score - current.score) : 0;
      if (bagTotal === 1 && immediate > 0) {
        // The next auction is the unplayable final tile: currency has no further use.
        bid = balance;
      } else {
        const completion = this.dictionary.completionValue(counts, letter, Math.min(2, bagTotal - 1), deadline);
        const participants = Number.isFinite(ctx.participantCount) ? Math.max(1, ctx.participantCount) : 6;
        const expectedWins = Math.max(1, bagTotal / participants);
        const pacing = Math.max(0.5, Math.min(3, balance / (expectedWins * price)));
        const originalValue = Math.max(immediate, completion);
        let value = originalValue;
        let targetReserve = 0;
        if (this.options.targetPlanning && !word && bagTotal > 1 && current.exact && withLetter.exact
          && performance.now() + 5 < deadline) {
          // This prior removes known held/current tiles, but does not pretend to
          // know spent tiles or opponents' initially dealt private letters.
          const prior = TILE_DISTRIBUTION.map((count, index) => Math.max(0, count - counts[index] - (index === letter ? 1 : 0)));
          const total = prior.reduce((sum, count) => sum + count, 0);
          const availability = prior.map(count => remainingLetterChances(count, total, bagTotal - 1));
          budget.deadlineMs = deadline;
          const before = this.targetPotential(counts, current.score, balance, price, availability, budget);
          const after = before && this.targetPotential(augmented, withLetter.score, balance, price, availability, budget);
          if (before && after) {
            targetUsed = true;
            // The default tests equal score/currency utility; smaller factors
            // isolate possible overvaluation without changing the target model.
            const targetValue = (this.options.targetBidFactor ?? 2) * Math.max(0, after.value - before.value);
            if (targetValue > value) {
              value = targetValue;
              targetReserve = Math.min(0.6 * balance, after.missing * price);
            }
          }
        }
        if (value > 0) {
          const unshadedBid = (valuation: number): number => {
            if (valuation <= 0) return 0;
            const coreBid = Math.ceil(valuation * pacing);
            // Starting capital has no terminal score. Allocate some buying power
            // independently of small option values when opponents set high prices.
            // An incomplete option may still need two purchases; keep their funding.
            const fundedWins = immediate > 0 ? expectedWins : Math.max(3, expectedWins);
            const allowance = balance / fundedWins * (ctx.auctionType === "FirstPrice" ? 0.5 : 1);
            const capitalBid = this.options.capitalAllowance && bagTotal > 1 ? Math.ceil(valuation + allowance) : 0;
            return Math.min(balance, Math.max(coreBid, capitalBid));
          };
          const shade = (amount: number): number => amount > 0 && ctx.auctionType === "FirstPrice"
            ? Math.max(1, Math.floor(amount * 0.8)) : amount;
          const originalBid = shade(unshadedBid(originalValue));
          bid = unshadedBid(value);
          if (targetReserve > 0) bid = Math.min(bid, Math.max(1, Math.floor(balance - targetReserve)));
          bid = shade(bid);
          if (this.options.targetPlanning && this.options.protectCoreBid) bid = Math.min(balance, Math.max(originalBid, bid));
        }
      }
    }
    return { bid, word, plan, cashout: current.score, exact: current.exact, elapsedMs: performance.now() - start, targetUsed };
  }
}

const engines = new WeakMap<readonly string[], StrategyEngine>();
let defaultWords: string[] | undefined;
function engineFor(dictionary?: readonly string[]): StrategyEngine {
  const words = dictionary ?? (defaultWords ??= loadDictionary());
  let engine = engines.get(words);
  if (!engine) {
    engine = new StrategyEngine(words);
    engines.set(words, engine);
  }
  return engine;
}

// Convenience wrappers retain the starter's two-function integration surface.
export function decideBid(ctx: BidContext): number {
  return engineFor(ctx.dictionary).decide({
    ...ctx,
    bagTotal: ctx.bagTotal ?? 99,
    participantCount: ctx.participantCount ?? 6,
    auctionType: ctx.auctionType ?? "Vickrey",
    estimatedPrice: ctx.estimatedPrice ?? 3,
  }).bid;
}

export function chooseWord(ctx: WordContext): string | null {
  return engineFor(ctx.dictionary).decide({
    myRack: ctx.myRack, myBalance: ctx.myBalance ?? 0, letter: "", bagTotal: ctx.bagTotal ?? 0,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 3, deadlineMs: ctx.deadlineMs,
  }).word;
}
