import assert from "node:assert/strict";
import { test } from "node:test";
import { AuctionClock, BotController, estimatePrice, fallbackBid, indexRows, parseTournamentId, type Decision, type MatchSnapshot } from "./client.js";

const rack = (letters: string) => {
  const result = new Map<string, number>();
  for (const letter of letters) result.set(letter, (result.get(letter) ?? 0) + 1);
  return result;
};
const snapshot = (): MatchSnapshot => ({ matchId: 1n, auctionId: 2n, letter: "E", myBalance: 100, score: 0,
  myRack: rack("CATDOG"), bagTotal: 20, participantCount: 6, auctionType: "Vickrey", closesAtMs: 10_000, estimatedPrice: 3 });
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("key index tracks SDK row updates/deletes and rebuilds after a missed replay event", () => {
  type Row = { id: bigint; status: string };
  let current: Row[] = [{ id: 1n, status: "Running" }, { id: 2n, status: "Ended" }];
  let insert!: (ctx: unknown, row: Row) => void;
  let update!: (ctx: unknown, old: Row, row: Row) => void;
  let remove!: (ctx: unknown, row: Row) => void;
  let changed = 0;
  const index = indexRows({ iter: () => current,
    onInsert: cb => { insert = cb; }, onUpdate: cb => { update = cb; }, onDelete: cb => { remove = cb; } }, () => changed++);
  index.rebuild();
  assert.equal(index.rows.get(1n)?.status, "Running");
  update({}, current[0]!, { id: 1n, status: "Ended" });
  insert({}, { id: 3n, status: "Running" });
  remove({}, current[1]!);
  assert.equal(index.rows.get(1n)?.status, "Ended");
  assert.equal(index.rows.has(2n), false);
  assert.equal(index.rows.get(3n)?.status, "Running");
  assert.equal(changed, 3);
  current = [{ id: 4n, status: "Running" }]; // Reconnected snapshot omitted old rows.
  index.rebuild();
  assert.deepEqual([...index.rows.keys()], [4n]);
});

test("43k historical matches are scanned once, never during repeated keyed lookups", () => {
  const rows = Array.from({ length: 43_000 }, (_, i) => ({ id: BigInt(i + 1), status: i === 42_999 ? "Running" : "Ended" }));
  let reads = 0;
  const index = indexRows({
    *iter() { for (const row of rows) { reads++; yield row; } },
    onInsert: () => {}, onUpdate: () => {}, onDelete: () => {},
  }, () => {});
  index.rebuild();
  for (let i = 0; i < 10_000; i++) assert.equal(index.rows.get(43_000n)?.status, "Running");
  assert.equal(reads, 43_000, "keyed lookups must not scan the SDK table again");
});

test("auction clock ignores cold/replayed snapshots and calibrates only new live auctions", () => {
  let now = 5000;
  const clock = new AuctionClock(() => now);
  assert.equal(clock.deadlineFor(1_700_000_001_000), null);
  assert.equal(clock.observe(1_700_000_000_000, "SubscribeApplied"), false);
  assert.equal(clock.deadlineFor(1_700_000_001_000), null);
  assert.equal(clock.observe(1_700_000_000_000, "Transaction"), true);
  assert.equal(clock.deadlineFor(1_700_000_001_000), 6000);
  now = 9000;
  assert.equal(clock.observe(1_700_000_000_000, "SubscribeApplied"), false);
  assert.equal(clock.observe(1_700_000_000_000, "Transaction"), false);
  assert.equal(clock.deadlineFor(1_700_000_001_000), 6000, "replay must not extend an old auction");
});

test("a delayed live packet cannot replace the best recent clock anchor", () => {
  let now = 5000;
  const clock = new AuctionClock(() => now);
  clock.observe(1_000_000, "Transaction");
  now = 6150;
  clock.observe(1_001_000, "Reducer");
  assert.equal(clock.deadlineFor(1_002_000), 7000);
  // Drop the first anchor only after eight newer observations; the recent
  // window can adapt to server drift without trusting the OS clock.
  for (let i = 2; i <= 8; i++) {
    now = 5000 + i * 1000 + 100;
    clock.observe(1_000_000 + i * 1000, "Transaction");
  }
  assert.equal(clock.deadlineFor(1_009_000), 14_100);
});

