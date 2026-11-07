import assert from "node:assert/strict";
import { test } from "node:test";
import { canSpell, DictionaryIndex, loadDictionary, rackToCounts, scoreWord } from "./dictionary.js";
import { RackOptimizer } from "./optimizer.js";
import { StrategyEngine, type StrategyContext } from "./strategy.js";

const rack = (letters: string): Map<string, number> => {
  const result = new Map<string, number>();
  for (const letter of letters) result.set(letter, (result.get(letter) ?? 0) + 1);
  return result;
};

function context(letters: string, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    myRack: rack(letters), myBalance: 100, letter: "", bagTotal: 40,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 3, ...overrides,
  };
}

function assertLegal(plan: readonly string[], letters: string, words: ReadonlySet<string>): number {
  const remaining = rack(letters);
  let score = 0;
  for (const word of plan) {
    assert.ok(words.has(word), `${word} is not in the dictionary`);
    assert.ok(canSpell(word, remaining), `${word} overdraws the rack`);
    for (const letter of word) remaining.set(letter, remaining.get(letter)! - 1);
    score += scoreWord(word);
  }
  return score;
}

test("scoring matches integer server multipliers and rejects malformed words", () => {
  assert.equal(scoreWord("AT"), 2);
  assert.equal(scoreWord("cat"), 5);
  assert.equal(scoreWord("CAGE"), 10);
  assert.equal(scoreWord("CARTED"), 22);
  assert.equal(scoreWord("READING"), 27);
  assert.equal(scoreWord("A"), 0);
  assert.equal(scoreWord("ÉTÉ"), 0);
  assert.equal(scoreWord("A-T"), 0);
});

test("dictionary canonicalizes anagrams while retaining legal membership and multiplicities", () => {
  const index = new DictionaryIndex(["tea", "EAT", "ATE", "AT", "TA", "TAT", "", "A", "A-T"]);
  assert.equal(index.entries.length, 3);
  assert.ok(index.words.has("TEA"));
  const counts = rackToCounts(rack("AET"));
  assert.deepEqual(index.playable(counts).entries.map(entry => entry.word).sort(), ["AT", "ATE"]);
  assert.deepEqual(counts, rackToCounts(rack("AET")));
  assert.equal(canSpell("TAT", rack("AT")), false);
  assert.equal(canSpell("TAT", rack("TAT")), true);
  assert.throws(() => new DictionaryIndex(["", "A"]), /no valid words/);
  assert.throws(() => loadDictionary(new URL("./__missing_wordlist__.txt", import.meta.url)));
  assert.throws(() => rackToCounts(new Map([["A", -1]])), /nonnegative/);
});

test("optimizer maximizes total partition reward instead of its best individual word", () => {
  const index = new DictionaryIndex(["AXE", "AX", "EL"]);
  const optimizer = new RackOptimizer(index);
  const result = optimizer.optimize(rackToCounts(rack("AXEL")));
  assert.equal(result.exact, true);
  assert.equal(result.score, 11);
  assert.deepEqual(result.words.sort(), ["AX", "EL"]);
  assert.equal(assertLegal(result.words, "AXEL", index.words), result.score);
});

