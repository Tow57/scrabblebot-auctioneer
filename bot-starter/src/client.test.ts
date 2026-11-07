import assert from "node:assert/strict";
import { test } from "node:test";
import { AuctionClock, BidExposureLedger, BotController, estimatePrice, fallbackBid, indexRows, parseTournamentId, type Decision, type MatchSnapshot } from "./client.js";
import { StrategyEngine } from "./strategy.js";

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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, e) => { resolve = r; reject = e; });
  return { promise, resolve, reject };
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

test("uncalibrated positive bids are skipped while exposure-free cashout proceeds", async t => {
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
  const bids: bigint[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ++calls === 1
    ? { bid: 1, word: null, plan: ["ZZ", "CAT", "DOG"] } : null,
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); }, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.deepEqual(words, []);
  current = { ...current, bagTotal: 2 }; controller.refresh(); await flush();
  assert.deepEqual(words, ["CAT"]);
  assert.deepEqual(bids, [1n, 0n], "cached cashout retracts the bid instead of placing a fallback bid");
});

test("real RAINBOWS decision cashes out before valuing the now-empty rack near the deadline", async t => {
  let now = 1700;
  let current = { ...snapshot(), myRack: rack("RAINBOW"), letter: "S", closesAtMs: 2000 };
  const engine = new StrategyEngine(["RAINBOW", "RAINBOWS"], { capitalAllowance: true });
  assert.equal(engine.decide(current).bid, 35, "the old rack makes this a high bid");
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async s => engine.decide(s),
    submitBid: async (_id, amount) => { bids.push(amount); },
    submitWord: async (_id, word) => {
      words.push(word); now = 1900;
      current = { ...current, myRack: new Map(), myBalance: 136, score: 36 };
      controller.refresh();
    }, now: () => now });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  assert.deepEqual(words, ["RAINBOW"]);
  assert.deepEqual(bids, [], "no obsolete pre-cashout bid may reach the server");
  assert.equal(engine.decide(current).bid, 0);
});

test("an unspellable worker word cannot suppress an otherwise valid bid", async t => {
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [snapshot()], evaluate: async () => ({ bid: 7, word: "ZZ" }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); }, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  assert.deepEqual(words, []);
  assert.deepEqual(bids, [7n]);
});

test("accepted positive bids get one zero retraction inside the 150ms margin before cashout", async t => {
  let now = 1000;
  let current = { ...snapshot(), closesAtMs: 2000 };
  let cashout = false;
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 99, word: cashout ? "CAT" : null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); }, now: () => now });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  cashout = true; now = 1900; current = { ...current, score: 1 }; controller.refresh(); await flush();
  current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [99n, 0n]);
  assert.deepEqual(words, ["CAT"], "the word remains a single flight while the rack is unchanged");
});

test("an in-flight positive bid queues a late zero cancellation until its acknowledgment", async t => {
  let now = 1000;
  let current = { ...snapshot(), closesAtMs: 2000 };
  let cashout = false;
  const ack = deferred<unknown>();
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 8, word: cashout ? "CAT" : null }),
    submitBid: async (_id, amount) => { bids.push(amount); if (bids.length === 1) await ack.promise; },
    submitWord: async (_id, word) => { words.push(word); }, now: () => now });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  cashout = true; now = 1900; current = { ...current, score: 1 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [8n]);
  assert.deepEqual(words, ["CAT"]);
  now = 1950; ack.resolve(undefined); await flush();
  assert.deepEqual(bids, [8n, 0n]);
});

test("completed cashout cannot overwrite a queued zero before the old positive bid acknowledges", async t => {
  for (const remaining of [100, 900]) {
    let now = 1000;
    let current = { ...snapshot(), closesAtMs: 2000 };
    let cashout = false;
    const bidAck = deferred<unknown>();
    const wordAck = deferred<unknown>();
    const bids: bigint[] = [];
    const controller = new BotController({ read: () => [current], evaluate: async s => ({
      bid: s.myRack.has("C") ? 99 : 1, word: cashout && s.myRack.has("C") ? "CAT" : null,
    }), submitBid: async (_id, amount) => { bids.push(amount); if (bids.length === 1) await bidAck.promise; },
    submitWord: async () => { await wordAck.promise; }, now: () => now });
    t.after(() => controller.stop());
    controller.refresh(); await flush();
    cashout = true; current = { ...current, score: 1 }; controller.refresh(); await flush();
    current = { ...current, myRack: rack("DOG"), myBalance: 105, score: 5 };
    wordAck.resolve(undefined); controller.refresh(); await flush();
    assert.deepEqual(bids, [99n], "fresh bid 1 must not replace the queued cancellation");
    now = 2000 - remaining;
    bidAck.resolve(undefined); await flush();
    assert.deepEqual(bids, remaining > 150 ? [99n, 0n, 1n] : [99n, 0n]);
  }
});