test("host wall-clock skew and jumps cannot suppress a live monotonic bid", async t => {
  const originalNow = Date.now;
  const bids: bigint[] = [];
  let mono = performance.now();
  const initialMono = mono;
  const clock = new AuctionClock(() => mono);
  clock.observe(1_700_000_000_000, "Transaction");
  const current = { ...snapshot(), closesAtMs: clock.deadlineFor(1_700_000_001_000) };
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 8, word: null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async () => {} });
  t.after(() => { Date.now = originalNow; controller.stop(); });
  Date.now = () => 1_700_003_600_000; // One hour ahead of the server.
  mono += 25;
  controller.refresh(); await flush();
  assert.deepEqual(bids, [8n]);
  assert.ok(Math.abs(clock.deadlineFor(1_700_000_001_000)! - (initialMono + 1000)) < 1);
});

test("uncalibrated cold-start auctions are skipped without suppressing word cashout", async t => {
  const current = { ...snapshot(), closesAtMs: null };
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 8, word: "CAT" }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); } });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  assert.deepEqual(bids, []);
  assert.deepEqual(words, ["CAT"]);
});

test("one committed-cache refresh collapses torn row callbacks", async t => {
  let current = snapshot();
  const seen: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async s => {
    seen.push([...s.myRack.keys()].join("")); return { bid: 0, word: null };
  }, submitBid: async () => {}, submitWord: async () => {}, now: () => 1000 });
  t.after(() => controller.stop());
  current = { ...current, myRack: rack("C") }; controller.refresh();
  current = { ...current, myRack: rack("CA") }; controller.refresh();
  current = { ...current, myRack: rack("CAT") }; controller.refresh();
  await flush();
  assert.deepEqual(seen, ["CAT"]);
});

test("stale worker output cannot cross adjacent bigint auction IDs", async t => {
  let current = { ...snapshot(), auctionId: 9007199254740992n };
  const old = deferred<Decision | null>();
  let calls = 0;
  const bids: bigint[] = [];
  const controller = new BotController({ read: () => [current], evaluate: () => ++calls === 1 ? old.promise : Promise.resolve({ bid: 0, word: null }),
    submitBid: async id => { bids.push(id); }, submitWord: async () => {}, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  current = { ...current, auctionId: 9007199254740993n }; controller.refresh();
  old.resolve({ bid: 25, word: null }); await flush();
  assert.deepEqual(bids, []);
});

test("word ack waits for rack changes and deletion-only changes enable another word", async t => {
  let current = snapshot();
  const ack = deferred<unknown>();
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async s => ({ bid: 0, word: s.myRack.has("C") ? "CAT" : "DOG" }),
    submitBid: async () => {}, submitWord: async (_id, word) => { words.push(word); if (words.length === 1) await ack.promise; }, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  assert.deepEqual(words, ["CAT"]);
  current = { ...current, myRack: rack("DOG"), myBalance: 105, score: 5 };
  controller.refresh(); await flush();
  assert.deepEqual(words, ["CAT"], "a view update alone must not start a second flight");
  ack.resolve(undefined); await flush();
  assert.deepEqual(words, ["CAT", "DOG"]);
  controller.refresh(); await flush();
  assert.deepEqual(words, ["CAT", "DOG"], "ack alone must not spend the same cache twice");
});

test("rejected bid can retry while the auction is still safely open", async t => {
  const current = snapshot();
  let calls = 0;
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 5, word: null }),
    submitBid: async () => { if (++calls === 1) throw new Error("temporary failure"); }, submitWord: async () => {}, now: () => 1000, retryMs: 1 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  assert.equal(calls, 2);
});

test("150 ms deadline guard suppresses late bids and acknowledged duplicates", async t => {
  let current = { ...snapshot(), closesAtMs: 1150 };
  const bids: bigint[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 5, word: null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async () => {}, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.deepEqual(bids, []);
  current = { ...current, closesAtMs: 5000 }; controller.refresh(); await flush();
  current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [5n]);
});