test("optimizer supports repeated words, leftovers, cache isolation, and safe bounded fallback", () => {
  const index = new DictionaryIndex(["AT", "TA", "AXE", "AX", "EL"]);
  const optimizer = new RackOptimizer(index);
  const counts = rackToCounts(rack("ATATQ"));
  const result = optimizer.optimize(counts);
  assert.equal(result.score, 4);
  assert.deepEqual(result.words, ["AT", "AT"]);
  result.words.push("BAD");
  assert.deepEqual(optimizer.optimize(counts).words, ["AT", "AT"]);
  assert.deepEqual(counts, rackToCounts(rack("ATATQ")));
  const bounded = new RackOptimizer(index).optimize(rackToCounts(rack("AXEL")), {
    maxStates: 0, states: 0, deadlineMs: performance.now() + 1_000,
  });
  assert.equal(bounded.exact, false);
  assert.equal(assertLegal(bounded.words, "AXEL", index.words), bounded.score);
  assert.equal(bounded.score, 10);
  const interruptedOptimizer = new RackOptimizer(index);
  const interruptedCounts = rackToCounts(rack("AXELAT"));
  const interrupted = interruptedOptimizer.optimize(interruptedCounts, {
    maxStates: 2, states: 0, deadlineMs: performance.now() + 1_000,
  });
  assert.equal(interrupted.exact, false);
  assert.ok(interrupted.states <= 2);
  assert.equal(assertLegal(interrupted.words, "AXELAT", index.words), interrupted.score);
  assert.deepEqual(interruptedCounts, rackToCounts(rack("AXELAT")));
  assert.equal(interruptedOptimizer.optimize(interruptedCounts).score, 13);
  const expired = optimizer.optimize(rackToCounts(rack("QZ")), {
    maxStates: 10_000, states: 0, deadlineMs: performance.now() - 1,
  });
  assert.equal(expired.exact, false);
  assert.equal(expired.score, 0);
});

test("exact optimizer agrees with an independent exhaustive word-packing oracle", () => {
  const words = ["AT", "TO", "AX", "EL", "OX", "AXE", "CAT", "ACT", "CATS", "TACT", "COAT", "TOE"];
  const index = new DictionaryIndex(words);
  const optimizer = new RackOptimizer(index);
  const oracle = (letters: string, memo = new Map<string, number>()): number => {
    const key = [...letters].sort().join("");
    const known = memo.get(key);
    if (known !== undefined) return known;
    let best = 0;
    for (const word of words) {
      const remaining = [...key];
      let fits = true;
      for (const letter of word) {
        const at = remaining.indexOf(letter);
        if (at < 0) { fits = false; break; }
        remaining.splice(at, 1);
      }
      if (fits) best = Math.max(best, scoreWord(word) + oracle(remaining.join(""), memo));
    }
    memo.set(key, best);
    return best;
  };
  let seed = 7421;
  const alphabet = "AAACELLOTTXX";
  for (let sample = 0; sample < 150; sample++) {
    let letters = "";
    for (let i = 0; i < 4 + sample % 6; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      letters += alphabet[seed % alphabet.length];
    }
    const result = optimizer.optimize(rackToCounts(rack(letters)));
    assert.equal(result.exact, true);
    assert.equal(result.score, oracle(letters), letters);
    assert.equal(assertLegal(result.words, letters, index.words), result.score);
  }
});

test("core bidding buys completion options without using high face values indiscriminately", () => {
  const engine = new StrategyEngine(["CAT", "QUA"]);
  const offeredC = engine.decide(context("A", { letter: "C" }));
  assert.ok(offeredC.bid > 0, "one more future letter can complete CAT");
  const offeredQ = engine.decide(context("", { letter: "Q" }));
  assert.ok(offeredQ.bid > 0 && offeredQ.bid <= 3, "QUA missing U and A has discounted option value");
  assert.equal(engine.decide(context("", { letter: "Z" })).bid, 0);
  assert.equal(engine.decide(context("CCCA", { letter: "C" })).bid, 0, "new copy must be useful");
  const tinyBalance = engine.decide(context("CA", { letter: "T", myBalance: 2.8 }));
  assert.ok(Number.isInteger(tinyBalance.bid) && tinyBalance.bid <= 2);
  assert.equal(engine.decide(context("CA", { letter: "T", myBalance: 0 })).bid, 0);
  assert.equal(engine.decide(context("CA", { letter: "?" })).bid, 0);
});

test("bids use first-price shading, public price pacing, and terminal currency guards", () => {
  const engine = new StrategyEngine(["CAT"]);
  const normal = engine.decide(context("CA", { letter: "T" }));
  const first = engine.decide(context("CA", { letter: "T", auctionType: "FirstPrice" }));
  assert.equal(first.bid, Math.max(1, Math.floor(normal.bid * 0.8)));
  assert.ok(engine.decide(context("CA", { letter: "T", estimatedPrice: 20 })).bid < normal.bid);
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    assert.equal(engine.decide(context("CA", { letter: "T", bagTotal: 1, myBalance: 37, auctionType })).bid, 37);
    assert.equal(engine.decide(context("CA", { letter: "T", bagTotal: 0, auctionType })).bid, 0);
  }
});