test("positive bidding resumes only after both word acknowledgment and authoritative rack change", async t => {
  for (const order of ["ack-first", "cache-first"]) {
    let current = snapshot();
    const ack = deferred<unknown>();
    const bids: bigint[] = [];
    const words: string[] = [];
    const controller = new BotController({ read: () => [current], evaluate: async s => ({ bid: 12, word: s.myRack.has("C") ? "CAT" : null }),
      submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); await ack.promise; }, now: () => 1000 });
    t.after(() => controller.stop());
    controller.refresh(); await flush();
    assert.deepEqual(bids, []);
    if (order === "ack-first") ack.resolve(undefined);
    else current = { ...current, myRack: rack("DOG"), myBalance: 105, score: 5 };
    controller.refresh(); await flush();
    assert.deepEqual(bids, [], `${order}: one completion signal alone must not enable bidding`);
    if (order === "ack-first") current = { ...current, myRack: rack("DOG"), myBalance: 105, score: 5 };
    else ack.resolve(undefined);
    controller.refresh(); await flush();
    assert.deepEqual(words, ["CAT"]);
    assert.deepEqual(bids, [12n]);
  }
});

test("failed words recover from a fresh snapshot without spending the old rack again", async t => {
  let current = snapshot();
  const wordResult = deferred<unknown>();
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async s => ({ bid: 6, word: s.myRack.has("C") ? "CAT" : null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); await wordResult.promise; },
    now: () => 1000, retryMs: 1 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  current = { ...current, myRack: rack("DOG"), score: 5 }; controller.refresh(); await flush();
  assert.deepEqual(bids, []);
  wordResult.reject(new Error("request failed after authoritative state changed")); await flush();
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  assert.deepEqual(words, ["CAT"]);
  assert.deepEqual(bids, [6n]);
});

test("a synchronous word transport failure releases its flight and retries fresh state", async t => {
  let current = snapshot();
  const attempts: string[] = [];
  const controller = new BotController({ read: () => [current], now: () => 1000, retryMs: 1,
    evaluate: async s => ({ bid: 0, word: s.myRack.has("C") ? "CAT" : null }), submitBid: async () => {},
    submitWord: (_id, word) => {
      attempts.push(word);
      if (attempts.length === 1) throw new Error("socket send failed synchronously");
      current = { ...current, myRack: rack("DOG"), score: 5, myBalance: 105 };
      return Promise.resolve();
    } });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  assert.deepEqual(attempts, ["CAT", "CAT"]);
  assert.equal(controller.stats(1n)?.rejectedWords, 1);
  assert.equal(controller.stats(1n)?.acceptedWords, 1);
});

test("cached cashout also precedes bidding when worker evaluation rejects", async t => {
  let current = snapshot();
  let evaluations = 0;
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => {
    if (++evaluations === 1) return { bid: 7, word: null, plan: ["CAT"] };
    throw new Error("worker failed");
  }, submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async (_id, word) => { words.push(word); }, now: () => 1000 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  current = { ...current, bagTotal: 2 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [7n, 0n]);
  assert.deepEqual(words, ["CAT"]);
});

test("no zero retraction is sent at or after the auction deadline", async t => {
  let now = 1000;
  let current = { ...snapshot(), closesAtMs: 2000 };
  let cashout = false;
  const bids: bigint[] = [];
  const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 8, word: cashout ? "CAT" : null }),
    submitBid: async (_id, amount) => { bids.push(amount); }, submitWord: async () => {}, now: () => now });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  cashout = true; now = 2000; current = { ...current, score: 1 }; controller.refresh(); await flush();
  now = 2010; current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [8n]);
});