test("a revised zero bid retracts an earlier positive bid", async t => {
  let current = snapshot();
  const bids: bigint[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async s => ({ bid: s.myBalance === 100 ? 5 : 0, word: null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async () => {}, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  current = { ...current, myBalance: 105 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [5n, 0n]);
});

test("a zero revision queued behind an in-flight fallback is sent after acknowledgment", async t => {
  const current = snapshot();
  const ack = deferred<unknown>();
  const bids: bigint[] = [];
  let evaluations = 0;
  const controller = new BotController({ read: () => [current], evaluate: async () => ++evaluations === 1 ? null : { bid: 0, word: null },
    submitBid: async (_id, amount) => { bids.push(amount); if (bids.length === 1) await ack.promise; },
    submitWord: async () => {}, now: () => 1000, retryMs: 1 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  await new Promise(resolve => setTimeout(resolve, 10)); await flush();
  assert.deepEqual(bids, [3n]);
  ack.resolve(undefined); await flush();
  assert.deepEqual(bids, [3n, 0n]);
});

test("worker fallback revalidates cached plans and follows endgame cashout", async t => {
  let current = snapshot();
  let calls = 0;
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ++calls === 1
    ? { bid: 1, word: null, plan: ["ZZ", "CAT", "DOG"] } : null,
    submitBid: async () => {}, submitWord: async (_id, word) => { words.push(word); }, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.deepEqual(words, []);
  current = { ...current, bagTotal: 2 }; controller.refresh(); await flush();
  assert.deepEqual(words, ["CAT"]);
});

test("disconnect invalidates in-flight strategy results", async t => {
  const decision = deferred<Decision | null>();
  const bids: bigint[] = [];
  const controller = new BotController({ read: () => [snapshot()], evaluate: () => decision.promise,
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async () => {}, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); controller.disconnected();
  decision.resolve({ bid: 15, word: "CAT" }); await flush();
  assert.deepEqual(bids, []);
});

test("finite integer budget bounds apply before sending a bid", async t => {
  const bids: bigint[] = [];
  let current = { ...snapshot(), myBalance: 3 };
  let proposed = Infinity;
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: proposed, word: null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async () => {}, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.deepEqual(bids, []);
  proposed = 50.8; current = { ...current, score: 1 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [3n]);
});

test("price estimate and emergency bids use the approved economics", () => {
  assert.equal(estimatePrice([]), 3);
  assert.ok(Math.abs(estimatePrice([0, 8, 0, 3]) - 3.8) < 1e-12);
  const s = snapshot();
  assert.equal(fallbackBid(s), 3);
  assert.equal(fallbackBid({ ...s, myRack: rack("E") }), 1);
  assert.equal(fallbackBid({ ...s, myBalance: -5 }), 0);
  assert.equal(fallbackBid({ ...s, bagTotal: 0 }), 0);
});

test("match metrics distinguish worker fallback from rejected transport and accepted words", async t => {
  const current = snapshot();
  let evaluations = 0;
  let bidCalls = 0;
  const controller = new BotController({ read: () => [current],
    evaluate: async () => ++evaluations === 1 ? null : { bid: 9, word: "CAT", elapsedMs: 4 },
    submitBid: async () => { if (++bidCalls === 1) throw new Error("temporary transport failure"); },
    submitWord: async () => {}, now: () => 1000, retryMs: 1 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  const metrics = controller.stats(current.matchId)!;
  assert.equal(metrics.evaluations, 2);
  assert.equal(metrics.fallbacks, 1);
  assert.equal(metrics.rejectedBids, 1);
  assert.equal(metrics.acceptedBids, 1);
  assert.equal(metrics.acceptedWords, 1);
  assert.equal(metrics.computeTotalMs, 4);
});

test("tournament identifiers reject coercions, negatives and u64 overflow", () => {
  assert.equal(parseTournamentId(undefined), undefined);
  assert.equal(parseTournamentId("18446744073709551615"), 18446744073709551615n);
  for (const value of ["-1", "0", "1.5", "1e3", " 1 ", "18446744073709551616"]) assert.throws(() => parseTournamentId(value));
});
