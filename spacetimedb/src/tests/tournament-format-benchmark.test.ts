// Independent full-format experiment. No result here changes the failed
// six-player raw-score gate or authorizes production promotion.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTournament, myRack, registerForTournament, startNextFinalsMatch, startTournament, submitBid, submitWord } from "../index";
import type { Auction, TournamentMatch } from "../schema";
import { byStanding } from "../tournament";
import { DictionaryIndex as ProductionDictionary, LETTER_VALUE as PRODUCTION_LETTER_VALUE } from "../../../bot-starter/src/dictionary";
import { StrategyEngine as ProductionEngine } from "../../../bot-starter/src/strategy";
import { byBigint, call, client, currentAuction, emptyDb, getMatch, makeAdmin, NOW_MICROS, participant, setRack, teamWithBot, tick, type Test } from "./harness";
import { makeFaceBidCandidate } from "./fixtures/face-bid-ablation";
import { makeOpponent, type OpponentPolicy } from "./fixtures/opponent-policies";
import { makePublicFormulaOpponent, PUBLIC_POLICY_SOURCES } from "./fixtures/public-opponent-policies";
import { canSpell, DictionaryIndex, LETTER_VALUE, scoreWord } from "./fixtures/v1/dictionary";
import { StrategyEngine, type StrategyContext } from "./fixtures/v1/strategy";

type Variant = "A" | "B";
type Order = "A-first" | "balanced";
type Kind = "candidate" | "v1" | "premium-floor" | "linear-face" | "market-v1" | "market" | "starter" | "idle";
const OTHER_KINDS: readonly Kind[] = [
  ...Array<Kind>(6).fill("v1"), ...Array<Kind>(2).fill("premium-floor"), ...Array<Kind>(2).fill("linear-face"),
  ...Array<Kind>(2).fill("market-v1"), ...Array<Kind>(2).fill("market"), ...Array<Kind>(3).fill("starter"),
];
const ADMIN = "format-fixture-admin";
const SOURCE_PATHS = ["tournament-format-benchmark.test.ts", "harness.ts", "fixtures/v1/strategy.ts", "fixtures/v1/dictionary.ts", "fixtures/v1/optimizer.ts",
  "fixtures/opponent-policies.ts", "fixtures/public-opponent-policies.ts", "fixtures/face-bid-ablation.ts", "../index.ts", "../schema.ts", "../game.ts", "../tournament.ts", "../letters.ts", "../dictionary.ts",
  "../text.ts", "../identity.ts", "../ratings.ts", "../libm.ts", "../lobby.ts", "../../wordlist.txt", "../../package.json", "../../package-lock.json", "../../tsconfig.json", "../../vitest.config.ts",
  "../../../bot-starter/src/strategy.ts", "../../../bot-starter/src/dictionary.ts", "../../../bot-starter/src/optimizer.ts", "../../../bot-starter/src/strategy-worker.ts"];
const sourceHashes = () => Object.fromEntries(SOURCE_PATHS.map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
const wordlistText = readFileSync(new URL("../../wordlist.txt", import.meta.url), "utf8");
const words = wordlistText.split(/\s+/).map(word => word.toUpperCase()).filter(word => /^[A-Z]{2,}$/.test(word));
const starterWords = [...words].sort((a, b) => b.length - a.length);
let sharedFrozenIndex: DictionaryIndex | undefined;
let sharedProductionIndex: ProductionDictionary | undefined;
const dictionary = () => sharedFrozenIndex ??= new DictionaryIndex(words);
const productionDictionary = () => sharedProductionIndex ??= new ProductionDictionary(words);
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function latencySummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { decisions: values.length, decisionBudgetOverruns: values.filter(value => value > 100).length,
    meanMs: mean(values), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? null };
}
function seedFor(seed: number, phase: number): bigint {
  let mixed = BigInt.asUintN(64, BigInt(seed) + BigInt(phase) * 0x9e3779b97f4a7c15n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn);
  return mixed ^ (mixed >> 31n);
}
function executionOrderFor(position: number, mode: Order): readonly [Variant, Variant] {
  return mode === "balanced" && (position + Math.floor(position / 18)) % 2 === 1 ? ["B", "A"] : ["A", "B"];
}