test("failed zero retractions retry with ample time but never retry inside the late margin", async t => {
  for (const remaining of [900, 100]) {
    let now = 1000;
    let current = { ...snapshot(), closesAtMs: 2000 };
    let cashout = false;
    const bids: bigint[] = [];
    const controller = new BotController({ read: () => [current], evaluate: async () => ({ bid: 8, word: cashout ? "CAT" : null }),
      submitBid: async (_id, amount) => { bids.push(amount); if (bids.length === 2) throw new Error("zero request failed"); },
      submitWord: async () => {}, now: () => now, retryMs: 1 });
    t.after(() => controller.stop());
    controller.refresh(); await flush();
    cashout = true; now = 2000 - remaining; current = { ...current, score: 1 }; controller.refresh(); await flush();
    await new Promise(resolve => setTimeout(resolve, 15));
    current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
    assert.deepEqual(bids, remaining > 150 ? [8n, 0n, 0n] : [8n, 0n]);
  }
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

test("accepted bid exposure survives empty replay and retracts before a resumed word", async t => {
  const bidExposure = new BidExposureLedger();
  let now = 1000;
  let current = { ...snapshot(), closesAtMs: 2000 };
  let online = true;
  let cashout = false;
  let serverBid = 0n;
  const zeroAck = deferred<unknown>();
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ bidExposure, read: () => online ? [current] : [], now: () => now,
    evaluate: async s => ({ bid: s.myRack.has("C") ? 99 : 0, word: cashout && s.myRack.has("C") ? "CAT" : null }),
    submitBid: async (_id, amount) => { serverBid = amount; bids.push(amount); if (amount === 0n) await zeroAck.promise; },
    submitWord: async (_id, word) => { words.push(word); current = { ...current, myRack: rack("DOG"), score: 5, myBalance: 105 }; controller.refresh(); } });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.equal(serverBid, 99n);
  online = false; controller.disconnected(); controller.refresh(); await flush();
  assert.equal(bidExposure.size, 1, "empty resubscription snapshots do not prove settlement");
  cashout = true; online = true; now = 1900; controller.refresh(); await flush();
  assert.deepEqual(bids, [99n, 0n], "first recovery zero may reduce exposure with100ms left");
  assert.deepEqual(words, [], "cashout waits for recovery cancellation acknowledgement");
  zeroAck.resolve(undefined); await flush();
  assert.deepEqual(words, ["CAT"]); assert.equal(serverBid, 0n); assert.equal(bidExposure.size, 0);
});

test("a positive send with lost acknowledgement survives full controller replacement", async t => {
  const bidExposure = new BidExposureLedger();
  let current = snapshot();
  let serverBid = 0n;
  const oldAck = deferred<unknown>();
  const bids: bigint[] = [];
  const first = new BotController({ bidExposure, read: () => [current], now: () => 1000,
    evaluate: async () => ({ bid: 99, word: null, plan: ["CAT"] }),
    submitBid: async (_id, amount) => { bids.push(amount); serverBid = amount; await oldAck.promise; }, submitWord: async () => {} });
  first.refresh(); await flush(); assert.equal(serverBid, 99n);
  first.stop();
  const words: string[] = [];
  const second = new BotController({ bidExposure, read: () => [current], now: () => 1500,
    evaluate: async () => null, submitBid: async (_id, amount) => { bids.push(amount); serverBid = amount; },
    submitWord: async (_id, word) => { words.push(word); }, retryMs: 60_000 });
  t.after(() => second.stop());
  second.refresh(); await flush();
  assert.equal(serverBid, 3n, "fresh fallback reprices only after zero acknowledgement");
  assert.deepEqual(bids, [99n, 0n, 3n]);
  assert.deepEqual(words, [], "the previous controller's word plan is not carried across reconnect");
  oldAck.resolve(undefined); await flush();
  assert.equal(bidExposure.size, 1, "the obsolete99 ACK cannot discard the new3 exposure");
});

test("a cold ten-second auction gets one uncalibrated zero before cashout and no positive bid", async t => {
  const bidExposure = new BidExposureLedger();
  bidExposure.markUnknown([1n]); // Main does this only once, from its committed initial own-running set.
  let current: MatchSnapshot = { ...snapshot(), closesAtMs: null };
  let now = 2000; // A previous process's99 can still exist in a10-second auction.
  let serverBid = 99n;
  const zeroAck = deferred<unknown>();
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ bidExposure, read: () => [current], now: () => now,
    evaluate: async s => ({ bid: 12, word: s.myRack.has("C") ? "CAT" : null }),
    submitBid: async (_id, amount) => { assert.ok(now < 10_000); bids.push(amount); serverBid = amount; await zeroAck.promise; },
    submitWord: async (_id, word) => { words.push(word); current = { ...current, myRack: rack("DOG"), score: 5, myBalance: 105 }; controller.refresh(); } });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [0n]); assert.deepEqual(words, []);
  zeroAck.resolve(undefined); await flush();
  assert.deepEqual(words, ["CAT"]); assert.equal(serverBid, 0n); assert.deepEqual(bids, [0n]);
  now = 3000; current = { ...current, auctionId: 3n, closesAtMs: 10_000 }; controller.refresh(); await flush();
  assert.deepEqual(bids, [0n, 12n], "new positives still require a live monotonic anchor and margin");
});