test("heads-up face weight changes only eligible two-player Vickrey bids", () => {
  const index = new DictionaryIndex(["AT", "CAT", "HAT", "KITE", "QUA", "ZOO"]);
  const original = new StrategyEngine(index, { capitalAllowance: true });
  const configured = new StrategyEngine(index, { capitalAllowance: true, headsUpFaceBidWeight: 0.3 });
  const disabled = new StrategyEngine(index, { capitalAllowance: true, headsUpFaceBidWeight: 0 });
  for (const participantCount of [1, 2, 3, 6, NaN]) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      for (const bagTotal of [60, 1, 0]) {
        const snapshot = context("UA", { letter: "Q", participantCount, auctionType, bagTotal });
        const base = original.decide(snapshot);
        const result = configured.decide(snapshot);
        const expected = participantCount === 2 && auctionType === "Vickrey" && bagTotal > 1 && base.bid > 0
          ? Math.min(100, Math.ceil(base.bid * (1 + 0.3 * 9))) : base.bid;
        assert.equal(result.bid, expected);
        assert.equal(disabled.decide(snapshot).bid, base.bid);
        assert.equal(result.word, base.word);
        assert.deepEqual(result.plan, base.plan);
        assert.equal(result.cashout, base.cashout);
        assert.equal(result.exact, base.exact);
      }
    }
  }
});

test("heads-up weighting retains affordability, one-point bids, no-junk gating, and validated options", () => {
  const index = new DictionaryIndex(["AT", "CAT", "HAT", "KITE", "QUA", "ZOO"]);
  const original = new StrategyEngine(index, { capitalAllowance: true });
  const configured = new StrategyEngine(index, { capitalAllowance: true, headsUpFaceBidWeight: 0.5 });
  for (const myBalance of [100, 2.9, 0, -1, NaN]) {
    const snapshot = context("UA", { letter: "Q", participantCount: 2, myBalance });
    const result = configured.decide(snapshot);
    const limit = Number.isFinite(myBalance) ? Math.max(0, Math.floor(myBalance)) : 0;
    assert.ok(Number.isInteger(result.bid) && result.bid >= 0 && result.bid <= limit);
  }
  const onePoint = context("CT", { letter: "A", participantCount: 2 });
  assert.equal(configured.decide(onePoint).bid, original.decide(onePoint).bid);
  for (const letter of ["X", "?", "q"]) {
    assert.equal(configured.decide(context("A", { letter, participantCount: 2 })).bid, 0);
  }
  for (const weight of [-1, -0.01, 0.5001, NaN, Infinity, -Infinity]) {
    assert.throws(() => new StrategyEngine(index, { headsUpFaceBidWeight: weight }), /finite number between 0 and 0.5/);
  }
});

test("extra search progress without the offered tile never triggers a terminal all-in", () => {
  const engine = new StrategyEngine(["AXE", "AX", "EL"]);
  let calls = 0;
  engine.optimizer.optimize = () => ++calls === 1
    ? { score: 10, words: ["AXE"], exact: false, states: 0 }
    : { score: 11, words: ["AX", "EL"], exact: true, states: 0 };
  assert.equal(engine.decide(context("AXEL", { letter: "Q", bagTotal: 1 })).bid, 0);
});

