// Contract checks that matter specifically to an external tournament bot.
// Use the actual reducers: a simulator with a post-game cashout would get
// the final-tile case wrong and materially overstate a bot's score.
import { expect, test } from "vitest";
import { submitBid, submitWord } from "../index";
import {
  call,
  currentAuction,
  emptyDb,
  failure,
  getMatch,
  participant,
  rack,
  runToEnd,
  setRack,
  startMatch,
  teamWithBot,
  tick,
  VICKREY,
} from "./harness";

function externalPlayers(count = 2) {
  const db = emptyDb();
  const bots = Array.from({ length: count }, (_, seat) =>
    teamWithBot(db, `owner-${seat}`, `external-${seat}`),
  );
  return { db, bots, matchId: startMatch(db, VICKREY, bots) };
}

test("external bot score floors the bonus and permits a word again with fresh tiles", () => {
  const { db, bots, matchId } = externalPlayers();
  setRack(db, matchId, bots[0]!, "AXESAXES");
  for (let attempt = 0; attempt < 2; attempt++) {
    call(db, "external-0", (ctx) =>
      submitWord(ctx, { matchId, word: "axes" }),
    );
  }
  const player = participant(db, matchId, bots[0]!);
  expect([player.score, player.balance]).toEqual([32n, 132n]);
  expect(rack(db, matchId, bots[0]!)).toEqual([]);
  const plays = [...db.db.wordPlay.playByMatch.filter(matchId)];
  expect(plays.map((play) => [play.baseScore, play.totalReward])).toEqual([
    [11n, 16n],
    [11n, 16n],
  ]);
});

test("unsold tiles leave the finite bag instead of being reauctioned", () => {
  const { db, bots, matchId } = externalPlayers(6);
  const bagBefore = getMatch(db, matchId).bagTotal;
  const first = currentAuction(db, matchId);
  call(db, "external-0", (ctx) =>
    submitBid(ctx, { auctionId: first.id, amount: 0n }),
  );
  db.clock.set(first.closesAt);
  tick(db, matchId);
  expect(getMatch(db, matchId).bagTotal).toBe(bagBefore - 1);
  expect(db.db.auctionResult.auctionId.find(first.id)?.winnerBotId).toBeUndefined();
  expect(runToEnd(db, matchId) + 1).toBe(98 - 5 * bots.length);
  const results = [...db.db.auctionResult.resultByMatch.filter(matchId)];
  expect(results).toHaveLength(68);
  expect(results.every((result) => result.winnerBotId === undefined)).toBe(true);
  expect(participant(db, matchId, bots[0]!).score).toBe(0n);
});

test("a final-tile winner cannot cash out after settlement", () => {
  const { db, bots, matchId } = externalPlayers();
  const auction = currentAuction(db, matchId);
  // Fixture: an imminent last T. The bot can bank AX beforehand, but CAT
  // only becomes spellable in the transaction that also ends the match.
  setRack(db, matchId, bots[0]!, "CAAX");
  db.db.auction.id.update({ ...auction, letter: "T" });
  for (const tile of db.db.bagLetter.bagByMatch.filter(matchId)) {
    db.db.bagLetter.id.update({ ...tile, remaining: 0 });
  }
  db.db.matchState.id.update({ ...getMatch(db, matchId), bagTotal: 0 });
  call(db, "external-0", (ctx) => submitWord(ctx, { matchId, word: "AX" }));
  call(db, "external-0", (ctx) =>
    submitBid(ctx, { auctionId: auction.id, amount: 1n }),
  );
  db.clock.set(auction.closesAt);
  tick(db, matchId);
  expect(getMatch(db, matchId).status.tag).toBe("Ended");
  expect(rack(db, matchId, bots[0]!)).toEqual([["A", 1], ["C", 1], ["T", 1]]);
  expect(failure(() => call(db, "external-0", (ctx) =>
    submitWord(ctx, { matchId, word: "CAT" }),
  ))).toBe("Match not running");
  expect(participant(db, matchId, bots[0]!).score).toBe(9n);
});

test("an external bid at the exact close timestamp is too late", () => {
  const { db, matchId } = externalPlayers();
  const auction = currentAuction(db, matchId);
  db.clock.set(auction.closesAt);
  expect(failure(() => call(db, "external-0", (ctx) =>
    submitBid(ctx, { auctionId: auction.id, amount: 1n }),
  ))).toBe("Auction window expired");
  expect([...db.db.pendingBid.bidByAuction.filter(auction.id)]).toEqual([]);
});

test("equal bids do not give priority to the first submitting credential", () => {
  const winners = new Set<bigint>();
  for (let seed = 1; seed <= 16; seed++) {
    const { db, bots, matchId } = externalPlayers();
    const auction = currentAuction(db, matchId);
    for (const name of ["external-0", "external-1"]) {
      call(db, name, (ctx) => submitBid(ctx, { auctionId: auction.id, amount: 1n }));
    }
    db.rng.setSeed(BigInt(seed));
    db.clock.set(auction.closesAt);
    tick(db, matchId);
    const winner = db.db.auctionResult.auctionId.find(auction.id)!.winnerBotId!;
    winners.add(BigInt(bots.indexOf(winner)));
  }
  expect([...winners].sort()).toEqual([0n, 1n]);
});
