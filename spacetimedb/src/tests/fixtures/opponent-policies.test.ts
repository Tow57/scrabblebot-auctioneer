import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DictionaryIndex as CurrentIndex } from "../../../../bot-starter/src/dictionary";
import { myRack, submitBid, submitWord } from "../../index";
import { letterValue } from "../../letters";
import { call, client, currentAuction, emptyDb, getMatch, participant, startMatch, teamWithBot, tick, VICKREY } from "../harness";
import { makeOpponent, makeScaledV1, type OpponentKind } from "./opponent-policies";
import { canSpell, DictionaryIndex } from "./v1/dictionary";
import { StrategyEngine as FrozenEngine, type StrategyContext } from "./v1/strategy";

const kinds: OpponentKind[] = ["market", "liquid", "target"];
function rack(letters: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of letters) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
}
function context(letters: string, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return { myRack: rack(letters), myBalance: 100, letter: "C", bagTotal: 60,
    participantCount: 6, auctionType: "Vickrey", estimatedPrice: 3, ...overrides };
}

test("opponents accept current and frozen indexes without coupling to the candidate engine", () => {
  for (const dictionary of [["CAT", "AT"], new CurrentIndex(["CAT", "AT"]), new DictionaryIndex(["CAT", "AT"])]) {
    for (const kind of kinds) {
      const policy = makeOpponent(kind, dictionary);
      const ctx = context("A");
      const before = [...ctx.myRack];
      const decision = policy.decide(ctx);
      expect(decision.bid).toBeGreaterThanOrEqual(7);
      expect(decision.bid).toBeLessThanOrEqual(100);
      expect(Number.isInteger(decision.bid)).toBe(true);
      expect([...ctx.myRack]).toEqual(before);
      expect(policy.decide({ ...ctx, letter: "Z" }).bid).toBe(0);
      expect(policy.decide({ ...ctx, myBalance: 0 }).bid).toBe(0);
      expect(policy.decide({ ...ctx, myBalance: 2.9 }).bid).toBeLessThanOrEqual(2);
    }
  }
});

test("market priors do not bypass usefulness or last-usable-tile constraints", () => {
  for (const kind of kinds) {
    const policy = makeOpponent(kind, ["QUA", "CAT"]);
    expect(policy.decide(context("AAAAA", { letter: "Q" })).bid).toBeGreaterThanOrEqual(20);
    expect(policy.decide(context("CA", { letter: "T", bagTotal: 1, myBalance: 37 })).bid).toBe(37);
    expect(policy.decide(context("A", { letter: "C", bagTotal: 1 })).bid).toBe(0);
    expect(policy.decide(context("CAT", { letter: "Q", bagTotal: 0 })).bid).toBe(0);
    const first = policy.decide(context("A", { letter: "Q", auctionType: "FirstPrice" }));
    expect(first.bid).toBeGreaterThan(0);
    expect(first.bid).toBeLessThan(policy.decide(context("A", { letter: "Q" })).bid);
  }
});

test("market-v1 preserves the frozen capital bid floor within legal balance and terminal caps", () => {
  const dictionary = new DictionaryIndex(["CAT"]);
  const frozen = new FrozenEngine(dictionary, { capitalAllowance: true });
  const market = makeOpponent("market", dictionary);
  const variant = makeOpponent("market-v1", dictionary);
  const opportunity = context("A", { bagTotal: 6 });
  expect(frozen.decide(opportunity).bid).toBeGreaterThan(market.decide(opportunity).bid);
  expect(variant.decide(opportunity).bid).toBeGreaterThanOrEqual(frozen.decide(opportunity).bid);
  for (const myBalance of [100, 11, 2.9, 0]) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      for (const bagTotal of [60, 6, 1, 0]) {
        const ctx = context("A", { myBalance, auctionType, bagTotal });
        const result = variant.decide(ctx);
        expect(result.bid).toBeGreaterThanOrEqual(frozen.decide(ctx).bid);
        expect(Number.isInteger(result.bid)).toBe(true);
        expect(result.bid).toBeGreaterThanOrEqual(0);
        expect(result.bid).toBeLessThanOrEqual(Math.floor(myBalance));
        expect(result.word).toBe(frozen.decide(ctx).word);
      }
    }
  }
  expect(variant.decide({ ...opportunity, letter: "Z" }).bid).toBe(0);
});

test("scaled-v1 isolates affordable bid aggression and preserves exact v1 terminal behavior", () => {
  const dictionary = new DictionaryIndex(["CAT", "AT"]);
  const frozen = new FrozenEngine(dictionary, { capitalAllowance: true });
  for (const scale of [0.8, 1, 1.1, 1.25, 1.5, 2]) {
    const policy = makeScaledV1(scale, dictionary);
    for (const myBalance of [100, 2.9, 0]) {
      for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
        for (const bagTotal of [60, 2, 1, 0]) {
          const ctx = context("CA", { myBalance, auctionType, bagTotal, letter: "T" });
          const original = frozen.decide(ctx);
          const result = policy.decide(ctx);
          expect(result.bid).toBe(bagTotal <= 1 ? original.bid
            : Math.min(Math.floor(myBalance), Math.ceil(original.bid * scale)));
          expect(Number.isInteger(result.bid) && result.bid >= 0 && result.bid <= Math.floor(myBalance)).toBe(true);
          expect(result.word).toBe(original.word);
          expect(result.plan).toEqual(original.plan);
          expect(result.cashout).toBe(original.cashout);
        }
      }
    }
  }
  for (const invalid of [-1, 0, 0.49, 2.01, NaN, Infinity, -Infinity]) {
    expect(() => makeScaledV1(invalid, dictionary)).toThrow(/finite number between/);
  }
});