function measuredPolicy(variant: Variant, index: ProductionDictionary): OpponentPolicy {
  // Match the validated production worker profile on BOTH measured sides.
  // Each bot owns its production optimizer across all matches; opponents stay frozen.
  const production = new ProductionEngine(index, {
    capitalAllowance: true, headsUpFaceBidWeight: 0.3, wordFirst: true,
  });
  return { decide(ctx) {
    const base = production.decide(ctx);
    // Word-first results deliberately have bid0 until the driver confirms the
    // word and fresh rack. Only B adds this positive-bid premium at larger tables.
    if (variant !== "B" || ctx.participantCount < 3 || ctx.auctionType !== "Vickrey"
      || ctx.bagTotal <= 1 || base.bid <= 0 || !/^[A-Z]$/.test(ctx.letter)) return base;
    const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
    return { ...base, bid: Math.min(balance, Math.ceil(base.bid * (1 + 0.1 * (PRODUCTION_LETTER_VALUE[ctx.letter]! - 1)))) };
  } };
}
function starterPolicy(): OpponentPolicy {
  const cache = new Map<string, string | null>();
  return { decide(ctx) {
    const started = performance.now();
    const key = [...ctx.myRack].sort(([a], [b]) => a.localeCompare(b)).map(([letter, count]) => `${letter}${count}`).join("");
    let word = cache.get(key);
    if (word === undefined) {
      let tiles = 0;
      for (const count of ctx.myRack.values()) tiles += count;
      word = starterWords.find(candidate => candidate.length <= tiles && canSpell(candidate, ctx.myRack)) ?? null;
      cache.set(key, word);
    }
    // Frozen original starter bid and longest-first dictionary word choice.
    const value = LETTER_VALUE[ctx.letter] ?? 1;
    const want = (ctx.myRack.get(ctx.letter) ?? 0) === 0 ? value + 2 : Math.max(1, value);
    return { bid: Math.min(want, Math.max(0, ctx.myBalance)), word, plan: word ? [word] : [],
      cashout: word ? scoreWord(word) : 0, exact: false, elapsedMs: performance.now() - started };
  } };
}
const idlePolicy = (): OpponentPolicy => ({ decide: () => ({ bid: 0, word: null, plan: [], cashout: 0, exact: true, elapsedMs: 0 }) });
function policyFor(kind: Kind, variant: Variant, index: DictionaryIndex): OpponentPolicy {
  switch (kind) {
    case "candidate": return measuredPolicy(variant, productionDictionary());
    case "v1": return new StrategyEngine(index, { capitalAllowance: true });
    case "premium-floor": case "linear-face": return makePublicFormulaOpponent(kind, index);
    case "market-v1": case "market": return makeOpponent(kind, index);
    case "starter": return starterPolicy();
    case "idle": return idlePolicy();
  }
}
type Player = { id: bigint; name: string; kind: Kind; policy: OpponentPolicy; latencyMs: number[] };
type Fixture = { db: Test; players: Player[]; tournamentId: bigint; measured: Player };
type MatchState = { link: TournamentMatch; slot: number; windows: number; latency: Map<bigint, number[]> };
type Hooks = {
  onMatchStart?: (fixture: Fixture, state: MatchState) => void;
  beforeWindow?: (fixture: Fixture, state: MatchState, auction: Auction) => void;
};

function createFixture(kinds: readonly Kind[], measuredPosition: number, policyFactory: (kind: Kind, position: number) => OpponentPolicy): Fixture {
  expect(kinds).toHaveLength(18);
  const db = emptyDb();
  makeAdmin(db, ADMIN);
  const players = kinds.map((kind, position): Player => {
    const name = `format-player-${position}`;
    return { id: teamWithBot(db, `format-owner-${position}`, name), name, kind,
      policy: policyFactory(kind, position), latencyMs: [] };
  });
  call(db, ADMIN, ctx => createTournament(ctx, { swissRoundsTotal: 4, topCut: 6, matchSize: 6, auctionType: { tag: "Vickrey" } }));
  const tournamentId = [...db.db.tournament.iter()][0]!.id;
  for (const player of players) call(db, player.name, ctx => registerForTournament(ctx, { tournamentId }));
  expect([...db.db.tournamentEntry.teByTournament.filter(tournamentId)]).toHaveLength(18);
  expect([...db.db.bot.iter()].every(bot => !bot.isSimulated)).toBe(true);
  return { db, players, tournamentId, measured: players[measuredPosition]! };
}
function ownRack(fixture: Fixture, matchId: bigint, player: Player): Map<string, number> {
  return new Map(myRack(fixture.db.viewContext(client(player.name)))
    .filter(tile => tile.matchId === matchId).map(tile => [tile.letter, tile.count]));
}
function tournament(fixture: Fixture) { return fixture.db.db.tournament.id.find(fixture.tournamentId)!; }

