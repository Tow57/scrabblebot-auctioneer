import assert from "node:assert/strict";
import { test } from "node:test";
import { StrategyWorker } from "./worker-client.js";
import type { MatchSnapshot } from "./client.js";
import { DictionaryIndex, LETTER_VALUE, loadDictionary } from "./dictionary.js";
import { StrategyEngine } from "./strategy.js";

const snapshot = (): MatchSnapshot => ({ matchId: 9007199254740993n, auctionId: 9007199254740995n, letter: "S", myBalance: 5,
  score: 0, myRack: new Map([["C", 1], ["A", 1], ["T", 1]]), bagTotal: 10, participantCount: 6,
  auctionType: "Vickrey", closesAtMs: Date.now() + 5000, estimatedPrice: 3 });

let officialIndex: DictionaryIndex | undefined;
const dictionary = () => officialIndex ??= new DictionaryIndex(loadDictionary());
const rack = (letters: string) => {
  const counts = new Map<string, number>();
  for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
};
async function withPolicyEnvironment(
  settings: { weight?: string; multiway?: string; capital?: string }, run: () => Promise<void>,
): Promise<void> {
  const names = ["BOT_HEADS_UP_FACE_WEIGHT", "BOT_MULTIWAY_FACE_WEIGHT", "BOT_CAPITAL_ALLOWANCE"] as const;
  const previous = names.map(name => process.env[name]);
  for (const [index, value] of [settings.weight, settings.multiway, settings.capital].entries()) {
    if (value === undefined) delete process.env[names[index]];
    else process.env[names[index]] = value;
  }
  try { await run(); }
  finally {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
}

test("native mjs worker initializes tsx, loads the official dictionary, and preserves bigint IDs", async t => {
  const worker = new StrategyWorker();
  t.after(() => worker.stop());
  await worker.start();
  const decision = await worker.evaluate(snapshot());
  assert.ok(decision, "small-rack computation must finish inside the 150ms worker deadline");
  assert.ok(["ACT", "CAT", "AT", "TA"].includes(decision.word ?? ""));
  const rawLibrary = new StrategyEngine(dictionary(), { capitalAllowance: true }).decide(snapshot());
  assert.ok(rawLibrary.word && rawLibrary.bid > 0, "legacy library retains its bid on the old rack");
  assert.equal(decision.bid, 0, "the word-first worker does not return that obsolete positive bid");
  assert.equal(decision.word, rawLibrary.word);
  assert.deepEqual(decision.plan, rawLibrary.plan);
});

test("queued snapshots are bounded to the newest pending request", async t => {
  const worker = new StrategyWorker();
  t.after(() => worker.stop());
  await worker.start();
  const jobs = Array.from({ length: 12 }, (_, index) => worker.evaluate({ ...snapshot(), auctionId: BigInt(index + 1) }));
  const decisions = await Promise.all(jobs);
  assert.ok(decisions.slice(1, -1).every(value => value === null));
  assert.ok(decisions.filter(Boolean).length <= 2);
  const metrics = worker.stats();
  assert.equal(metrics.requested, 12);
  assert.equal(metrics.completed + metrics.activeTimeouts + metrics.queuedTimeouts + metrics.superseded, 12);
  assert.equal(metrics.superseded, 10);
});

test("a missing dictionary fails startup with an actionable error", async t => {
  const worker = new StrategyWorker("C:/scrabblebot-missing-fixture/does-not-exist.txt");
  t.after(() => worker.stop());
  await assert.rejects(worker.start(), /dictionary|worker/i);
});

test("hard job deadline returns fallback instead of blocking the parent", async t => {
  const worker = new StrategyWorker(undefined, 1);
  t.after(() => worker.stop());
  await worker.start();
  const started = performance.now();
  const decision = await worker.evaluate({ ...snapshot(), myRack: new Map([..."AEINRSTBCDFGHLMOP"].map(c => [c, 1])) });
  assert.equal(decision, null);
  assert.equal(worker.stats().activeTimeouts, 1);
  assert.ok(performance.now() - started < 100, "parent did not promptly receive the timeout");
});

test("native worker uses separate heads-up and multiway defaults with format and terminal guards", async t => {
  await withPolicyEnvironment({}, async () => {
    const worker = new StrategyWorker();
    const original = new StrategyEngine(dictionary(), { capitalAllowance: true });
    const configured = new StrategyEngine(dictionary(), { capitalAllowance: true, headsUpFaceBidWeight: 0.3, multiwayFaceBidWeight: 0.1, wordFirst: true });
    try {
      await worker.start();
      const latencies: number[] = [];
      for (const [letters, letter] of [["AT", "H"], ["ITE", "K"], ["UA", "Q"], ["OO", "Z"], ["AE", "X"]]) {
        const current: MatchSnapshot = { ...snapshot(), myRack: rack(letters), letter, myBalance: 100,
          participantCount: 2, bagTotal: 60 };
        const base = original.decide(current);
        const decision = await worker.evaluate(current);
        assert.ok(decision, "native heads-up response must arrive inside the 150ms worker budget");
        assert.ok(base.bid > 0);
        assert.equal(base.word, null, "formula cases exercise bidding rather than a pending cashout");
        assert.equal(decision.bid, Math.min(100, Math.ceil(base.bid * (1 + 0.3 * (LETTER_VALUE[letter] - 1)))));
        assert.equal(decision.word, base.word);
        assert.deepEqual(decision.plan, base.plan);
        assert.ok(decision.roundTripMs! < 150);
        latencies.push(decision.roundTripMs!);
      }
      for (const extra of [
        { participantCount: 6, auctionType: "Vickrey" as const, bagTotal: 60 },
        { participantCount: 2, auctionType: "FirstPrice" as const, bagTotal: 60 },
        { participantCount: 2, auctionType: "Vickrey" as const, bagTotal: 1 },
        { participantCount: 2, auctionType: "Vickrey" as const, bagTotal: 0 },
      ]) {
        const current = { ...snapshot(), myRack: rack("UA"), letter: "Q", myBalance: 37, ...extra };
        const base = original.decide(current);
        const decision = await worker.evaluate(current);
        assert.ok(decision);
        assert.equal(decision.bid, configured.decide(current).bid, "worker uses the separate multiway default and keeps terminal/FirstPrice guards");
        assert.equal(decision.word, base.word);
      }
      assert.equal(worker.stats().activeTimeouts, 0);
      t.diagnostic(`Native heads-up round trips: ${latencies.map(value => value.toFixed(1)).join(", ")}ms`);
    } finally { worker.stop(); }
  });
});

test("worker weight opt-out, valid override, and capital-policy opt-out retain their contracts", async () => {
  for (const settings of [{ weight: "0" }, { weight: "0.5" }, { weight: "0.5", capital: "0" }]) {
    await withPolicyEnvironment(settings, async () => {
      const worker = new StrategyWorker();
      const capitalAllowance = settings.capital !== "0";
      const expected = new StrategyEngine(dictionary(), {
        capitalAllowance, headsUpFaceBidWeight: capitalAllowance ? Number(settings.weight) : 0,
        multiwayFaceBidWeight: capitalAllowance ? 0.1 : 0, wordFirst: true,
      });
      try {
        await worker.start();
        const current = { ...snapshot(), myRack: rack("UA"), letter: "Q", myBalance: 100, participantCount: 2, bagTotal: 60 };
        const decision = await worker.evaluate(current);
        assert.ok(decision);
        assert.equal(decision.bid, expected.decide(current).bid);
      } finally { worker.stop(); }
    });
  }
});

test("invalid heads-up weights reject native worker startup with an actionable message", async () => {
  for (const weight of ["-0.01", "0.5001", "NaN", "Infinity", "", "not-a-number"]) {
    await withPolicyEnvironment({ weight }, async () => {
      const worker = new StrategyWorker();
      try { await assert.rejects(worker.start(), /BOT_HEADS_UP_FACE_WEIGHT.*finite number between 0 and 0.5/); }
      finally { worker.stop(); }
    });
  }
});

test("native worker multiway default, opt-out, override and capital opt-out preserve bigint IDs and guarded formats", async () => {
  for (const settings of [{}, { multiway: "0" }, { multiway: "0.5" }, { weight: "0.5", multiway: "0.5", capital: "0" }]) {
    await withPolicyEnvironment(settings, async () => {
      const worker = new StrategyWorker();
      const capitalAllowance = settings.capital !== "0";
      const expected = new StrategyEngine(dictionary(), {
        capitalAllowance, headsUpFaceBidWeight: capitalAllowance ? Number(settings.weight ?? "0.3") : 0,
        multiwayFaceBidWeight: capitalAllowance ? Number(settings.multiway ?? "0.1") : 0, wordFirst: true,
      });
      try {
        await worker.start();
        const cases = [
          { participantCount: 2, auctionType: "Vickrey" as const, bagTotal: 60 },
          { participantCount: 3, auctionType: "Vickrey" as const, bagTotal: 60 },
          { participantCount: 6, auctionType: "Vickrey" as const, bagTotal: 60 },
          { participantCount: 6, auctionType: "FirstPrice" as const, bagTotal: 60 },
          { participantCount: 6, auctionType: "Vickrey" as const, bagTotal: 1 },
          { participantCount: 6, auctionType: "Vickrey" as const, bagTotal: 0 },
        ];
        for (const [i, extra] of cases.entries()) {
          const current = { ...snapshot(), auctionId: snapshot().auctionId! + BigInt(i), myRack: rack("UA"), letter: "Q", myBalance: 100, ...extra };
          const decision = await worker.evaluate(current);
          assert.ok(decision, "each response must match its bigint match/auction IDs and arrive within the existing worker budget");
          assert.equal(decision.bid, expected.decide(current).bid);
          assert.ok(Number.isInteger(decision.bid) && decision.bid >= 0 && decision.bid <= current.myBalance);
        }
        const cashout = { ...snapshot(), auctionId: 9007199254741009n, participantCount: 6 };
        const word = await worker.evaluate(cashout);
        assert.ok(word?.word); assert.equal(word.bid, 0);
        assert.equal(worker.stats().activeTimeouts, 0);
      } finally { worker.stop(); }
    });
  }
});

test("invalid multiway weights fail native startup before any gameplay", async () => {
  for (const multiway of ["-0.01", "0.5001", "NaN", "Infinity", "", "not-a-number"]) {
    await withPolicyEnvironment({ multiway }, async () => {
      const worker = new StrategyWorker();
      try { await assert.rejects(worker.start(), /BOT_MULTIWAY_FACE_WEIGHT.*finite number between 0 and 0.5/); }
      finally { worker.stop(); }
    });
  }
});