test("capital allowance spends idle buying power on useful letters despite high market prices", () => {
  const index = new DictionaryIndex(["CAT"]);
  const core = new StrategyEngine(index);
  const variant = new StrategyEngine(index, { capitalAllowance: true });
  const expensive = context("A", { letter: "C", bagTotal: 60, estimatedPrice: 100 });
  assert.equal(core.decide(expensive).bid, 1);
  assert.equal(variant.decide(expensive).bid, 11);
  assert.equal(new StrategyEngine(index, { capitalAllowance: false }).decide(expensive).bid, 1);
  const firstPrice = variant.decide({ ...expensive, auctionType: "FirstPrice" });
  assert.equal(firstPrice.bid, 4, "half the allowance, followed by existing 0.8 shading");
  assert.equal(variant.decide({ ...expensive, letter: "Z" }).bid, 0, "capital cannot make an irrelevant tile useful");
  assert.equal(variant.decide({ ...expensive, myBalance: 0 }).bid, 0);
  assert.equal(variant.decide({ ...expensive, myBalance: 2.9 }).bid, 2);
  assert.equal(variant.decide(expensive).word, core.decide(expensive).word);
  const needsFutureTile = variant.decide({ ...expensive, bagTotal: 2 });
  assert.ok(needsFutureTile.bid > 0 && needsFutureTile.bid <= 35, "preserve funding to complete an option");
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    assert.equal(variant.decide(context("CA", { letter: "T", bagTotal: 1, myBalance: 37, auctionType })).bid, 37);
    assert.equal(variant.decide(context("CAT", { letter: "T", bagTotal: 0, auctionType })).bid, 0);
  }
});

test("word policy holds short words, releases maximum-bonus words, and liquidates under pressure", () => {
  const engine = new StrategyEngine(["CAT", "READING"]);
  assert.equal(engine.decide(context("CAT")).word, null);
  assert.equal(engine.decide(context("CAT", { myBalance: 11 })).word, "CAT");
  assert.equal(engine.decide(context("CAT", { bagTotal: 3 })).word, "CAT");
  assert.equal(engine.decide(context("CAT", { bagTotal: 0 })).word, "CAT");
  assert.equal(engine.decide(context("READING")).word, "READING");
  assert.equal(engine.decide(context("CATQQQQQQQQQ")).word, "CAT");
  const snapshot = context("READING", { letter: "S" });
  const before = [...snapshot.myRack];
  engine.decide(snapshot);
  assert.deepEqual([...snapshot.myRack], before);
});

test("full pinned dictionary produces legal decisions and bounds dense-rack search", t => {
  const words = loadDictionary();
  assert.equal(words.length, 172_820);
  const buildStart = performance.now();
  const engine = new StrategyEngine(words);
  t.diagnostic(`Indexed ${engine.dictionary.entries.length} signatures in ${Math.round(performance.now() - buildStart)}ms`);
  const elapsed: number[] = [];
  for (const letters of ["AEINRST", "AEINRSTOUL", "AEINRSTOULDD", "AEINRSTOULDDCEMAP", "BCDFGHJKLMNPQRSTVWXZ"]) {
    const result = engine.decide(context(letters, { letter: "E", bagTotal: 0 }));
    assert.equal(result.bid, 0);
    assert.equal(assertLegal(result.plan, letters, engine.dictionary.words), result.cashout);
    assert.ok(result.elapsedMs < 250, `dense rack search exceeded allowance: ${result.elapsedMs}ms`);
    elapsed.push(result.elapsedMs);
  }
  t.diagnostic(`Cashout decision milliseconds: ${elapsed.map(value => value.toFixed(1)).join(", ")}`);
  const bidElapsed: number[] = [];
  for (const letters of ["AEINRST", "AEINRSTOUL", "AEINRSTOULDD", "AEINRSTOULDDCEMAP"]) {
    const result = engine.decide(context(letters, { letter: "E" }));
    assert.ok(Number.isInteger(result.bid) && result.bid >= 0 && result.bid <= 100);
    assert.equal(assertLegal(result.plan, letters, engine.dictionary.words), result.cashout);
    assert.ok(result.elapsedMs < 250, `full evaluation exceeded allowance: ${result.elapsedMs}ms`);
    bidElapsed.push(result.elapsedMs);
  }
  t.diagnostic(`Full bid decision milliseconds: ${bidElapsed.map(value => value.toFixed(1)).join(", ")}`);
});