async function runTournament(fixture: Fixture, seed: number, hooks: Hooks = {}) {
  const { db, players, tournamentId, measured } = fixture;
  const byId = new Map(players.map(player => [player.id, player]));
  const states = new Map<bigint, MatchState>();
  let clockMicros = NOW_MICROS;
  let groups = 0;
  let ticks = 0;
  let maxTablesAtDeadline = 0;
  let manualFinalsStarts = 0;
  let swiss: { botId: bigint; kind: Kind; rank: number; points: number; score: number; qualified: boolean }[] | undefined;
  const groupSizes: Record<number, number> = {};
  db.rng.setSeed(seedFor(seed, 0));
  call(db, ADMIN, ctx => startTournament(ctx, { tournamentId }));
  expect(tournament(fixture).status.tag).toBe("Swiss");
  while (tournament(fixture).status.tag !== "Ended") {
    let links = [...db.db.tournamentMatch.tmByTournament.filter(tournamentId)];
    let running = links.filter(link => getMatch(db, link.matchId).status.tag === "Running");
    if (!running.length) {
      expect(["Bracket", "Final"]).toContain(tournament(fixture).status.tag);
      db.rng.setSeed(seedFor(seed, 40_000_000 + ++manualFinalsStarts));
      call(db, ADMIN, ctx => startNextFinalsMatch(ctx, { tournamentId }));
      links = [...db.db.tournamentMatch.tmByTournament.filter(tournamentId)];
      running = links.filter(link => getMatch(db, link.matchId).status.tag === "Running");
    }
    expect(running.length).toBeGreaterThan(0);
    for (const link of links) if (!states.has(link.matchId)) {
      const slot = [...states.values()].filter(state => state.link.phase.tag === link.phase.tag && state.link.round === link.round).length;
      const state: MatchState = { link, slot, windows: 0, latency: new Map() };
      states.set(link.matchId, state);
      const seated = [...db.db.matchParticipant.mpByMatch.filter(link.matchId)];
      expect(seated.every(row => byId.has(row.botId) && row.balance === 100n)).toBe(true);
      expect(getMatch(db, link.matchId).startingRackSize).toBe(5);
      hooks.onMatchStart?.(fixture, state);
    }
    const nextClose = running.map(link => currentAuction(db, link.matchId).closesAt)
      .sort((a, b) => byBigint(a.microsSinceUnixEpoch, b.microsSinceUnixEpoch))[0]!;
    const deadline = nextClose.microsSinceUnixEpoch;
    expect(deadline > clockMicros, "never rewind the multi-table clock or act at an expired close").toBe(true);
    const due = running.filter(link => currentAuction(db, link.matchId).closesAt.microsSinceUnixEpoch === deadline)
      .sort((a, b) => states.get(a.matchId)!.slot - states.get(b.matchId)!.slot);
    maxTablesAtDeadline = Math.max(maxTablesAtDeadline, due.length);
    groupSizes[due.length] = (groupSizes[due.length] ?? 0) + 1;
    // Finish words and bids for ALL due tables while the clock is still before
    // this deadline. Only then advance once and tick the precollected group.
    for (const link of due) {
      const state = states.get(link.matchId)!;
      const match = getMatch(db, link.matchId);
      const auction = currentAuction(db, link.matchId);
      hooks.beforeWindow?.(fixture, state, auction);
      const seated = [...db.db.matchParticipant.mpByMatch.filter(link.matchId)].map(row => byId.get(row.botId)!);
      const sales = [...db.db.auctionResult.resultByMatch.filter(link.matchId)].sort((a, b) =>
        byBigint(a.closedAt.microsSinceUnixEpoch, b.closedAt.microsSinceUnixEpoch));
      let price = 3;
      for (const sale of sales) if (sale.paid > 0n) price = 0.8 * price + 0.2 * Number(sale.paid);
      for (let dispatch = 0; dispatch < seated.length; dispatch++) {
        const player = seated[(dispatch + state.windows) % seated.length]!;
        let bid = 0;
        for (let actions = 0; ; actions++) {
          expect(getMatch(db, link.matchId).status.tag).toBe("Running");
          const balance = Number(participant(db, link.matchId, player.id).balance);
          const ctx: StrategyContext = { myRack: ownRack(fixture, link.matchId, player), myBalance: balance,
            letter: auction.letter, bagTotal: match.bagTotal, participantCount: seated.length,
            auctionType: match.auctionType.tag, estimatedPrice: price };
          const started = performance.now();
          const decision = player.policy.decide(ctx);
          const elapsed = performance.now() - started;
          player.latencyMs.push(elapsed);
          const latency = state.latency.get(player.id) ?? [];
          latency.push(elapsed); state.latency.set(player.id, latency);
          bid = decision.bid;
          expect(Number.isInteger(bid) && bid >= 0 && bid <= balance).toBe(true);
          if (!decision.word) break;
          if (actions >= 49) throw new Error("Word-first policy did not consume the rack");
          call(db, player.name, tx => submitWord(tx, { matchId: link.matchId, word: decision.word! }));
        }
        if (bid > 0 && match.bagTotal > 0) call(db, player.name, tx => submitBid(tx, { auctionId: auction.id, amount: BigInt(bid) }));
      }
    }
    db.clock.set(nextClose); clockMicros = deadline; groups++;
    for (const link of due) {
      const state = states.get(link.matchId)!;
      const phase = link.phase.tag === "Swiss" ? 1 : link.phase.tag === "Bracket" ? 2 : 3;
      db.rng.setSeed(seedFor(seed, phase * 10_000_000 + link.round * 100_000 + state.windows * 16 + state.slot));
      tick(db, link.matchId); state.windows++; ticks++;
      // A last Swiss tick may create the entire next round inside this reducer.
      // New matches are discovered next iteration, never ticked in this group.
    }
    if (!swiss && tournament(fixture).status.tag === "Bracket") {
      swiss = [...db.db.tournamentEntry.teByTournament.filter(tournamentId)].sort(byStanding)
        .map((entry, index) => ({ botId: entry.botId, kind: byId.get(entry.botId)!.kind, rank: index + 1,
          points: entry.swissPoints, score: Number(entry.totalScore), qualified: !entry.eliminated }));
    }
    if (groups > 2_000 || ticks > 4_000) throw new Error("Full-format tournament did not finish");
    // Keep Vitest's RPC replies responsive between complete simulated deadline
    // groups. This changes no database time, RNG seed or reducer/action order.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(swiss).toBeDefined();
  expect(swiss!.filter(entry => entry.qualified)).toHaveLength(6);
  const matches = [...states.values()].map(state => {
    const match = getMatch(db, state.link.matchId);
    const seated = [...db.db.matchParticipant.mpByMatch.filter(match.id)];
    const plays = [...db.db.wordPlay.playByMatch.filter(match.id)];
    const sales = [...db.db.auctionResult.resultByMatch.filter(match.id)].sort((a, b) =>
      byBigint(a.closedAt.microsSinceUnixEpoch, b.closedAt.microsSinceUnixEpoch));
    expect(match.status.tag).toBe("Ended");
    expect(state.windows).toBe(98 - 5 * seated.length);
    expect(plays.every(play => play.playedAt.microsSinceUnixEpoch < match.endedAt!.microsSinceUnixEpoch)).toBe(true);
    const rows = seated.map(row => {
      const rewards = plays.filter(play => play.botId === row.botId).reduce((sum, play) => sum + play.totalReward, 0n);
      const paid = sales.filter(sale => sale.winnerBotId === row.botId).reduce((sum, sale) => sum + sale.paid, 0n);
      expect(row.score).toBe(rewards); expect(row.balance).toBe(100n + rewards - paid);
      const ownPlays = plays.filter(play => play.botId === row.botId);
      const firstPlay = ownPlays.map(play => play.playedAt.microsSinceUnixEpoch).sort(byBigint)[0];
      return { botId: row.botId, kind: byId.get(row.botId)!.kind, score: Number(row.score),
        place: 1 + seated.filter(other => other.score > row.score).length, balance: Number(row.balance), spent: Number(paid),
        firstCashoutSeconds: firstPlay === undefined ? null : Number(firstPlay - match.createdAt.microsSinceUnixEpoch) / 1_000_000,
        wordCount: ownPlays.length, timing: latencySummary(state.latency.get(row.botId) ?? []) };
    });
    return { matchId: match.id, phase: state.link.phase.tag, round: state.link.round, tableSlot: state.slot,
      players: seated.length, windows: state.windows, durationSeconds: Number(match.endedAt!.microsSinceUnixEpoch - match.createdAt.microsSinceUnixEpoch) / 1_000_000,
      rows, finalTileAwarded: sales.at(-1)?.winnerBotId !== undefined };
  });
  const swissMatches = matches.filter(match => match.phase === "Swiss");
  expect(swissMatches).toHaveLength(12);
  expect(swissMatches.every(match => match.players === 6)).toBe(true);
  for (const round of [1, 2, 3, 4]) expect(swissMatches.filter(match => match.round === round)).toHaveLength(3);
  expect(matches.filter(match => match.phase === "Bracket").map(match => match.players)).toEqual([6, 5, 4, 3]);
  expect(matches.filter(match => match.phase === "Final").map(match => match.players)).toEqual([2, 2, 2]);
  expect(manualFinalsStarts).toBe(7);
  const entries = [...db.db.tournamentEntry.teByTournament.filter(tournamentId)];
  const finalists = entries.filter(entry => entry.finalFinishPosition !== undefined && entry.finalFinishPosition <= 2)
    .map(entry => ({ botId: entry.botId, kind: byId.get(entry.botId)!.kind, totalScore: Number(entry.totalScore),
      aggregateFinalScore: matches.filter(match => match.phase === "Final").reduce((sum, match) => sum + (match.rows.find(row => row.botId === entry.botId)?.score ?? 0), 0) }))
    .sort((a, b) => b.aggregateFinalScore - a.aggregateFinalScore || b.totalScore - a.totalScore || byBigint(a.botId, b.botId));
  expect(tournament(fixture).winnerBotId).toBe(finalists[0]!.botId);
  const measuredSwiss = swiss!.find(entry => entry.botId === measured.id)!;
  const measuredEntry = entries.find(entry => entry.botId === measured.id)!;
  const measuredMatches = matches.flatMap(match => {
    const row = match.rows.find(player => player.botId === measured.id);
    return row ? [{ ...match, rows: undefined, measured: row, opponentKinds: match.rows.filter(player => player.botId !== measured.id).map(player => player.kind) }] : [];
  });
  return { seed, measuredPosition: players.indexOf(measured), measuredBotId: measured.id,
    qualified: measuredSwiss.qualified, crowned: tournament(fixture).winnerBotId === measured.id,
    swissPoints: measuredSwiss.points, swissRank: measuredSwiss.rank, swissScore: measuredSwiss.score,
    meanSwissMatchPlace: mean(measuredMatches.filter(match => match.phase === "Swiss").map(match => match.measured.place)),
    serverFinalFinishPosition: measuredEntry.finalFinishPosition ?? null,
    derivedOverallPlace: measuredEntry.finalFinishPosition ?? measuredSwiss.rank,
    tournamentScore: Number(measuredEntry.totalScore),
    finalAggregateScore: finalists.find(player => player.botId === measured.id)?.aggregateFinalScore ?? null,
    finalOpponentKind: finalists.some(player => player.botId === measured.id) ? finalists.find(player => player.botId !== measured.id)!.kind : null,
    winner: finalists[0], finalists, swissStandings: swiss,
    measuredTiming: latencySummary(measured.latencyMs), allEntrantTiming: latencySummary(players.flatMap(player => player.latencyMs)),
    timingByKind: Object.fromEntries([...new Set(players.map(player => player.kind))].map(kind => [kind, latencySummary(players.filter(player => player.kind === kind).flatMap(player => player.latencyMs))])),
    audit: { externalEntrants: players.length, groups, ticks, maxTablesAtDeadline, groupSizes, manualFinalsStarts,
      clockRegressions: 0, postTerminalActions: 0, simulatedDurationSeconds: Number(clockMicros - NOW_MICROS) / 1_000_000 },
    measuredMatches, matches };
}

test("production word-first A/B retain exact effective face bids at their predeclared table sizes", () => {
  const index = new DictionaryIndex(["AT", "QAT"]);
  const productionIndex = new ProductionDictionary(["AT", "QAT"]);
  const policies = { A: measuredPolicy("A", productionIndex), B: measuredPolicy("B", productionIndex) };
  const core = new StrategyEngine(index, { capitalAllowance: true });
  const face01 = makeFaceBidCandidate(index, 0.1);
  const face03 = makeFaceBidCandidate(index, 0.3);
  for (const participantCount of [2, 3, 4, 5, 6]) for (const bagTotal of [60, 1, 0]) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      const ctx: StrategyContext = { myRack: new Map([["A", 1], ["T", 1]]), letter: "Q", myBalance: 100,
        participantCount, bagTotal, auctionType, estimatedPrice: 8 };
      for (const variant of ["A", "B"] as const) {
        const expected = participantCount === 2 && auctionType === "Vickrey" ? face03.decide(ctx)
          : variant === "B" && participantCount >= 3 && auctionType === "Vickrey" ? face01.decide(ctx) : core.decide(ctx);
        const actual = policies[variant].decide(ctx);
        // The reliable word-first driver never sends the obsolete pre-cashout
        // bid. Preserve every legacy decision field, with explicit wire-bid0.
        expect({ ...actual, elapsedMs: 0 }).toEqual({ ...expected, bid: expected.word ? 0 : expected.bid, elapsedMs: 0 });
      }
    }
  }
});

