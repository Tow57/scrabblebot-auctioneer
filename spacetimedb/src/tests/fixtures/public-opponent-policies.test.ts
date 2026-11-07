import assert from "node:assert/strict";
import { test } from "vitest";
import { DictionaryIndex, canSpell } from "./v1/dictionary";
import type { StrategyContext } from "./v1/strategy";
import { makeScaledV1 } from "./opponent-policies";
import { makePublicFormulaOpponent, publishedLinearFaceFloor, publishedPremiumFloor } from "./public-opponent-policies";

function rack(letters: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
}
function context(letters: string, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return { myRack: rack(letters), myBalance: 100, letter: "T", bagTotal: 68,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 8, ...overrides };
}

test("premium published floors distinguish anchors, vowels, and common connectors", () => {
  assert.equal(publishedPremiumFloor(context("AN", { letter: "Q" })), 28);
  assert.equal(publishedPremiumFloor(context("AN", { letter: "H" })), 16);
  assert.equal(publishedPremiumFloor(context("AN", { letter: "E" })), 23);
  assert.equal(publishedPremiumFloor(context("AN", { letter: "T" })), 10);
  assert.equal(publishedPremiumFloor(context("QQ", { letter: "Q" })), 14);
  assert.equal(publishedPremiumFloor(context("AN", { letter: "Q", bagTotal: 10 })), 22);
  assert.equal(publishedPremiumFloor(context("AN", { letter: "Q", auctionType: "FirstPrice" })), 22);
});

test("linear face floor retains balance, duplication, Q/U, and first-price guards", () => {
  assert.equal(publishedLinearFaceFloor(context("AN", { letter: "K" })), 14);
  assert.equal(publishedLinearFaceFloor(context("AN", { letter: "Q" })), 1);
  assert.equal(publishedLinearFaceFloor(context("IN", { letter: "Q" })), 1, "I does not make QI legal");
  assert.equal(publishedLinearFaceFloor(context("UN", { letter: "Q" })), 22);
  assert.equal(publishedLinearFaceFloor(context("AEN", { letter: "E" })), 4);
  assert.equal(publishedLinearFaceFloor(context("AN", { letter: "K", auctionType: "FirstPrice", estimatedPrice: 8 })), 9);
});

test("formula helpers never invent invalid, unaffordable, or terminal purchases", () => {
  for (const helper of [publishedPremiumFloor, publishedLinearFaceFloor]) {
    for (const balance of [0, 1, 2.9, 5, 17, 100]) {
      for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
        const bid = helper(context("AN", { letter: "Z", myBalance: balance, auctionType }));
        assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= Math.floor(balance));
      }
    }
    assert.equal(helper(context("AN", { letter: "?" })), 0);
    assert.equal(helper(context("AN", { bagTotal: 0 })), 0);
    assert.equal(helper(context("AN", { bagTotal: 1 })), 0);
  }
});

test("stress wrappers preserve frozen legal words, base bids, and final-auction behavior", () => {
  const dictionary = new DictionaryIndex(["AT", "CAT", "CATS", "READING", "QUA"]);
  for (const kind of ["premium-floor", "linear-face"] as const) {
    const policy = makePublicFormulaOpponent(kind, dictionary);
    const base = makeScaledV1(1, dictionary);
    for (const letters of ["CA", "CAT", "READING", "UA", "AXEL"]) {
      const snapshot = context(letters, { letter: "T" });
      const before = [...snapshot.myRack];
      const original = base.decide(snapshot);
      const result = policy.decide(snapshot);
      assert.equal(result.word, original.word);
      assert.ok(result.bid >= original.bid && result.bid <= 100 && Number.isInteger(result.bid));
      assert.deepEqual([...snapshot.myRack], before);
      if (result.word) assert.ok(canSpell(result.word, snapshot.myRack));
    }
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      assert.equal(policy.decide(context("CA", { letter: "T", bagTotal: 1, myBalance: 37, auctionType })).bid, 37);
      const last = policy.decide(context("CAT", { bagTotal: 0, auctionType }));
      assert.equal(last.bid, 0);
      assert.equal(last.word, "CAT");
    }
  }
});
