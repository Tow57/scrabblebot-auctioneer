import { expect, test } from "vitest";
import { DictionaryIndex as CurrentIndex } from "../../../../bot-starter/src/dictionary";
import { submitBid, submitWord } from "../../index";
import { call, currentAuction, emptyDb, getMatch, participant, setRack, startMatch, teamWithBot, tick, VICKREY } from "../harness";
import { makeCashoutAblation } from "./cashout-ablation";
import { canSpell, DictionaryIndex } from "./v1/dictionary";
import { StrategyEngine, type StrategyContext } from "./v1/strategy";

function rack(letters: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
}
function context(letters: string, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return { myRack: rack(letters), myBalance: 100, letter: "T", bagTotal: 50, participantCount: 6,
    auctionType: "Vickrey", estimatedPrice: 3, ...overrides };
}
const stable = (decision: ReturnType<StrategyEngine["decide"]>) => ({ ...decision, elapsedMs: undefined });

test("defaults preserve frozen v1 capital policy for current/frozen indexes and arrays", () => {
  const words = ["CAT", "AT", "QUAKE", "JINX", "TRAINED", "QUIZ"];
  const frozen = new StrategyEngine(words, { capitalAllowance: true });
  for (const dictionary of [words, new CurrentIndex(words), new DictionaryIndex(words)]) {
    const wrapper = makeCashoutAblation(dictionary);
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      for (const bagTotal of [50, 2, 1, 0]) {
        for (const myBalance of [100, 18.7, 0]) {
          const ctx = context("QUAKEJINX", { auctionType, bagTotal, myBalance });
          expect(stable(wrapper.decide(ctx))).toEqual(stable(frozen.decide(ctx)));
        }
      }
    }
  }
});

test("terminal denial spends affordable balance only at the last usable auction in both formats", () => {
  const words = ["CAT"];
  const frozen = new StrategyEngine(words, { capitalAllowance: true });
  const wrapper = makeCashoutAblation(words, { terminalDenial: true });
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    for (const myBalance of [23, 9.7, 0, -5, NaN]) {
      const ctx = context("QX", { auctionType, myBalance, bagTotal: 1 });
      const original = frozen.decide(ctx);
      const result = wrapper.decide(ctx);
      expect(original.bid).toBe(0);
      expect(result.bid).toBe(Number.isFinite(myBalance) ? Math.max(0, Math.floor(myBalance)) : 0);
      expect(result.word).toBe(original.word);
      expect(result.plan).toEqual(original.plan);
      expect(result.cashout).toBe(original.cashout);
      for (const bagTotal of [50, 3, 2]) {
        expect(stable(wrapper.decide({ ...ctx, bagTotal }))).toEqual(stable(frozen.decide({ ...ctx, bagTotal })));
      }
      expect(wrapper.decide({ ...ctx, bagTotal: 0 }).bid).toBe(0);
      expect(wrapper.decide({ ...ctx, letter: "" }).bid).toBe(0);
    }
  }
});

test("high-reward cashout requires both value and funding pressure, preserving base cashouts", () => {
  const words = ["QUAKE", "JINX", "TRAINED", "QUIZ"];
  const frozen = new StrategyEngine(words, { capitalAllowance: true });
  const wrapper = makeCashoutAblation(words, { highRewardCashout: 25 });
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    const ctx = context("QUAKEJINX", { myBalance: 19, estimatedPrice: 10, auctionType });
    const before = [...ctx.myRack];
    const original = frozen.decide(ctx);
    const result = wrapper.decide(ctx);
    expect(original.word).toBeNull();
    expect(result.word).toBe("QUAKE"); // 36 beats JINX's 27, both are legal plan components.
    expect(result.bid).toBe(original.bid);
    expect(result.plan).toEqual(original.plan);
    expect(result.cashout).toBe(original.cashout);
    expect(canSpell(result.word!, ctx.myRack)).toBe(true);
    expect([...ctx.myRack]).toEqual(before);
    expect(wrapper.decide({ ...ctx, myBalance: 20 }).word).toBeNull(); // Strictly below 2*price.
    expect(makeCashoutAblation(words, { highRewardCashout: 37 }).decide(ctx).word).toBeNull();
    expect(wrapper.decide({ ...ctx, myBalance: 11 }).word).toBe(frozen.decide({ ...ctx, myBalance: 11 }).word);
    const existing = context("TRAINEDQUIZ", { myBalance: 19, estimatedPrice: 10, auctionType });
    expect(wrapper.decide(existing).word).toBe(frozen.decide(existing).word);
    const final = wrapper.decide({ ...ctx, bagTotal: 0 });
    expect(final.bid).toBe(0);
    expect(canSpell(final.word!, ctx.myRack)).toBe(true);
  }
  for (const value of [0, -1, NaN, Infinity]) expect(() => makeCashoutAblation(words, { highRewardCashout: value })).toThrow(/positive finite/);
});

test("terminal denial changes opponent opportunity without changing our earned score in an all-real tail", () => {
  function finish(denial: boolean) {
    const db = emptyDb();
    const us = teamWithBot(db, "owner-us", "us");
    const them = teamWithBot(db, "owner-them", "them");
    const matchId = startMatch(db, VICKREY, [us, them]);
    setRack(db, matchId, us, "QX");
    setRack(db, matchId, them, "CA");
    const mine = participant(db, matchId, us);
    const theirs = participant(db, matchId, them);
    db.db.matchParticipant.id.update({ ...mine, balance: 20n, score: 10n });
    db.db.matchParticipant.id.update({ ...theirs, balance: 10n, score: 8n });
    for (const tile of db.db.bagLetter.bagByMatch.filter(matchId)) db.db.bagLetter.id.update({ ...tile, remaining: tile.letter === "O" ? 1 : 0 });
    db.db.matchState.id.update({ ...getMatch(db, matchId), bagTotal: 1 });
    const auction = currentAuction(db, matchId);
    db.db.auction.id.update({ ...auction, letter: "T" });
    const decision = makeCashoutAblation(["CAT"], { terminalDenial: denial })
      .decide(context("QX", { bagTotal: 1, myBalance: 20, participantCount: 2 }));
    if (decision.bid) call(db, "us", ctx => submitBid(ctx, { auctionId: auction.id, amount: BigInt(decision.bid) }));
    call(db, "them", ctx => submitBid(ctx, { auctionId: auction.id, amount: 10n }));
    db.clock.set(auction.closesAt); tick(db, matchId);
    const winner = db.db.auctionResult.auctionId.find(auction.id)!.winnerBotId;
    if (winner === them) call(db, "them", ctx => submitWord(ctx, { matchId, word: "CAT" }));
    const finalAuction = currentAuction(db, matchId);
    expect(getMatch(db, matchId).bagTotal).toBe(0);
    expect(makeCashoutAblation(["CAT"], { terminalDenial: denial }).decide(context("QXT", { bagTotal: 0 })).bid).toBe(0);
    db.clock.set(finalAuction.closesAt); tick(db, matchId);
    expect(getMatch(db, matchId).status.tag).toBe("Ended");
    return { ours: participant(db, matchId, us).score, theirs: participant(db, matchId, them).score };
  }
  expect(finish(false)).toEqual({ ours: 10n, theirs: 13n });
  expect(finish(true)).toEqual({ ours: 10n, theirs: 8n });
});