test("liquid profile cashes six-letter words and anticipates two market purchases", () => {
  const words = ["PLANET", "CAT", "AT"];
  const liquid = makeOpponent("liquid", words);
  expect(liquid.decide(context("PLANET", { letter: "" })).word).toBe("PLANET");
  expect(makeOpponent("market", words).decide(context("PLANET", { letter: "" })).word).toBeNull();
  expect(liquid.decide(context("CAT", { letter: "", myBalance: 15, estimatedPrice: 8 })).word).toBe("CAT");
  for (const kind of kinds) {
    const result = makeOpponent(kind, words).decide(context("CATPLANET", { bagTotal: 0 }));
    const remaining = rack("CATPLANET");
    for (const word of result.plan) {
      expect(words).toContain(word);
      expect(canSpell(word, remaining)).toBe(true);
      for (const letter of word) remaining.set(letter, remaining.get(letter)! - 1);
    }
  }
});

// Calibration is deliberately reported, not tuned into a passing assertion.
// Six symmetric players can average at most 68/6 = 11.33 auction tiles. The
// live 20–25-tile figures describe strong players at tables with weaker seats.
test.skipIf(process.env.OPPONENT_CALIBRATION !== "1")("report offline policy calibration in mixed and symmetric tables", () => {
  const words = readFileSync(new URL("../../../wordlist.txt", import.meta.url), "utf8")
    .split(/\s+/).filter(word => word.length >= 2).sort((a, b) => b.length - a.length);
  const index = new DictionaryIndex(words);
  const records: { mode: string; kind: OpponentKind; score: number; tiles: number; firstWord: number | null }[] = [];
  for (const mode of ["mixed-three-strong", "six-profile-selfplay"]) {
    for (let seed = 1; seed <= 3; seed++) {
      const db = emptyDb();
      const agents = Array.from({ length: 6 }, (_, seat) => ({
        name: `calibration-${seat}`,
        id: teamWithBot(db, `owner-${seat}`, `calibration-${seat}`),
        kind: kinds[seat % 3]!,
        policy: mode === "six-profile-selfplay" || seat < 3 ? makeOpponent(kinds[seat % 3]!, index) : undefined,
        firstWord: null as number | null,
        cache: new Map<string, string | null>(),
      }));
      db.rng.setSeed(BigInt(9101 + seed * 7919));
      const matchId = startMatch(db, VICKREY, agents.map(agent => agent.id));
      const started = getMatch(db, matchId).createdAt.microsSinceUnixEpoch;
      let round = 0;
      let price = 3;
      while (getMatch(db, matchId).status.tag === "Running") {
        const auction = currentAuction(db, matchId);
        const match = getMatch(db, matchId);
        for (const agent of agents) {
          let bid = 0;
          for (let attempt = 0; ; attempt++) {
            const own = new Map(myRack(db.viewContext(client(agent.name))).filter(tile => tile.matchId === matchId).map(tile => [tile.letter, tile.count]));
            const balance = Number(participant(db, matchId, agent.id).balance);
            let word: string | null;
            if (agent.policy) {
              ({ bid, word } = agent.policy.decide({ myRack: own, myBalance: balance, letter: auction.letter,
                bagTotal: match.bagTotal, participantCount: 6, auctionType: "Vickrey", estimatedPrice: price }));
            } else {
              const key = [...own].sort().map(([letter, count]) => `${letter}${count}`).join("");
              if (!agent.cache.has(key)) {
                const size = [...own.values()].reduce((sum, count) => sum + count, 0);
                agent.cache.set(key, words.find(candidate => candidate.length <= size && canSpell(candidate, own)) ?? null);
              }
              word = agent.cache.get(key)!;
              bid = Math.min(balance, letterValue(auction.letter) + (own.has(auction.letter) ? 0 : 2));
            }
            expect(Number.isInteger(bid) && bid >= 0 && bid <= balance).toBe(true);
            if (!word) break;
            if (attempt > 48) throw new Error("cashout did not consume the rack");
            call(db, agent.name, ctx => submitWord(ctx, { matchId, word }));
            agent.firstWord ??= Number(db.clock.now().microsSinceUnixEpoch - started) / 1e6;
          }
          if (bid > 0 && match.bagTotal > 0) call(db, agent.name, ctx => submitBid(ctx, { auctionId: auction.id, amount: BigInt(bid) }));
        }
        db.clock.set(auction.closesAt);
        db.rng.setSeed(BigInt(seed * 1_000_003 + ++round * 7919));
        tick(db, matchId);
        const paid = Number(db.db.auctionResult.auctionId.find(auction.id)!.paid);
        if (paid > 0) price = 0.8 * price + 0.2 * paid;
      }
      const results = [...db.db.auctionResult.resultByMatch.filter(matchId)];
      for (const agent of agents.filter(agent => agent.policy)) records.push({
        mode, kind: agent.kind, score: Number(participant(db, matchId, agent.id).score),
        tiles: results.filter(result => result.winnerBotId === agent.id).length, firstWord: agent.firstWord,
      });
    }
  }
  const summary = ["mixed-three-strong", "six-profile-selfplay"].flatMap(mode => kinds.map(kind => {
    const group = records.filter(row => row.mode === mode && row.kind === kind);
    const firsts = group.flatMap(row => row.firstWord === null ? [] : [row.firstWord]);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return { mode, kind, matches: group.length, meanScore: mean(group.map(row => row.score)),
      meanTilesWon: mean(group.map(row => row.tiles)), meanFirstWordSeconds: mean(firsts),
      calibrationTarget: "Public-inspired only; observe roughly 15–20s first word and 20–25 tiles for strong seats in mixed tables" };
  }));
  process.stdout.write(JSON.stringify({ opponentCalibration: summary, records }, null, 2) + "\n");
}, 180_000);
