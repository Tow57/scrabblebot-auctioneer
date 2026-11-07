import assert from "node:assert/strict";
import { test } from "vitest";
import { canSpell, DictionaryIndex, loadDictionary, rackToCounts, scoreWord } from "../../../../bot-starter/src/dictionary.js";
import { StrategyEngine, type StrategyContext } from "../../../../bot-starter/src/strategy.js";
import { conservativeMarginal, futureAcquisitions, makeRolloutCandidate, sampleCommonFutures } from "./rollout-candidate.js";

function rack(letters: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const letter of letters) result.set(letter, (result.get(letter) ?? 0) + 1);
  return result;
}

function context(letters: string, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    myRack: rack(letters), myBalance: 100, letter: "T", bagTotal: 60,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 3, ...overrides,
  };
}

test("horizon and conservative estimate have explicit mathematical bounds", () => {
  assert.equal(futureAcquisitions(5, 60, 6), 3);
  assert.equal(futureAcquisitions(8, 60, 6), 1);
  assert.equal(futureAcquisitions(9, 60, 6), 0);
  assert.equal(futureAcquisitions(5, 6, 6), 0);
  assert.equal(futureAcquisitions(5, 7, 6), 1);
  assert.deepEqual(conservativeMarginal([0, 0, 0, 8]), { mean: 2, se: 2, value: 1 });
  assert.deepEqual(conservativeMarginal([2, 2, 2]), { mean: 2, se: 0, value: 2 });
  assert.deepEqual(conservativeMarginal([]), { mean: 0, se: 0, value: 0 });
});

test("common future draws are deterministic, without replacement, and respect known tiles", () => {
  const held = rackToCounts(rack("EEEEEEEEEEEE"));
  const before = held.slice();
  const futures = sampleCommonFutures(held, "Q".charCodeAt(0) - 65, 3, 16, "fixed");
  assert.deepEqual(futures, sampleCommonFutures(held, "Q".charCodeAt(0) - 65, 3, 16, "fixed"));
  assert.deepEqual(held, before);
  for (const future of futures) {
    assert.equal(future.reduce((sum, count) => sum + count, 0), 3);
    assert.equal(future["E".charCodeAt(0) - 65], 0);
    assert.equal(future["Q".charCodeAt(0) - 65], 0);
    for (const letter of ["J", "K", "X", "Z"]) assert.ok(future[letter.charCodeAt(0) - 65] <= 1);
  }
});

test("wrapper never lowers its core bid, preserves word policy, and does not mutate snapshots", () => {
  const index = new DictionaryIndex(["AT", "TO", "CAT", "CATS", "AX", "EL", "TRAIN", "RETAIN", "READING", "QUA"]);
  const candidate = makeRolloutCandidate(index);
  const core = new StrategyEngine(index, { capitalAllowance: true });
  let seed = 19;
  for (let sample = 0; sample < 80; sample++) {
    let letters = "";
    for (let tile = 0; tile < 2 + sample % 7; tile++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      letters += "AAACEILNORTU"[seed % 12];
    }
    const snapshot = context(letters, {
      myBalance: sample % 11 === 0 ? 0 : 5 + sample,
      auctionType: sample % 2 ? "Vickrey" : "FirstPrice",
    });
    const before = [...snapshot.myRack];
    const base = core.decide(snapshot);
    const result = candidate.decide(snapshot);
    assert.ok(result.bid >= result.baseBid && result.bid >= base.bid);
    assert.ok(Number.isInteger(result.bid) && result.bid >= 0 && result.bid <= Math.floor(snapshot.myBalance));
    assert.equal(result.word, base.word);
    assert.deepEqual([...snapshot.myRack], before);
    assert.ok(result.searchStates <= 10_000);
    const remaining = new Map(snapshot.myRack);
    let score = 0;
    for (const word of result.plan) {
      assert.ok(index.words.has(word) && canSpell(word, remaining));
      score += scoreWord(word);
      for (const letter of word) remaining.set(letter, remaining.get(letter)! - 1);
    }
    assert.equal(score, result.cashout);
  }
});

test("terminal auctions, turnover, horizon caps, and expired deadlines retain the base decision", () => {
  const candidate = makeRolloutCandidate(new DictionaryIndex(["AT", "CAT", "READING"]));
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    const final = candidate.decide(context("CAT", { bagTotal: 0, auctionType }));
    assert.equal(final.bid, 0);
    assert.equal(final.word, "CAT");
    assert.equal(final.rolloutUsed, false);
    const penultimate = candidate.decide(context("CA", { bagTotal: 1, myBalance: 37, auctionType }));
    assert.equal(penultimate.bid, 37);
    assert.equal(penultimate.rolloutUsed, false);
  }
  const turnover = candidate.decide(context("READING"));
  assert.equal(turnover.word, "READING");
  assert.equal(turnover.rolloutUsed, false);
  assert.equal(candidate.decide(context("AAAAAAAAA")).rolloutUsed, false);
  const expired = candidate.decide(context("CA", { deadlineMs: performance.now() - 1 }));
  assert.equal(expired.rolloutUsed, false);
  assert.equal(expired.bid, expired.baseBid);
});

test("small exact samples are reproducible across independent candidates", () => {
  const index = new DictionaryIndex(["AT", "CAT", "CATS", "QUA", "TRAIN", "RETAIN"]);
  const first = makeRolloutCandidate(index).decide(context("CA"));
  const second = makeRolloutCandidate(index).decide(context("CA"));
  assert.equal(first.rolloutUsed, true);
  assert.equal(first.rolloutSamples, 16);
  assert.equal(first.bid, second.bid);
  assert.equal(first.rolloutMean, second.rolloutMean);
  assert.equal(first.rolloutSE, second.rolloutSE);
});

test("factory accepts an index crossing a distinct loader class identity", () => {
  const externalIndex = { words: new Set(["AT", "CAT"]) } as unknown as DictionaryIndex;
  const result = makeRolloutCandidate(externalIndex).decide(context("CA", { bagTotal: 1, myBalance: 37 }));
  assert.equal(result.bid, 37);
  assert.equal(result.rolloutUsed, false);
});

test("full-dictionary experiment reports exact batches or safe fallback within the shared deadline", () => {
  const candidate = makeRolloutCandidate(new DictionaryIndex(loadDictionary()));
  for (const letters of ["AEINR", "AELORSTU", "AAEINRT", "AEINRSTOULDDCEMAP"]) {
    const result = candidate.decide(context(letters, { letter: "T", estimatedPrice: 8 }));
    assert.ok(result.rolloutSamples === 0 || result.rolloutSamples === 8 || result.rolloutSamples === 16);
    assert.ok(result.bid >= result.baseBid && result.bid <= 100 && Number.isInteger(result.bid));
    assert.ok(result.searchStates <= 10_000);
    assert.ok(result.elapsedMs < 200, `wall-time allowance exceeded: ${result.elapsedMs}ms`);
    console.info(`${letters}: used=${result.rolloutUsed}, samples=${result.rolloutSamples}, base=${result.baseBid}, bid=${result.bid}, states=${result.searchStates}, ${result.elapsedMs.toFixed(1)}ms`);
  }
});
