import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { canSpell, DictionaryIndex, rackToCounts, scoreWord, type DictionaryEntry } from "./dictionary.js";
import { RackOptimizer } from "./optimizer.js";
import { StrategyEngine, type StrategyContext } from "./strategy.js";

const rack = (letters: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
};
const budget = (deadlineMs = Infinity) => ({ deadlineMs, maxStates: 10_000, states: 0 });
function legal(plan: { score: number; words: string[] }, letters: string, words: ReadonlySet<string>) {
  const remaining = rack(letters);
  for (const word of plan.words) {
    assert.ok(words.has(word) && canSpell(word, remaining), "each word must be legal on the remaining rack");
    for (const letter of word) remaining.set(letter, remaining.get(letter)! - 1);
  }
  assert.equal(plan.score, plan.words.reduce((sum, word) => sum + scoreWord(word), 0));
}
function withClock(run: (clock: { now: number }) => void) {
  const clock = { now: 0 };
  const mocked = mock.method(performance, "now", () => clock.now);
  try { run(clock); }
  finally { mocked.mock.restore(); }
}

test("partial traversal preserves its best legal word without starting a sort or poisoning the cache", { concurrency: false }, () => withClock(clock => {
  const dictionary = new DictionaryIndex(["AT", "CATS"]);
  const playable = dictionary.playable.bind(dictionary);
  dictionary.playable = counts => {
    const found = playable(counts, Infinity);
    found.entries.sort = () => { throw new Error("sort must not start after partial traversal expires"); };
    found.complete = false;
    clock.now = 11;
    return found;
  };
  const optimizer = new RackOptimizer(dictionary);
  const counts = rackToCounts(rack("CATS")), before = [...counts];
  try {
    const partial = optimizer.optimize(counts, budget(10));
    assert.equal(partial.exact, false); assert.equal(partial.states, 0);
    assert.deepEqual(partial.words, ["CATS"]); legal(partial, "CATS", dictionary.words);
    assert.deepEqual([...counts], before);
  } finally { dictionary.playable = playable; }
  clock.now = 0;
  const exact = optimizer.optimize(counts, budget());
  assert.equal(exact.exact, true); assert.equal(exact.score, scoreWord("CATS"));
}));

test("sort interruption retains a legal seed and never caches partial setup as exact", { concurrency: false }, () => withClock(clock => {
  const dictionary = new DictionaryIndex(["AT"]);
  const playable = dictionary.playable.bind(dictionary);
  const entry = dictionary.entries[0]!;
  const entries = Array<DictionaryEntry>(64).fill(entry);
  let comparisons = 0;
  entries.sort = compare => Array.prototype.sort.call(entries, (a, b) => {
    comparisons++;
    const result = compare!(a, b);
    if (comparisons === 1) clock.now = 11;
    return result;
  });
  dictionary.playable = () => ({ entries, complete: true, best: entry });
  const optimizer = new RackOptimizer(dictionary);
  const counts = rackToCounts(rack("ATAT")), before = [...counts];
  try {
    const partial = optimizer.optimize(counts, budget(10));
    assert.ok(comparisons > 1 && comparisons <= 33, "a checkpoint must interrupt comparator work");
    assert.equal(partial.exact, false); assert.equal(partial.states, 0);
    legal(partial, "ATAT", dictionary.words); assert.deepEqual([...counts], before);
  } finally { dictionary.playable = playable; }
  clock.now = 0;
  const exact = optimizer.optimize(counts, budget());
  assert.equal(exact.exact, true); assert.equal(exact.score, 4);
}));

test("greedy interruption keeps a completed disjoint prefix and leaves later exact search usable", { concurrency: false }, () => withClock(clock => {
  const dictionary = new DictionaryIndex(["AT"]);
  const playable = dictionary.playable.bind(dictionary);
  const original = dictionary.entries[0]!;
  const tiles = original.tiles.map(pair => [...pair] as [number, number]);
  const iterator = tiles[Symbol.iterator];
  tiles[Symbol.iterator] = function* () { yield* iterator.call(this); clock.now = 11; return undefined; };
  const entry = { ...original, tiles };
  dictionary.playable = () => ({ entries: [entry], complete: true, best: entry });
  const optimizer = new RackOptimizer(dictionary);
  const counts = rackToCounts(rack("ATAT")), before = [...counts];
  try {
    const partial = optimizer.optimize(counts, budget(10));
    assert.equal(partial.exact, false); assert.equal(partial.states, 0);
    assert.deepEqual(partial.words, ["AT"]); assert.equal(partial.score, 2);
    legal(partial, "ATAT", dictionary.words); assert.deepEqual([...counts], before);
  } finally { tiles[Symbol.iterator] = iterator; dictionary.playable = playable; }
  clock.now = 0;
  const exact = optimizer.optimize(counts, budget());
  assert.equal(exact.exact, true); assert.equal(exact.score, 4);
}));

