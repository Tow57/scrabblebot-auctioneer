// Experiment-only wrappers. The frozen production v1 policy remains unchanged.
import { DictionaryIndex, scoreWord } from "./v1/dictionary";
import { StrategyEngine, type StrategyContext, type StrategyDecision } from "./v1/strategy";

type DictionaryInput = readonly string[] | { readonly words: ReadonlySet<string> };
export interface CashoutAblationOptions {
  terminalDenial?: boolean;
  highRewardCashout?: number;
}
export interface CashoutAblation {
  decide(ctx: StrategyContext): StrategyDecision;
}

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

export function makeCashoutAblation(dictionary: DictionaryInput, options: CashoutAblationOptions = {}): CashoutAblation {
  if (options.highRewardCashout !== undefined && (!Number.isFinite(options.highRewardCashout) || options.highRewardCashout <= 0)) {
    throw new Error("High-reward cashout threshold must be a positive finite number");
  }
  const engine = new StrategyEngine(indexFor(dictionary), { capitalAllowance: true });
  return {
    decide(ctx): StrategyDecision {
      const base = engine.decide(ctx);
      const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
      const price = Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 3;
      let word = base.word;
      if (!word && options.highRewardCashout !== undefined && balance < Math.max(12, 2 * price)) {
        word = base.plan.filter(candidate => scoreWord(candidate) >= options.highRewardCashout!)
          .sort((a, b) => scoreWord(b) - scoreWord(a) || a.localeCompare(b))[0] ?? null;
      }
      // Only the last usable auction: earlier cash still funds future tiles.
      // All-real-player fixtures have no later useful purchase. This is not a
      // dominance claim for practice tables whose built-in sims play the final
      // tile synchronously before the match ends.
      const bid = ctx.bagTotal === 0 ? 0
        : options.terminalDenial && ctx.bagTotal === 1 && /^[A-Z]$/.test(ctx.letter) ? balance : base.bid;
      return bid === base.bid && word === base.word ? base : { ...base, bid, word };
    },
  };
}
