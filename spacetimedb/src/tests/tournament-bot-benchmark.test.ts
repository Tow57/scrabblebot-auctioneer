// Two-player, three-game finals isolation. Opt in explicitly; this is not part
// of the locked six-player holdout and contains no automatic promotion gate.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTournament, myRack, registerForTournament, startNextFinalsMatch, submitBid, submitWord } from "../index";
import { call, client, currentAuction, emptyDb, getMatch, makeAdmin, participant, runToEnd, setRack, teamWithBot, tick, type Test } from "./harness";
import { DictionaryIndex } from "./fixtures/v1/dictionary";
import { StrategyEngine as FrozenV1, type StrategyContext, type StrategyDecision } from "./fixtures/v1/strategy";
import { makeFaceBidCandidate } from "./fixtures/face-bid-ablation";
import { makeQualityFaceCandidate } from "./fixtures/quality-face-ablation";

type Policy = { decide(ctx: StrategyContext): StrategyDecision };
type CandidateId = "face-0.1" | "face-0.3" | "quality-face-m2-w0.5";
const CANDIDATES: readonly CandidateId[] = ["face-0.1", "face-0.3", "quality-face-m2-w0.5"];
const ADMIN = "finals-fixture-admin";
const wordlistText = readFileSync(new URL("../../wordlist.txt", import.meta.url), "utf8");
let officialIndex: DictionaryIndex | undefined;
function dictionary(): DictionaryIndex {
  return officialIndex ??= new DictionaryIndex(wordlistText.split(/\s+/).filter(word => word.length >= 2));
}
function makeCandidate(id: CandidateId, index: DictionaryIndex): Policy {
  if (id === "quality-face-m2-w0.5") return makeQualityFaceCandidate(index, 0.5, 2);
  return makeFaceBidCandidate(index, id === "face-0.1" ? 0.1 : 0.3);
}

type Player = { id: bigint; name: string; policy: Policy };
type GameResult = {
  game: number;
  score: number;
  opponentScore: number;
  place: number;
  auctionWindows: number;
  firstCashoutSeconds: number | null;
  decisions: number;
  decisionBudgetOverruns: number;
  latencyMs: number[];
};
type SeriesResult = {
  seed: number;
  candidateSeat: number;
  aggregateScore: number;
  opponentAggregateScore: number;
  aggregateMargin: number;
  aggregateTie: boolean;
  wonServerCrown: boolean;
  finalPlace: number;
  games: GameResult[];
};

function seedFor(seed: number, phase: number): bigint {
  let mixed = BigInt.asUintN(64, BigInt(seed) + BigInt(phase) * 0x9e3779b97f4a7c15n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn);
  return mixed ^ (mixed >> 31n);
}

function finalsFixture(policies: readonly [Policy, Policy]) {
  const db = emptyDb();
  makeAdmin(db, ADMIN);
  const players: Player[] = policies.map((policy, seat) => ({
    name: `finalist-${seat}`,
    id: teamWithBot(db, `finalist-owner-${seat}`, `finalist-${seat}`),
    policy,
  }));
  call(db, ADMIN, ctx => createTournament(ctx, {
    swissRoundsTotal: 1, topCut: 2, matchSize: 2, auctionType: { tag: "Vickrey" },
  }));
  const tournament = [...db.db.tournament.iter()][0]!;
  for (const player of players) call(db, player.name, ctx => registerForTournament(ctx, { tournamentId: tournament.id }));
  // Isolate the finals after a hypothetical equal-scoring Swiss. This is the
  // ONLY phase shortcut: actual start/auction/word/end/crown reducers run below.
  db.db.tournament.id.update({ ...tournament, status: { tag: "Final" }, currentRound: 0 });
  return { db, players, tournamentId: tournament.id };
}

function ownRack(db: Test, matchId: bigint, player: Player): Map<string, number> {
  return new Map(myRack(db.viewContext(client(player.name)))
    .filter(tile => tile.matchId === matchId).map(tile => [tile.letter, tile.count]));
}