test("a missing cached auction preserves unknown or known exposure until the same Open row returns", async t => {
  for (const known of [false, true]) {
    const bidExposure = new BidExposureLedger();
    if (!known) bidExposure.markUnknown([1n]);
    let current: MatchSnapshot = known ? snapshot() : { ...snapshot(), auctionId: null, closesAtMs: null };
    let cashout = !known;
    const zeroAck = deferred<unknown>();
    const bids: bigint[] = [];
    const words: string[] = [];
    const controller = new BotController({ bidExposure, read: () => [current], now: () => 1000,
      evaluate: async () => ({ bid: 99, word: cashout ? "CAT" : null }),
      submitBid: async (_id, amount) => { bids.push(amount); if (amount === 0n) await zeroAck.promise; },
      submitWord: async (_id, word) => { words.push(word); } });
    t.after(() => controller.stop());
    controller.refresh(); await flush();
    if (known) {
      cashout = true; current = { ...current, auctionId: null, closesAtMs: null }; controller.refresh(); await flush();
    }
    assert.equal(bidExposure.size, 1); assert.deepEqual(words, []);
    assert.deepEqual(bids, known ? [99n] : []);
    current = { ...current, auctionId: 2n, closesAtMs: known ? 10_000 : null }; controller.refresh(); await flush();
    assert.deepEqual(bids, known ? [99n, 0n] : [0n]); assert.deepEqual(words, []);
    zeroAck.resolve(undefined); await flush(); assert.deepEqual(words, ["CAT"]); assert.equal(bidExposure.size, 0);
  }
});

test("a rejected uncalibrated recovery zero is never repeated across replay or disconnect", async t => {
  const bidExposure = new BidExposureLedger(); bidExposure.markUnknown([1n]);
  let current = { ...snapshot(), closesAtMs: null };
  let online = true;
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ bidExposure, read: () => online ? [current] : [], now: () => 2000,
    evaluate: async () => ({ bid: 12, word: "CAT" }),
    submitBid: async (_id, amount) => { bids.push(amount); throw new Error("replay closed in transit"); },
    submitWord: async (_id, word) => { words.push(word); }, retryMs: 1 });
  t.after(() => controller.stop());
  controller.refresh(); await flush();
  current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
  online = false; controller.disconnected(); controller.refresh(); await flush();
  online = true; controller.refresh(); await flush();
  await new Promise(resolve => setTimeout(resolve, 15)); await flush();
  assert.deepEqual(bids, [0n]); assert.deepEqual(words, []); assert.equal(bidExposure.size, 1);
  current = { ...current, auctionId: 3n }; controller.refresh(); await flush();
  assert.deepEqual(words, ["CAT"], "authoritative auction advance releases uncertain old exposure");
  assert.equal(bidExposure.size, 0); assert.deepEqual(bids, [0n]);
});

test("known recovery cancellation retries only with a calibrated150ms margin", async t => {
  for (const remaining of [900, 100, 0]) {
    const bidExposure = new BidExposureLedger();
    let now = 1000;
    let current = { ...snapshot(), closesAtMs: 2000 };
    let cashout = false;
    const bids: bigint[] = [];
    const words: string[] = [];
    const controller = new BotController({ bidExposure, read: () => [current], now: () => now, retryMs: 1,
      evaluate: async () => ({ bid: 99, word: cashout ? "CAT" : null }),
      submitBid: (_id, amount) => { bids.push(amount); if (bids.length === 2) throw new Error("cancel failed synchronously"); return Promise.resolve(); },
      submitWord: async (_id, word) => { words.push(word); } });
    t.after(() => controller.stop());
    controller.refresh(); await flush(); controller.disconnected();
    cashout = true; now = 2000 - remaining; controller.refresh(); await flush();
    await new Promise(resolve => setTimeout(resolve, 15));
    current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
    assert.deepEqual(bids, remaining > 150 ? [99n, 0n, 0n] : remaining > 0 ? [99n, 0n] : [99n]);
    assert.deepEqual(words, remaining > 150 ? ["CAT"] : []);
    assert.equal(bidExposure.size, remaining > 150 ? 0 : 1);
  }
});