test("group interruption returns the full greedy incumbent without using partial groups as exact", { concurrency: false }, () => withClock(clock => {
  const dictionary = new DictionaryIndex(["AT"]);
  const playable = dictionary.playable.bind(dictionary);
  const original = dictionary.entries[0]!;
  const tiles = original.tiles.map(pair => [...pair] as [number, number]);
  const iterator = tiles[Symbol.iterator];
  let tileIterations = 0;
  tiles[Symbol.iterator] = function* () {
    yield* iterator.call(this);
    if (++tileIterations === 3) clock.now = 11; // Two greedy uses, then first group.
    return undefined;
  };
  const entry = { ...original, tiles };
  dictionary.playable = () => ({ entries: Array<DictionaryEntry>(64).fill(entry), complete: true, best: entry });
  const optimizer = new RackOptimizer(dictionary);
  const counts = rackToCounts(rack("ATAT")), before = [...counts];
  try {
    const partial = optimizer.optimize(counts, budget(10));
    assert.ok(tileIterations >= 3 && tileIterations <= 34, "grouping must stop at a time checkpoint");
    assert.equal(partial.exact, false); assert.equal(partial.states, 0);
    assert.deepEqual(partial.words, ["AT", "AT"]); assert.equal(partial.score, 4);
    legal(partial, "ATAT", dictionary.words); assert.deepEqual([...counts], before);
  } finally { tiles[Symbol.iterator] = iterator; dictionary.playable = playable; }
  clock.now = 0;
  const exact = optimizer.optimize(counts, budget());
  assert.equal(exact.exact, true); assert.equal(exact.score, 4);
}));

test("exhausted shared DP states retain greedy word cashout and the final usable purchase gain", { concurrency: false }, () => {
  const dictionary = new DictionaryIndex(["AXE", "AX", "EL"]);
  const optimizer = new RackOptimizer(dictionary);
  const counts = rackToCounts(rack("AXEL"));
  const partial = optimizer.optimize(counts, { ...budget(), states: 10_000 });
  assert.equal(partial.exact, false); assert.equal(partial.states, 0); assert.equal(partial.score, 10);
  legal(partial, "AXEL", dictionary.words);
  const exact = optimizer.optimize(counts, budget());
  assert.equal(exact.exact, true); assert.equal(exact.score, 11);

  const engine = new StrategyEngine(dictionary, { capitalAllowance: true, wordFirst: true });
  const optimize = engine.optimizer.optimize.bind(engine.optimizer);
  engine.optimizer.optimize = (available, supplied) => {
    supplied!.states = supplied!.maxStates;
    return optimize(available, supplied);
  };
  const ctx: StrategyContext = { myRack: rack("AEL"), myBalance: 37, letter: "X", bagTotal: 1,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 8 };
  const cashout = engine.decide(ctx);
  assert.equal(cashout.word, "EL"); assert.equal(cashout.bid, 0); assert.equal(cashout.exact, false);
  const fresh = engine.decide({ ...ctx, myRack: rack("A"), myBalance: 39 });
  assert.equal(fresh.word, null); assert.equal(fresh.bid, 39);
});

test("common95ms completion deadline retains40/85ms stages and tighter caller deadlines", { concurrency: false }, () => withClock(clock => {
  clock.now = 1000;
  for (const callerDeadline of [Infinity, 1030]) {
    const dictionary = new DictionaryIndex(["AT", "QAT"]);
    const engine = new StrategyEngine(dictionary, { capitalAllowance: true, headsUpFaceBidWeight: 0.3, wordFirst: true });
    const calls: { identity: object; deadline: number; maximum: number }[] = [];
    engine.optimizer.optimize = (_counts, supplied) => {
      calls.push({ identity: supplied!, deadline: supplied!.deadlineMs, maximum: supplied!.maxStates });
      return { score: 0, words: [], exact: true, states: 0 };
    };
    let completionDeadline: number | undefined;
    dictionary.completionValue = (_counts, _letter, _missing, deadline) => { completionDeadline = deadline; return 0; };
    engine.decide({ myRack: rack("AT"), myBalance: 100, letter: "Q", bagTotal: 60, participantCount: 6,
      auctionType: "Vickrey", estimatedPrice: 8, deadlineMs: callerDeadline });
    assert.equal(calls.length, 2); assert.equal(calls[0]!.identity, calls[1]!.identity);
    assert.equal(calls[0]!.maximum, 10_000); assert.equal(calls[1]!.maximum, 10_000);
    assert.equal(calls[0]!.deadline, Math.min(1040, callerDeadline));
    assert.equal(calls[1]!.deadline, Math.min(1085, callerDeadline));
    assert.equal(completionDeadline, Math.min(1095, callerDeadline));
  }
}));

test("word-first still finishes after only the current40ms stage", { concurrency: false }, () => withClock(clock => {
  clock.now = 1000;
  const dictionary = new DictionaryIndex(["AT"]);
  const engine = new StrategyEngine(dictionary, { capitalAllowance: true, headsUpFaceBidWeight: 0.3, wordFirst: true });
  let calls = 0;
  engine.optimizer.optimize = (_counts, supplied) => {
    calls++; assert.equal(supplied!.deadlineMs, 1040);
    return { score: 2, words: ["AT"], exact: false, states: 0 };
  };
  dictionary.completionValue = () => { throw new Error("cashout must not perform completion search"); };
  const result = engine.decide({ myRack: rack("AT"), myBalance: 5, letter: "Q", bagTotal: 60,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 8 });
  assert.equal(calls, 1); assert.equal(result.word, "AT"); assert.equal(result.bid, 0); assert.equal(result.exact, false);
}));