function playGame(db: Test, tournamentId: bigint, players: Player[], measuredSeat: number, seed: number, game: number): GameResult {
  db.rng.setSeed(seedFor(seed, game * 1000));
  call(db, ADMIN, ctx => startNextFinalsMatch(ctx, { tournamentId }));
  const link = [...db.db.tournamentMatch.tmByTournament.filter(tournamentId)]
    .find(row => row.phase.tag === "Final" && row.round === game)!;
  expect(link, "actual finals reducer must create the game").toBeDefined();
  const matchId = link.matchId;
  const measured = players[measuredSeat]!;
  const other = players[1 - measuredSeat]!;
  const result: GameResult = { game, score: 0, opponentScore: 0, place: 0, auctionWindows: 0,
    firstCashoutSeconds: null, decisions: 0, decisionBudgetOverruns: 0, latencyMs: [] };
  expect(getMatch(db, matchId).startingRackSize).toBe(5);
  expect([...db.db.matchParticipant.mpByMatch.filter(matchId)]).toHaveLength(2);
  for (const player of players) expect(participant(db, matchId, player.id).balance).toBe(100n);
  while (getMatch(db, matchId).status.tag === "Running") {
    const auction = currentAuction(db, matchId);
    const match = getMatch(db, matchId);
    const history = [...db.db.auctionResult.resultByMatch.filter(matchId)].sort((a, b) =>
      a.closedAt.microsSinceUnixEpoch < b.closedAt.microsSinceUnixEpoch ? -1
        : a.closedAt.microsSinceUnixEpoch > b.closedAt.microsSinceUnixEpoch ? 1 : 0);
    let price = 3;
    for (const sale of history) if (sale.paid > 0n) price = price * 0.8 + Number(sale.paid) * 0.2;
    // Both sides use the same reliable word-first driver. Rotate dispatch
    // order; sealed bids never reveal pending opposing amounts to a policy.
    for (let offset = 0; offset < 2; offset++) {
      const player = players[(offset + result.auctionWindows) % 2]!;
      let bid = 0;
      for (let actions = 0; ; actions++) {
        const rack = ownRack(db, matchId, player);
        const balance = Number(participant(db, matchId, player.id).balance);
        const started = performance.now();
        const decision = player.policy.decide({ myRack: rack, myBalance: balance, letter: auction.letter,
          bagTotal: match.bagTotal, participantCount: players.length,
          auctionType: match.auctionType.tag, estimatedPrice: price });
        const elapsed = performance.now() - started;
        if (player === measured) {
          result.decisions++;
          result.latencyMs.push(elapsed);
          if (elapsed > 100) result.decisionBudgetOverruns++;
        }
        bid = decision.bid;
        expect(Number.isFinite(bid) && Number.isInteger(bid) && bid >= 0 && bid <= balance).toBe(true);
        if (!decision.word) break;
        if (actions >= 49) throw new Error("Finals cashout loop did not consume the rack");
        call(db, player.name, ctx => submitWord(ctx, { matchId, word: decision.word! }));
        if (player === measured) result.firstCashoutSeconds ??= result.auctionWindows * Number(match.auctionDurationMs) / 1000;
      }
      if (bid > 0 && match.bagTotal > 0) call(db, player.name, ctx => submitBid(ctx, { auctionId: auction.id, amount: BigInt(bid) }));
    }
    db.clock.set(auction.closesAt);
    db.rng.setSeed(seedFor(seed, game * 1000 + result.auctionWindows + 1));
    tick(db, matchId);
    if (++result.auctionWindows > 98) throw new Error("Finals bag did not empty");
  }
  // A two-player initial deal removes ten tiles: 88 auction windows, including
  // the unusable last award. No word call is made after the final tick.
  expect(result.auctionWindows).toBe(88);
  for (const player of players) {
    const current = participant(db, matchId, player.id);
    const spent = [...db.db.auctionResult.resultByMatch.filter(matchId)]
      .filter(sale => sale.winnerBotId === player.id).reduce((sum, sale) => sum + sale.paid, 0n);
    const rewards = [...db.db.wordPlay.playByMatch.filter(matchId)]
      .filter(play => play.botId === player.id).reduce((sum, play) => sum + play.totalReward, 0n);
    expect(current.score).toBe(rewards);
    expect(current.balance).toBe(100n + rewards - spent);
  }
  result.score = Number(participant(db, matchId, measured.id).score);
  result.opponentScore = Number(participant(db, matchId, other.id).score);
  result.place = result.score >= result.opponentScore ? 1 : 2;
  return result;
}

