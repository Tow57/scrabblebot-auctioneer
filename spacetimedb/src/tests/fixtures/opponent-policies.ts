// Public-data-inspired adversaries, not reconstructions of named live bots.
// Freeze the legal search and base policy to tournament-v1.0 so improving the
// candidate cannot silently move its opponents along with it.
import { DictionaryIndex, rackToCounts } from "./v1/dictionary";
import { StrategyEngine, type StrategyContext, type StrategyDecision } from "./v1/strategy";

export type OpponentKind = "market" | "market-v1" | "liquid" | "target";
export interface OpponentPolicy {
  decide(ctx: StrategyContext): StrategyDecision;
}
type DictionaryInput = readonly string[] | { readonly words: ReadonlySet<string> };

const indexes = new WeakMap<object, DictionaryIndex>();
function indexFor(source: DictionaryInput): DictionaryIndex {
  if (source instanceof DictionaryIndex) return source;
  let index = indexes.get(source);
  if (!index) {
    index = new DictionaryIndex("words" in source ? [...source.words] : source);
    indexes.set(source, index);
  }
  return index;
}

// Rounded settled-price observations from public matches 42641–42690. These
// are second prices, not estimates of a particular opponent's private bid.
const PRICE_PRIOR: Readonly<Record<string, number>> = {
  A: 7, B: 12, C: 12, D: 9, E: 7, F: 13, G: 9, H: 13, I: 7,
  J: 23, K: 19, L: 7, M: 12, N: 7, O: 7, P: 12, Q: 20, R: 7,
  S: 7, T: 7, U: 7, V: 11, W: 14, X: 20, Y: 15, Z: 26,
};

export function makeOpponent(kind: OpponentKind, dictionary: DictionaryInput): OpponentPolicy {
  if (!["market", "market-v1", "liquid", "target"].includes(kind)) throw new Error(`Unknown opponent policy: ${kind}`);
  const engine = new StrategyEngine(indexFor(dictionary), { capitalAllowance: kind === "target" || kind === "market-v1" });
  return {
    decide(ctx): StrategyDecision {
      const started = performance.now();
      const deadline = Math.min(started + 100, ctx.deadlineMs ?? Infinity);
      const base = engine.decide({ ...ctx, deadlineMs: deadline });
      const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
      const price = Math.max(PRICE_PRIOR[ctx.letter] ?? 7,
        Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 7);
      let size = 0;
      for (const count of ctx.myRack.values()) size += count;
      const pressure = Math.max(12, 2 * (Number.isFinite(ctx.estimatedPrice) ? ctx.estimatedPrice : 7));
      const word = kind === "liquid"
        ? base.plan.find(candidate => candidate.length >= 6)
          ?? ((balance < pressure || size >= 11 || ctx.bagTotal <= 3) ? base.plan[0] ?? null : null)
        : base.word;
      let bid = base.bid;
      // Zero from v1 means no reachable immediate/near-complete word uses the
      // incoming copy. A price prior alone must not make junk tiles desirable.
      if (base.bid > 0 && balance > 0 && ctx.bagTotal > 1 && /^[A-Z]$/.test(ctx.letter)) {
        const counts = rackToCounts(ctx.myRack);
        const letter = ctx.letter.charCodeAt(0) - 65;
        const augmented = counts.slice();
        augmented[letter]++;
        // Normally an exact cache hit from v1's preceding augmented search.
        // A bounded fallback can still supply a legal lower bound.
        const possible = engine.optimizer.optimize(augmented, { deadlineMs: deadline, maxStates: 10_000, states: 0 });
        let copiesUsed = 0;
        for (const candidate of possible.words) for (const used of candidate) if (used === ctx.letter) copiesUsed++;
        const immediate = copiesUsed > counts[letter] ? Math.max(0, possible.score - base.cashout) : 0;
        // Near a cashout, reserve buying power for at most the remaining tiles
        // needed to reach seven. This caps market-floor aggression without
        // tying the policy to the candidate's horizon/target valuation formula.
        const purchases = immediate > 0 ? 1 : Math.max(2, 7 - size);
        const cap = Math.max(1, Math.floor(balance / purchases));
        const premium = kind === "target" ? Math.ceil(price * 0.3) + 1 : 2;
        const marketBid = Math.ceil(price + premium + Math.min(30, immediate * (kind === "liquid" ? 0.4 : 0.6)));
        // First-price opponents pay these bids themselves, so retain shading.
        const capped = Math.min(cap, marketBid);
        const shaded = ctx.auctionType === "FirstPrice" ? Math.max(1, Math.floor(capped * 0.8)) : capped;
        bid = Math.max(base.bid, shaded);
      }
      if (ctx.bagTotal === 0) bid = 0;
      return { ...base, bid: Math.min(balance, Math.max(0, Math.floor(bid))), word,
        elapsedMs: performance.now() - started };
    },
  };
}

/** Isolate bid aggression while freezing v1's words, search and endgame. */
export function makeScaledV1(scale: number, dictionary: DictionaryInput): OpponentPolicy {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) {
    throw new Error("V1 bid scale must be a finite number between 0.5 and 2");
  }
  const engine = new StrategyEngine(indexFor(dictionary), { capitalAllowance: true });
  return {
    decide(ctx): StrategyDecision {
      const base = engine.decide(ctx);
      if (ctx.bagTotal <= 1) return base;
      const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
      return { ...base, bid: Math.min(balance, Math.ceil(base.bid * scale)) };
    },
  };
}
