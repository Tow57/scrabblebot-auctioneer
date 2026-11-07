import { expect, test } from "vitest";
import { makeFaceBidCandidate } from "./face-bid-ablation";
import { DictionaryIndex, LETTER_VALUE } from "./v1/dictionary";
import { StrategyEngine, type StrategyContext } from "./v1/strategy";

const dictionary = new DictionaryIndex(["AT", "CAT", "HAT", "KITE", "QUA", "ZOO"]);
function context(letters: string, letter: string, extra: Partial<StrategyContext> = {}): StrategyContext {
  const myRack = new Map<string, number>();
  for (const tile of letters) myRack.set(tile, (myRack.get(tile) ?? 0) + 1);
  return { myRack, letter, myBalance: 100, bagTotal: 60, participantCount: 6,
    auctionType: "Vickrey", estimatedPrice: 3, ...extra };
}

test("face ablation changes only positive high-face bids, with weight-zero and one-point parity", () => {
  const frozen = new StrategyEngine(dictionary, { capitalAllowance: true });
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    for (const [letters, letter] of [["CT", "A"], ["AT", "H"], ["ITE", "K"], ["UA", "Q"], ["OO", "Z"]]) {
      const ctx = context(letters!, letter!, { auctionType });
      const base = frozen.decide(ctx);
      expect(base.bid).toBeGreaterThan(0);
      for (const weight of [0, 0.1, 0.5]) {
        const result = makeFaceBidCandidate(dictionary, weight).decide(ctx);
        const expected = Math.min(100, Math.ceil(base.bid * (1 + weight * (LETTER_VALUE[letter!]! - 1))));
        expect(result.bid).toBe(expected);
        expect(result.word).toBe(base.word);
        expect(result.plan).toEqual(base.plan);
        expect(result.cashout).toBe(base.cashout);
        expect(result.exact).toBe(base.exact);
      }
    }
  }
});

test("face boosts retain terminal decisions, affordability, and the original no-junk gate", () => {
  const frozen = new StrategyEngine(dictionary, { capitalAllowance: true });
  const policy = makeFaceBidCandidate(dictionary, 0.5);
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    for (const myBalance of [100, 37, 2.9, 0, -1, NaN]) {
      for (const bagTotal of [60, 1, 0]) {
        const ctx = context("UA", "Q", { myBalance, bagTotal, auctionType });
        const result = policy.decide(ctx);
        if (bagTotal <= 1) expect(result.bid).toBe(frozen.decide(ctx).bid);
        const limit = Number.isFinite(myBalance) ? Math.max(0, Math.floor(myBalance)) : 0;
        expect(Number.isInteger(result.bid) && result.bid >= 0 && result.bid <= limit).toBe(true);
      }
    }
    for (const letter of ["X", "?", "h"]) {
      expect(policy.decide(context("A", letter, { auctionType })).bid).toBe(0);
    }
  }
  for (const weight of [-1, -0.01, 0.5001, NaN, Infinity, -Infinity]) {
    expect(() => makeFaceBidCandidate(dictionary, weight)).toThrow(/finite number between/);
  }
});