test("word-first production bids reprice from the acknowledged rack and reward rather than the spent word", () => {
  const index = new DictionaryIndex(["AT", "QAT"]);
  const productionIndex = new ProductionDictionary(["AT", "QAT"]);
  for (const variant of ["A", "B"] as const) for (const participantCount of [2, 6]) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) for (const bagTotal of [60, 1, 0]) {
      const policy = measuredPolicy(variant, productionIndex);
      const oracle = participantCount === 2 && auctionType === "Vickrey" ? makeFaceBidCandidate(index, 0.3)
        : variant === "B" && participantCount >= 3 && auctionType === "Vickrey" ? makeFaceBidCandidate(index, 0.1)
        : new StrategyEngine(index, { capitalAllowance: true });
      const ctx: StrategyContext = { myRack: new Map([["A", 1], ["T", 1]]), letter: "Q", myBalance: 5,
        participantCount, auctionType, bagTotal, estimatedPrice: 8 };
      const word = policy.decide(ctx);
      expect(word.word).toBe("AT"); expect(word.bid).toBe(0);
      const freshRack = new Map(ctx.myRack);
      for (const letter of word.word!) {
        const left = freshRack.get(letter)! - 1;
        if (left) freshRack.set(letter, left); else freshRack.delete(letter);
      }
      // The real tournament driver obtains these changes from actual reducers;
      // this small pure check makes the effective wire-bid contract explicit.
      const fresh = { ...ctx, myRack: freshRack, myBalance: ctx.myBalance + scoreWord(word.word!) };
      const actual = policy.decide(fresh), expected = oracle.decide(fresh);
      expect(actual.word).toBeNull();
      expect({ ...actual, elapsedMs: 0 }).toEqual({ ...expected, elapsedMs: 0 });
      expect(Number.isInteger(actual.bid) && actual.bid >= 0 && actual.bid <= fresh.myBalance).toBe(true);
      if (bagTotal === 0) expect(actual.bid).toBe(0);
      if (bagTotal === 60) expect(actual.bid).toBeGreaterThan(0);
    }
  }
});

