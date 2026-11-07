import { expect, test } from "vitest";
import { makeQualityFaceCandidate } from "./quality-face-ablation";
import { DictionaryIndex } from "./v1/dictionary";
import { StrategyEngine, type StrategyContext } from "./v1/strategy";

function context(letters: string, letter = "Q", extra: Partial<StrategyContext> = {}): StrategyContext {
  const myRack = new Map<string, number>();
  for (const tile of letters) myRack.set(tile, (myRack.get(tile) ?? 0) + 1);
  return { myRack, letter, myBalance: 100, bagTotal: 60, participantCount: 6,
    auctionType: "Vickrey", estimatedPrice: 6, ...extra };
}

test("quality boosts require a valuable long word, the new copy, and only common missing letters", () => {
  const dictionary = new DictionaryIndex(["QI", "QUARTER", "SQUEAKS", "HATTERS", "HARDTOP"]);
  const frozen = new StrategyEngine(dictionary, { capitalAllowance: true });
  const one = makeQualityFaceCandidate(dictionary, 0.2, 1);
  const two = makeQualityFaceCandidate(dictionary, 0.2, 2);
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    const complete = context("UARTER", "Q", { auctionType });
    expect(one.decide(complete).bid).toBeGreaterThan(frozen.decide(complete).bid);
    const missingOne = context("UARTR", "Q", { auctionType });
    expect(one.decide(missingOne).bid).toBeGreaterThan(frozen.decide(missingOne).bid);
    const missingTwo = context("UART", "Q", { auctionType });
    expect(one.decide(missingTwo).bid).toBe(frozen.decide(missingTwo).bid);
    expect(two.decide(missingTwo).bid).toBeGreaterThan(frozen.decide(missingTwo).bid);
    // A second rare K, a low-reward H word, and a Q useful only for QI do
    // not establish the required high-quality long-word use of the new copy.
    for (const ctx of [context("SUEAS", "Q", { auctionType }),
      context("ATTERS", "H", { auctionType }), context("QUARTERI", "Q", { auctionType })]) {
      expect(frozen.decide(ctx).bid).toBeGreaterThan(0);
      expect(two.decide(ctx).bid).toBe(frozen.decide(ctx).bid);
    }
    const shortHorizon = context("UART", "Q", { auctionType, bagTotal: 2 });
    expect(two.decide(shortHorizon).bid).toBe(frozen.decide(shortHorizon).bid);
  }
});

test("quality reserve caps only the boost, preserves baseline words and exact terminal decisions", () => {
  const dictionary = new DictionaryIndex(["QI", "QUARTER"]);
  const frozen = new StrategyEngine(dictionary, { capitalAllowance: true });
  const policy = makeQualityFaceCandidate(dictionary, 0.5, 2);
  const funded = context("UART", "Q", { myBalance: 50 });
  const base = frozen.decide(funded);
  expect(policy.decide(funded).bid).toBe(Math.max(base.bid, Math.min(Math.ceil(base.bid * 5.5), 38)));
  for (const myBalance of [100, 10, 2.9, 0]) {
    for (const bagTotal of [60, 1, 0]) {
      const ctx = context("UARTER", "Q", { myBalance, bagTotal });
      const original = frozen.decide(ctx);
      const result = policy.decide(ctx);
      expect(result.bid).toBeGreaterThanOrEqual(original.bid);
      expect(Number.isInteger(result.bid) && result.bid >= 0 && result.bid <= Math.floor(myBalance)).toBe(true);
      if (bagTotal <= 1) expect(result.bid).toBe(original.bid);
      expect(result.word).toBe(original.word);
      expect(result.plan).toEqual(original.plan);
    }
  }
  const alreadyExpired = context("UARTER", "Q", { deadlineMs: performance.now() - 1 });
  expect(policy.decide(alreadyExpired).bid).toBe(frozen.decide(alreadyExpired).bid);
});

test("zero-weight control is v1 parity and invalid quality controls are rejected", () => {
  const words = ["QI", "QUARTER"];
  const zero = makeQualityFaceCandidate(words, 0, 2);
  const frozen = new StrategyEngine(words, { capitalAllowance: true });
  for (const ctx of [context("UARTER"), context("QUARTR", "E"), context("A", "Z")]) {
    const result = zero.decide(ctx);
    const base = frozen.decide(ctx);
    expect(result.bid).toBe(base.bid);
    expect(result.word).toBe(base.word);
    expect(result.plan).toEqual(base.plan);
  }
  for (const weight of [-1, 0.5001, NaN, Infinity]) expect(() => makeQualityFaceCandidate(words, weight, 1)).toThrow(/finite/);
  expect(() => makeQualityFaceCandidate(words, 0.1, 3 as 1)).toThrow(/1 or 2/);
});
