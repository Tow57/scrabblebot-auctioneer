import assert from "node:assert/strict";
import { test } from "node:test";
import { StrategyWorker } from "./worker-client.js";
import type { MatchSnapshot } from "./client.js";

const snapshot = (): MatchSnapshot => ({ matchId: 9007199254740993n, auctionId: 9007199254740995n, letter: "S", myBalance: 5,
  score: 0, myRack: new Map([["C", 1], ["A", 1], ["T", 1]]), bagTotal: 10, participantCount: 6,
  auctionType: "Vickrey", closesAtMs: Date.now() + 5000, estimatedPrice: 3 });

test("native mjs worker initializes tsx, loads the official dictionary, and preserves bigint IDs", async t => {
  const worker = new StrategyWorker();
  t.after(() => worker.stop());
  await worker.start();
  const decision = await worker.evaluate(snapshot());
  assert.ok(decision, "small-rack computation must finish inside the 150ms worker deadline");
  assert.ok(["ACT", "CAT", "AT", "TA"].includes(decision.word ?? ""));
  assert.ok(Number.isInteger(decision.bid) && decision.bid >= 0 && decision.bid <= 5);
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