test("balanced sequential order reverses each candidate position on its second rotation", () => {
  for (let position = 0; position < 36; position++) expect(executionOrderFor(position, "A-first")).toEqual(["A", "B"]);
  const firstRotation = Array.from({ length: 18 }, (_, position) => executionOrderFor(position, "balanced"));
  const secondRotation = Array.from({ length: 18 }, (_, position) => executionOrderFor(position + 18, "balanced"));
  expect(firstRotation.filter(order => order[0] === "A")).toHaveLength(9);
  expect(secondRotation.filter(order => order[0] === "A")).toHaveLength(9);
  for (let position = 0; position < 18; position++) expect(secondRotation[position]).toEqual([...firstRotation[position]!].reverse());
});

test("18 idle external entrants complete actual four-round Swiss, top-six cut and seven finals starts on a grouped monotone clock", async () => {
  const fixture = createFixture(Array<Kind>(18).fill("idle"), 17, () => idlePolicy());
  const result = await runTournament(fixture, 7_000_001);
  expect(result.audit).toMatchObject({ groups: 838, ticks: 1382, maxTablesAtDeadline: 3, manualFinalsStarts: 7, clockRegressions: 0, postTerminalActions: 0 });
  expect(result.audit.groupSizes[3]).toBe(68 * 4);
  expect(result.swissStandings.every(row => row.points === 24 && row.score === 0)).toBe(true);
  const lowest = fixture.players.map(player => player.id).sort(byBigint);
  expect(result.swissStandings.filter(row => row.qualified).map(row => row.botId)).toEqual(lowest.slice(0, 6));
  expect(result.winner.botId).toBe(lowest[0]);
  expect(result.qualified).toBe(false);
  expect(result.serverFinalFinishPosition).toBeNull();
  expect(result.derivedOverallPlace).toBe(18);
});