function playSeries(seed: number, measuredSeat: number, policies: readonly [Policy, Policy]): SeriesResult {
  const { db, players, tournamentId } = finalsFixture(policies);
  const games = Array.from({ length: 3 }, (_, index) => playGame(db, tournamentId, players, measuredSeat, seed, index + 1));
  const aggregateScore = games.reduce((sum, game) => sum + game.score, 0);
  const opponentAggregateScore = games.reduce((sum, game) => sum + game.opponentScore, 0);
  const crown = db.db.tournament.id.find(tournamentId)!;
  expect(crown.status.tag).toBe("Ended");
  const finalLinks = [...db.db.tournamentMatch.tmByTournament.filter(tournamentId)];
  expect(finalLinks).toHaveLength(3);
  expect(finalLinks.every(link => link.phase.tag === "Final")).toBe(true);
  const expectedWinner = aggregateScore > opponentAggregateScore ? players[measuredSeat]!.id
    : aggregateScore < opponentAggregateScore ? players[1 - measuredSeat]!.id
    : players.reduce((lower, player) => player.id < lower ? player.id : lower, players[0]!.id);
  expect(crown.winnerBotId).toBe(expectedWinner);
  const wonServerCrown = crown.winnerBotId === players[measuredSeat]!.id;
  return { seed, candidateSeat: measuredSeat, aggregateScore, opponentAggregateScore,
    aggregateMargin: aggregateScore - opponentAggregateScore, aggregateTie: aggregateScore === opponentAggregateScore,
    wonServerCrown, finalPlace: wonServerCrown ? 1 : 2, games };
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function summarize(series: SeriesResult[]) {
  const games = series.flatMap(row => row.games);
  const firstCashouts = games.flatMap(row => row.firstCashoutSeconds === null ? [] : [row.firstCashoutSeconds]);
  const latency = games.flatMap(row => row.latencyMs).sort((a, b) => a - b);
  const percentile = (fraction: number) => latency[Math.min(latency.length - 1, Math.ceil(latency.length * fraction) - 1)] ?? 0;
  return { series: series.length, games: games.length,
    threeGameAggregateWinRate: mean(series.map(row => Number(row.wonServerCrown))),
    strictAggregateWinRate: mean(series.map(row => Number(row.aggregateMargin > 0))),
    aggregateTieRate: mean(series.map(row => Number(row.aggregateTie))),
    meanThreeGameScore: mean(series.map(row => row.aggregateScore)),
    meanOpponentThreeGameScore: mean(series.map(row => row.opponentAggregateScore)),
    meanAggregateMargin: mean(series.map(row => row.aggregateMargin)),
    meanFinalPlace: mean(series.map(row => row.finalPlace)),
    meanGamePlace: mean(games.map(row => row.place)),
    meanFirstCashoutSeconds: firstCashouts.length ? mean(firstCashouts) : null,
    noCashoutRate: games.filter(row => row.firstCashoutSeconds === null).length / games.length,
    decisionBudgetOverruns: games.reduce((sum, row) => sum + row.decisionBudgetOverruns, 0),
    decisions: games.reduce((sum, row) => sum + row.decisions, 0),
    latencyMs: { mean: mean(latency), p95: percentile(0.95), p99: percentile(0.99), max: latency.at(-1) ?? 0 },
  };
}

test("finals driver uses actual three-game crown rules and two-player contexts", () => {
  let contexts = 0;
  const idle: Policy = { decide: ctx => {
    expect(ctx.participantCount).toBe(2); contexts++;
    return { bid: 0, word: null, plan: [], cashout: 0, exact: true, elapsedMs: 0 };
  } };
  const result = playSeries(2_400_001, 1, [idle, idle]);
  expect(contexts).toBe(88 * 2 * 3);
  expect(result.aggregateTie).toBe(true);
  expect(result.wonServerCrown).toBe(false); // equal prior totals -> lower bot id
  expect(result.games.every(game => game.auctionWindows === 88 && game.score === 0)).toBe(true);
  expect(summarize([result]).meanFirstCashoutSeconds).toBeNull();
  expect(summarize([result]).noCashoutRate).toBe(1);
});

test("the actual final crown follows aggregate score instead of games won", () => {
  const idle: Policy = { decide: () => ({ bid: 0, word: null, plan: [], cashout: 0, exact: true, elapsedMs: 0 }) };
  const { db, players, tournamentId } = finalsFixture([idle, idle]);
  for (let game = 1; game <= 3; game++) {
    call(db, ADMIN, ctx => startNextFinalsMatch(ctx, { tournamentId }));
    const link = [...db.db.tournamentMatch.tmByTournament.filter(tournamentId)].find(row => row.round === game)!;
    const scorer = players[game < 3 ? 0 : 1]!;
    const word = game < 3 ? "CAT" : "QUARTER";
    // Controlled word racks isolate the server's finals aggregation contract.
    setRack(db, link.matchId, scorer.id, word);
    call(db, scorer.name, ctx => submitWord(ctx, { matchId: link.matchId, word }));
    expect(runToEnd(db, link.matchId)).toBe(88);
  }
  // Player 0 wins two games 5–0, player 1 wins one 48–0 and the final 48–10.
  const entries = [...db.db.tournamentEntry.teByTournament.filter(tournamentId)];
  expect(entries.find(entry => entry.botId === players[0]!.id)!.totalScore).toBe(10n);
  expect(entries.find(entry => entry.botId === players[1]!.id)!.totalScore).toBe(48n);
  expect(db.db.tournament.id.find(tournamentId)!.winnerBotId).toBe(players[1]!.id);
});

test.skipIf(process.env.BOT_TOURNAMENT_BENCHMARK !== "1")("two-player three-game aggregate candidate versus frozen-v1 benchmark", async () => {
  const count = Number(process.env.BOT_TOURNAMENT_BENCHMARK_SEEDS ?? 30);
  const offset = Number(process.env.BOT_TOURNAMENT_BENCHMARK_SEED_OFFSET ?? 300);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("Use 1–30 finals-series seeds");
  if (!Number.isSafeInteger(offset) || offset < 300) throw new Error("Use an unseen finals seed offset >=300");
  const selected = process.env.BOT_TOURNAMENT_BENCHMARK_CANDIDATE ?? "all";
  if (selected !== "all" && !CANDIDATES.includes(selected as CandidateId)) throw new Error("Unknown finals candidate");
  const destination = process.env.BOT_TOURNAMENT_BENCHMARK_REPORT;
  if (destination && existsSync(destination)) throw new Error("Refusing to overwrite a finals benchmark report");
  const index = dictionary();
  const seeds = Array.from({ length: count }, (_, position) => 10_001 + (offset + position) * 7_919);
  const results = [];
  for (const id of selected === "all" ? CANDIDATES : [selected as CandidateId]) {
    const control: SeriesResult[] = [];
    const candidate: SeriesResult[] = [];
    for (const [position, seed] of seeds.entries()) {
      const seat = position % 2;
      control.push(playSeries(seed, seat, [new FrozenV1(index, { capitalAllowance: true }), new FrozenV1(index, { capitalAllowance: true })]));
      const policies: [Policy, Policy] = [new FrozenV1(index, { capitalAllowance: true }), new FrozenV1(index, { capitalAllowance: true })];
      policies[seat] = makeCandidate(id, index);
      candidate.push(playSeries(seed, seat, policies));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const stripTiming = (row: SeriesResult) => ({ ...row, games: row.games.map(game => ({ ...game, latencyMs: undefined })) });
    results.push({ id, candidate: summarize(candidate), baseline: summarize(control),
      pairedMeanAggregateMarginDifference: mean(candidate.map((row, position) => row.aggregateMargin - control[position]!.aggregateMargin)),
      samples: candidate.map((row, position) => ({ seed: row.seed, candidate: stripTiming(row), baseline: stripTiming(control[position]!) })) });
  }
  const fingerprintFiles = ["tournament-bot-benchmark.test.ts", "fixtures/v1/strategy.ts", "fixtures/v1/dictionary.ts",
    "fixtures/v1/optimizer.ts", "fixtures/opponent-policies.ts", "fixtures/face-bid-ablation.ts", "fixtures/quality-face-ablation.ts",
    "harness.ts", "../index.ts", "../game.ts", "../tournament.ts", "../schema.ts", "../letters.ts", "../dictionary.ts"];
  const report = { generatedAt: new Date().toISOString(),
    moduleCommit: "b5ccb36aa238ad16692f8d6af54da15ef9f11324", baselineCommit: "f4569e067a1d6fafcdc773d525268856f6d1542a",
    sourceFiles: fingerprintFiles,
    sourceFingerprintSha256: createHash("sha256").update(fingerprintFiles.map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")).digest("hex"),
    dictionarySha256: createHash("sha256").update(wordlistText).digest("hex"),
    methodology: { stage: "Final", players: 2, gamesPerSeries: 3, auctionType: "Vickrey", startingBalancePerGame: 100,
      startingRackPerPlayer: 5, auctionWindowsPerGame: 88, seedOffset: offset, seeds,
      seatRotation: "Candidate alternates between the two seats across series; its seat remains fixed across its three games",
      setup: "Actual team creation and registration reducers; fixture only the post-Swiss Final status with equal prior totals; actual admin start, auction, word, end and crown reducers thereafter",
      control: "Frozen capital-enabled v1 versus frozen capital-enabled v1, paired by seed and measured seat",
      inputs: "Each policy receives only its authenticated own rack and public balance/auction/history; participantCount is 2",
      driver: "Both sides cash words before bidding, use confirmed in-memory transactions, and receive no post-final-auction cashout",
      victory: "Actual server crown after three aggregate scores; final ties use equal whole-tournament prior totals then lower bot id",
      cacheLifetime: "Fresh policies per series, retained across its three games; shared immutable dictionary records",
      decisionBudgetOverruns: "Measured in-process call wall time >100ms, not network or the 150ms production worker response gate",
      limitations: "Swiss/top-cut performance and network transport are not tested. Later RNG tile streams may diverge between policies. This is report-only and does not change any locked primary promotion gate." },
    results, productionPromotionAuthorized: false };
  if (destination) writeFileSync(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ finalsBenchmark: results.map(({ id, candidate, baseline }) => ({ id, candidate, baseline })) }, null, 2) + "\n");
}, 1_800_000);