test("final bag0 cashout does not wait for an unknown-bid cancellation acknowledgement", async t => {
  const bidExposure = new BidExposureLedger(); bidExposure.markUnknown([1n]);
  const current = { ...snapshot(), bagTotal: 0, closesAtMs: null };
  const bids: bigint[] = [];
  const words: string[] = [];
  const controller = new BotController({ bidExposure, read: () => [current], now: () => 2000,
    evaluate: async () => ({ bid: 0, word: "CAT" }),
    submitBid: async (_id, amount) => { bids.push(amount); await new Promise<void>(() => {}); },
    submitWord: async (_id, word) => { words.push(word); } });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.deepEqual(bids, [0n]); assert.deepEqual(words, ["CAT"]);
});

test("auction advance and the committed running set clean exposure without conflating bigint IDs", async t => {
  const bidExposure = new BidExposureLedger();
  const oldAuction = 9007199254740992n;
  let current = { ...snapshot(), auctionId: oldAuction };
  let proposed = 99;
  const bids: { id: bigint; amount: bigint }[] = [];
  const controller = new BotController({ bidExposure, read: () => [current], now: () => 1000,
    evaluate: async () => ({ bid: proposed, word: null }),
    submitBid: async (id, amount) => { bids.push({ id, amount }); }, submitWord: async () => {} });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); assert.equal(bidExposure.size, 1);
  controller.disconnected(); proposed = 0; current = { ...current, auctionId: oldAuction + 1n };
  controller.refresh(); await flush(); assert.equal(bidExposure.size, 0);
  assert.deepEqual(bids, [{ id: oldAuction, amount: 99n }], "never cancel a different auction");
  proposed = 5; current = { ...current, estimatedPrice: 4 }; controller.refresh(); await flush();
  assert.equal(bidExposure.size, 1);
  bidExposure.retainRunning(new Set()); assert.equal(bidExposure.size, 0, "main supplies authoritative match-end cleanup");
});

test("an obsolete zero acknowledgement cannot erase a newer positive exposure", async t => {
  const bidExposure = new BidExposureLedger();
  let current = snapshot();
  let proposed = 99;
  const oldZeroAck = deferred<unknown>();
  const bids: bigint[] = [];
  let oldZeroSent = false;
  const controller = new BotController({ bidExposure, read: () => [current], now: () => 1000,
    evaluate: async () => ({ bid: proposed, word: null }),
    submitBid: async (_id, amount) => {
      bids.push(amount);
      if (amount === 0n && !oldZeroSent) { oldZeroSent = true; await oldZeroAck.promise; }
    }, submitWord: async () => {} });
  t.after(() => controller.stop());
  controller.refresh(); await flush(); controller.disconnected(); proposed = 1;
  controller.refresh(); await flush(); assert.deepEqual(bids, [99n, 0n]);
  controller.disconnected(); controller.refresh(); await flush();
  assert.deepEqual(bids, [99n, 0n, 0n, 1n]);
  oldZeroAck.resolve(undefined); await flush(); assert.equal(bidExposure.size, 1);
  proposed = 0; controller.disconnected(); controller.refresh(); await flush();
  assert.deepEqual(bids, [99n, 0n, 0n, 1n, 0n]); assert.equal(bidExposure.size, 0);
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
  assert.equal(fallbackBid({ ...s, bagTotal: 1 }), 0, "emergency fallback has no proof that the last usable tile improves cashout");
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
  assert.equal(metrics.evaluations, 3, "zero acknowledgment triggers a fresh evaluation after cancellation");
  assert.equal(metrics.fallbacks, 1);
  assert.equal(metrics.rejectedBids, 1);
  assert.equal(metrics.acceptedBids, 1);
  assert.equal(metrics.acceptedWords, 1);
  assert.equal(metrics.computeTotalMs, 8);
});

test("tournament identifiers reject coercions, negatives and u64 overflow", () => {
  assert.equal(parseTournamentId(undefined), undefined);
  assert.equal(parseTournamentId("18446744073709551615"), 18446744073709551615n);
  for (const value of ["-1", "0", "1.5", "1e3", " 1 ", "18446744073709551616"]) assert.throws(() => parseTournamentId(value));
});
