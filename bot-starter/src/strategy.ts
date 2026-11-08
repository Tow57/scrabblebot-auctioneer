import { DictionaryIndex, LETTER_VALUE, loadDictionary, rackToCounts, scoreWord } from "./dictionary.js";
import { RackOptimizer, type SearchBudget } from "./optimizer.js";

export { canSpell, LETTER_VALUE, loadDictionary, rackToCounts, scoreWord } from "./dictionary.js";

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
}

export interface StrategyOptions {
  /** Opt-in at the library level; the tournament worker enables this measured policy. */
  capitalAllowance?: boolean;
  /** Only two-player Vickrey matches; zero preserves the original policy. */
  headsUpFaceBidWeight?: number;
  /** Only tables with at least three participants in Vickrey matches. Default zero. */
  multiwayFaceBidWeight?: number;
  /** Opt-in for drivers that cash the selected word before placing a new bid. */
  wordFirst?: boolean;
}

/** Stateful only for dictionary/search caches; decisions use this snapshot alone. */
export class StrategyEngine {
  readonly dictionary: DictionaryIndex;
  readonly optimizer: RackOptimizer;
  private readonly headsUpFaceBidWeight: number;
  private readonly multiwayFaceBidWeight: number;

  constructor(words: readonly string[] | DictionaryIndex, private readonly options: StrategyOptions = {}) {
    const weight = options.headsUpFaceBidWeight ?? 0;
    if (!Number.isFinite(weight) || weight < 0 || weight > 0.5) {
      throw new Error("Heads-up face bid weight must be a finite number between 0 and 0.5");
    }
    this.headsUpFaceBidWeight = weight;
    const multiwayWeight = options.multiwayFaceBidWeight ?? 0;
    if (!Number.isFinite(multiwayWeight) || multiwayWeight < 0 || multiwayWeight > 0.5) {
      throw new Error("Multiway face bid weight must be a finite number between 0 and 0.5");
    }
    this.multiwayFaceBidWeight = multiwayWeight;
    this.dictionary = words instanceof DictionaryIndex ? words : new DictionaryIndex(words);
    this.optimizer = new RackOptimizer(this.dictionary);
  }

  decide(ctx: StrategyContext): StrategyDecision {
    const start = performance.now();
    // Reserve 5ms below the measured100ms compute guard; caller deadlines may be tighter.
    const deadline = Math.min(start + 95, ctx.deadlineMs ?? Infinity);
    const counts = rackToCounts(ctx.myRack);
    const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
    const bagTotal = Number.isFinite(ctx.bagTotal) ? Math.max(0, Math.floor(ctx.bagTotal)) : 0;
    const budget: SearchBudget = { deadlineMs: Math.min(deadline, start + 40), maxStates: 10_000, states: 0 };
    const current = this.optimizer.optimize(counts, budget);
    const plan = [...current.words].sort((a, b) => scoreWord(b) - scoreWord(a) || a.localeCompare(b));
    let size = 0;
    for (const count of counts) size += count;
    const word = plan.find(candidate => candidate.length >= 7)
      ?? ((balance < 12 || size >= 12 || bagTotal <= 3) ? plan[0] ?? null : null);
    if (this.options.wordFirst && word !== null) {
      return { bid: 0, word, plan, cashout: current.score, exact: current.exact, elapsedMs: performance.now() - start };
    }
    let bid = 0;
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
        const price = Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 3;
        const expectedWins = Math.max(1, bagTotal / participants);
        const pacing = Math.max(0.5, Math.min(3, balance / (expectedWins * price)));
        const value = Math.max(immediate, completion);
        if (value > 0) {
          const coreBid = Math.ceil(value * pacing);
          // Starting capital has no terminal score. Allocate some buying power
          // independently of small option values when opponents set high prices.
          // An incomplete option may still need two purchases; keep their funding.
          const fundedWins = immediate > 0 ? expectedWins : Math.max(3, expectedWins);
          const allowance = balance / fundedWins * (ctx.auctionType === "FirstPrice" ? 0.5 : 1);
          const capitalBid = this.options.capitalAllowance && bagTotal > 1 ? Math.ceil(value + allowance) : 0;
          bid = Math.min(balance, Math.max(coreBid, capitalBid));
          if (ctx.auctionType === "FirstPrice") bid = Math.max(1, Math.floor(bid * 0.8));
        }
      }
    }
    if (this.headsUpFaceBidWeight > 0 && ctx.participantCount === 2 && ctx.auctionType === "Vickrey"
      && bagTotal > 1 && bid > 0 && /^[A-Z]$/.test(ctx.letter)) {
      bid = Math.min(balance, Math.ceil(bid * (1 + this.headsUpFaceBidWeight * (LETTER_VALUE[ctx.letter] - 1))));
    }
    if (this.multiwayFaceBidWeight > 0 && ctx.participantCount >= 3 && ctx.auctionType === "Vickrey"
      && bagTotal > 1 && bid > 0 && /^[A-Z]$/.test(ctx.letter)) {
      bid = Math.min(balance, Math.ceil(bid * (1 + this.multiwayFaceBidWeight * (LETTER_VALUE[ctx.letter] - 1))));
    }
    return { bid, word, plan, cashout: current.score, exact: current.exact, elapsedMs: performance.now() - start };
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
