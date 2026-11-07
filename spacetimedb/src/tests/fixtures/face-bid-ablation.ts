// Bid-composition ablation motivated by matched public purchases, not a model
// of any named opponent. Keep frozen v1's search, usefulness gate and words.
import { makeScaledV1, type OpponentPolicy } from "./opponent-policies";
import { LETTER_VALUE } from "./v1/dictionary";

export function makeFaceBidCandidate(
  dictionary: Parameters<typeof makeScaledV1>[1],
  weight: number,
): OpponentPolicy {
  if (!Number.isFinite(weight) || weight < 0 || weight > 0.5) {
    throw new Error("Face bid weight must be a finite number between 0 and 0.5");
  }
  const frozen = makeScaledV1(1, dictionary);
  return {
    decide(ctx) {
      const base = frozen.decide(ctx);
      const face = /^[A-Z]$/.test(ctx.letter) ? LETTER_VALUE[ctx.letter] : undefined;
      if (ctx.bagTotal <= 1 || base.bid <= 0 || face === undefined) return base;
      const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
      return { ...base, bid: Math.min(balance, Math.ceil(base.bid * (1 + weight * (face - 1)))) };
    },
  };
}