test("actual words break Swiss ties, reach the crown, and an awarded final tile remains unplayed after the final tick", async () => {
  let desiredWord = "AT";
  const controlled: OpponentPolicy = { decide: ctx => ({ bid: 0, word: canSpell(desiredWord, ctx.myRack) ? desiredWord : null,
    plan: [], cashout: 0, exact: true, elapsedMs: 0 }) };
  const fixture = createFixture(Array<Kind>(18).fill("idle"), 17, (_kind, position) => position === 17 ? controlled : idlePolicy());
  let terminal: { matchId: bigint; word: string; auctionId: bigint } | undefined;
  const result = await runTournament(fixture, 7_000_002, {
    onMatchStart({ db, measured }, state) {
      if (![...db.db.matchParticipant.mpByMatch.filter(state.link.matchId)].some(row => row.botId === measured.id)) return;
      desiredWord = "AT"; setRack(db, state.link.matchId, measured.id, "AT");
    },
    beforeWindow(current, state, auction) {
      if (terminal || state.link.phase.tag !== "Swiss" || getMatch(current.db, state.link.matchId).bagTotal !== 0
        || ![...current.db.db.matchParticipant.mpByMatch.filter(state.link.matchId)].some(row => row.botId === current.measured.id)) return;
      desiredWord = words.find(word => word.length >= 7 && word.includes(auction.letter))!;
      setRack(current.db, state.link.matchId, current.measured.id, desiredWord.replace(auction.letter, ""));
      call(current.db, current.measured.name, ctx => submitBid(ctx, { auctionId: auction.id, amount: 1n }));
      terminal = { matchId: state.link.matchId, word: desiredWord, auctionId: auction.id };
    },
  });
  expect(result.qualified).toBe(true); expect(result.swissRank).toBe(1); expect(result.swissPoints).toBe(24);
  expect(result.swissScore).toBe(8); expect(result.crowned).toBe(true); expect(result.finalAggregateScore).toBe(6);
  expect(terminal).toBeDefined();
  const sale = [...fixture.db.db.auctionResult.resultByMatch.filter(terminal!.matchId)].find(row => row.auctionId === terminal!.auctionId)!;
  expect(sale.winnerBotId).toBe(fixture.measured.id);
  expect(canSpell(terminal!.word, ownRack(fixture, terminal!.matchId, fixture.measured))).toBe(true);
  expect([...fixture.db.db.wordPlay.playByMatch.filter(terminal!.matchId)].map(play => play.word)).toEqual(["AT"]);
  expect(result.audit.postTerminalActions).toBe(0);
});

type Run = Awaited<ReturnType<typeof runTournament>>;
function summarize(runs: Run[]) {
  const decisions = runs.reduce((sum, run) => sum + run.measuredTiming.decisions, 0);
  const overruns = runs.reduce((sum, run) => sum + run.measuredTiming.decisionBudgetOverruns, 0);
  return { tournaments: runs.length, topCutRate: mean(runs.map(run => Number(run.qualified))), crownRate: mean(runs.map(run => Number(run.crowned))),
    meanSwissPoints: mean(runs.map(run => run.swissPoints)), meanSwissRank: mean(runs.map(run => run.swissRank)),
    meanSwissScore: mean(runs.map(run => run.swissScore)), meanSwissMatchPlace: mean(runs.map(run => run.meanSwissMatchPlace!)),
    meanDerivedOverallPlace: mean(runs.map(run => run.derivedOverallPlace)), meanTournamentScore: mean(runs.map(run => run.tournamentScore)),
    finalsAppearances: runs.filter(run => run.finalAggregateScore !== null).length,
    meanFinalAggregateScoreConditionalOnReachingFinal: mean(runs.flatMap(run => run.finalAggregateScore === null ? [] : [run.finalAggregateScore])),
    decisions, decisionBudgetOverruns: overruns, decisionBudgetOverrunRate: decisions ? overruns / decisions : null,
    allEntrantDecisionBudgetOverruns: runs.reduce((sum, run) => sum + run.allEntrantTiming.decisionBudgetOverruns, 0),
    maxDecisionMs: Math.max(...runs.map(run => run.measuredTiming.maxMs ?? 0)),
    winnerKinds: Object.fromEntries([...new Set(runs.map(run => run.winner.kind))].map(kind => [kind, runs.filter(run => run.winner.kind === kind).length])),
    finalOpponentKinds: Object.fromEntries([...new Set(runs.flatMap(run => run.finalOpponentKind ? [run.finalOpponentKind] : []))].map(kind => [kind, runs.filter(run => run.finalOpponentKind === kind).length])) };
}

test.skipIf(process.env.BOT_TOURNAMENT_FORMAT_BENCHMARK !== "1")("independent full-format paired A/B tournament evaluation", async () => {
  const count = Number(process.env.BOT_TOURNAMENT_FORMAT_BENCHMARK_SEEDS ?? 6);
  const offset = Number(process.env.BOT_TOURNAMENT_FORMAT_BENCHMARK_SEED_OFFSET ?? 700);
  if (!Number.isInteger(count) || count < 1 || count > 36) throw new Error("Use 1–36 full-format seeds");
  if (!Number.isSafeInteger(offset) || offset < 700) throw new Error("Use a new full-format seed offset >=700");
  const order = process.env.BOT_TOURNAMENT_FORMAT_BENCHMARK_ORDER ?? "A-first";
  if (order !== "A-first" && order !== "balanced") throw new Error("Use full-format execution order A-first or balanced");
  const destination = process.env.BOT_TOURNAMENT_FORMAT_BENCHMARK_REPORT;
  if (destination && existsSync(destination)) throw new Error("Refusing to overwrite a full-format report");
  const initialSourceHashes = sourceHashes();
  const startedAt = new Date().toISOString();
  const index = dictionary();
  const pairs: { seed: number; position: number; executionOrder: readonly [Variant, Variant]; A: Run; B: Run }[] = [];
  for (let position = 0; position < count; position++) {
    const seed = 10_001 + (offset + position) * 7_919;
    const measuredPosition = position % 18;
    const kinds = [...OTHER_KINDS]; kinds.splice(measuredPosition, 0, "candidate");
    const run = (variant: Variant) => runTournament(createFixture(kinds, measuredPosition, kind => policyFor(kind, variant, index)), seed);
    const executionOrder = executionOrderFor(position, order);
    const first = await run(executionOrder[0]); const second = await run(executionOrder[1]);
    const [A, B] = executionOrder[0] === "A" ? [first, second] : [second, first];
    pairs.push({ seed, position: measuredPosition, executionOrder, A, B });
    process.stdout.write(JSON.stringify({ formatProgress: position + 1, total: count, seed, measuredPosition, executionOrder,
      A: { topCut: A.qualified, crown: A.crowned, swissPoints: A.swissPoints, swissRank: A.swissRank },
      B: { topCut: B.qualified, crown: B.crowned, swissPoints: B.swissPoints, swissRank: B.swissRank } }) + "\n");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(sourceHashes(), "Full-format sources changed during evaluation").toEqual(initialSourceHashes);
  const report = { startedAt, generatedAt: new Date().toISOString(), modulePin: "b5ccb36aa238ad16692f8d6af54da15ef9f11324",
    frozenV1Pin: "f4569e067a1d6fafcdc773d525268856f6d1542a", dictionarySha256: createHash("sha256").update(wordlistText).digest("hex"),
    sourceHashes: initialSourceHashes, sourceFingerprintSha256: createHash("sha256").update(JSON.stringify(initialSourceHashes)).digest("hex"),
    methodology: { entrants: 18, externalOnly: true, swissRounds: 4, tableSize: 6, topCut: 6, auctionType: "Vickrey", startingRack: 5, startingBalance: 100,
      variantA: "Actual production engine with capitalAllowance=true, headsUpFaceBidWeight=0.3, wordFirst=true; no additional larger-table premium",
      variantB: "Same production engine/options as A; only positive nonterminal N>=3 Vickrey bids receive the extra face.1 final transform",
      opponents: OTHER_KINDS, publicFormulaSources: PUBLIC_POLICY_SOURCES,
      opponentCaveat: "Public-data-inspired stress archetypes, not reconstructions of actual rivals. Three original starters use the same reliable external driver.",
      setup: "Actual team/credential creation, registration, start, all Swiss, top cut, elimination and three-game final/crown reducers. No phase or status shortcuts.",
      lifecycle: "One owned optimizer per bot across all matches. Measured A/B use a shared immutable ProductionDictionary; all17 opponents retain the separate shared FrozenDictionary and frozen policies. Both indexes use official wordlist order; only starters have a longest-first copy. Fresh policies/database per paired variant/tournament.",
      inputs: "Own authenticated myRack only; public balances/auction/history; actual per-table participant count, including 6,5,4,3,2.",
      scheduler: "Words/bids for every table in the next common closing group finish before advancing the clock once. Only precollected due tables tick; automatic next Swiss deals remain inside the final prior-round reducer. Event loop yields only after each completed deadline group, without changing simulated time or RNG/action order.",
      rng: "Seed before initial start, each actual phase/round/table-slot/window tick, and each required manual finals start. Later RNG tile streams can diverge between A/B as actions change.",
      measuredPosition: "Rotates position%18 within each batch; same seed and position across A/B. A six-seed pilot covers only positions0–5;18/36-seed batches cover all positions once/twice.", seedOffset: offset,
      executionOrder: { mode: order, rule: "A-first always runs A then B. Balanced runs B first iff(i+floor(i/18))%2===1, reversing each candidate position's order at i+18. Variants execute sequentially." },
      scoreAndPlace: "Swiss rank captured at cut before later scores; non-cut overall place derived from Swiss rank, serverFinalFinishPosition remains null. Crown uses three final scores, then whole-tournament total, then lower id.",
      terminal: "All entrants external; existing rack may cash before last close, no policy/action after final award. bagTotal0 bids suppressed by driver.",
      timing: "Actual production wordFirst=true decision profile on both measured sides: return word/bid0 before augmented search, then reprice after confirmed reducer/rack changes. Synchronous wall time >100ms remains the offline guard, separate from production 150ms IPC/transport gate.",
      limitations: "Fixed archetype mix and finite paired sample do not prove live tournament strength. Word-first skips augmented-cache work and can change later approximate solves, so both measured sides use the same production profile. Wall-clock bounded searches can differ near deadlines. Opponents remain frozen; no worker/network tests here.",
      promotion: "Report only; independent format experiment. The failed six-player primary score gate remains unchanged; criteria and confirmation must be separately predeclared." },
    summaries: { A: summarize(pairs.map(pair => pair.A)), B: summarize(pairs.map(pair => pair.B)) },
    pairedOutcomes: { topCutImproved: pairs.filter(pair => pair.B.qualified && !pair.A.qualified).length,
      topCutRegressed: pairs.filter(pair => pair.A.qualified && !pair.B.qualified).length,
      crownImproved: pairs.filter(pair => pair.B.crowned && !pair.A.crowned).length,
      crownRegressed: pairs.filter(pair => pair.A.crowned && !pair.B.crowned).length,
      meanSwissPointsDifference: mean(pairs.map(pair => pair.B.swissPoints - pair.A.swissPoints)),
      meanSwissRankDifference: mean(pairs.map(pair => pair.B.swissRank - pair.A.swissRank)) },
    pairs, productionPromotionAuthorized: false };
  if (destination) writeFileSync(destination, JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ fullFormatBenchmark: report.summaries, pairedOutcomes: report.pairedOutcomes }, null, 2) + "\n");
}, 7_200_000);
