// Independent report-only robustness check of the configured production N2
// policy against two MIT-attributed acquisition archetypes. No tuning/gate.
// The driver below is copied from tournament-bot-benchmark.test.ts
// SHA256 585e4fdf2a17a8d310aea7b950694bf5171fc443fd9c9527a84d0af8c462235c.
// Only playSeries orchestration adds cooperative yields after each game;
// playGame and all simulated clock, RNG and action logic remain unchanged.
// Copying preserves that locked source and its earlier confirmation artifacts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createTournament, myRack, registerForTournament, startNextFinalsMatch, submitBid, submitWord } from "../index";
import { call, client, currentAuction, emptyDb, getMatch, makeAdmin, participant, teamWithBot, tick, type Test } from "./harness";
import { DictionaryIndex as ProductionDictionary } from "../../../bot-starter/src/dictionary";
import { StrategyEngine as ProductionEngine } from "../../../bot-starter/src/strategy";
import { DictionaryIndex } from "./fixtures/v1/dictionary";
import { StrategyEngine as FrozenV1, type StrategyContext, type StrategyDecision } from "./fixtures/v1/strategy";
import { makeFaceBidCandidate } from "./fixtures/face-bid-ablation";
import { makePublicFormulaOpponent, PUBLIC_POLICY_SOURCES, type PublicFormulaKind } from "./fixtures/public-opponent-policies";

type Policy = { decide(ctx: StrategyContext): StrategyDecision };
const ADMIN = "heads-up-public-fixture-admin";
const OPPONENTS: readonly PublicFormulaKind[] = ["premium-floor", "linear-face"];
const SEED_OFFSET = 900;
const SEEDS = Array.from({ length: 30 }, (_, position) => 10_001 + (SEED_OFFSET + position) * 7_919);
const SOURCE_PATHS = ["heads-up-public-robustness.test.ts", "tournament-bot-benchmark.test.ts", "harness.ts",
  "../../../bot-starter/src/strategy.ts", "../../../bot-starter/src/dictionary.ts", "../../../bot-starter/src/optimizer.ts",
  "fixtures/v1/strategy.ts", "fixtures/v1/dictionary.ts", "fixtures/v1/optimizer.ts",
  "fixtures/opponent-policies.ts", "fixtures/public-opponent-policies.ts", "fixtures/face-bid-ablation.ts",
  "../index.ts", "../game.ts", "../tournament.ts", "../schema.ts", "../letters.ts", "../dictionary.ts",
  "../text.ts", "../identity.ts", "../ratings.ts", "../libm.ts", "../lobby.ts", "../../wordlist.txt",
  "../../package.json", "../../package-lock.json", "../../tsconfig.json", "../../vitest.config.ts",
  "../../../bot-starter/package.json", "../../../bot-starter/package-lock.json", "../../../bot-starter/tsconfig.json"];
const sourceHashes = () => Object.fromEntries(SOURCE_PATHS.map(path => [path,
  createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
const wordlistText = readFileSync(new URL("../../wordlist.txt", import.meta.url), "utf8");
const words = wordlistText.split(/\s+/).map(word => word.toUpperCase()).filter(word => /^[A-Z]{2,}$/.test(word));
let productionIndex: ProductionDictionary | undefined;
let frozenIndex: DictionaryIndex | undefined;
function pairedPolicies(kind: PublicFormulaKind, seat: number, upgraded: boolean): readonly [Policy, Policy] {
  const frozen = frozenIndex ??= new DictionaryIndex(words);
  const measured = upgraded
    ? new ProductionEngine(productionIndex ??= new ProductionDictionary(words),
      { capitalAllowance: true, headsUpFaceBidWeight: 0.3 })
    : new FrozenV1(frozen, { capitalAllowance: true });
  const opponent = makePublicFormulaOpponent(kind, frozen);
  return seat === 0 ? [measured, opponent] : [opponent, measured];
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

async function playSeries(seed: number, measuredSeat: number, policies: readonly [Policy, Policy]): Promise<SeriesResult> {
  const { db, players, tournamentId } = finalsFixture(policies);
  const games: GameResult[] = [];
  for (let game = 1; game <= 3; game++) {
    games.push(playGame(db, tournamentId, players, measuredSeat, seed, game));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
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

test("public robustness driver preserves the locked actual three-game finals contract", async () => {
  let contexts = 0;
  const idle: Policy = { decide(ctx) {
    expect(ctx.participantCount).toBe(2);
    expect(ctx.auctionType).toBe("Vickrey");
    contexts++;
    return { bid: 0, word: null, plan: [], cashout: 0, exact: true, elapsedMs: 0 };
  } };
  let yielded = false;
  const heartbeat = setImmediate(() => { yielded = true; });
  const result = await playSeries(SEEDS[0]!, 1, [idle, idle]);
  clearImmediate(heartbeat);
  expect(yielded, "game-boundary yields must let the event loop process updates").toBe(true);
  expect(contexts).toBe(88 * 2 * 3);
  expect(result.aggregateTie).toBe(true);
  expect(result.wonServerCrown).toBe(false);
  expect(result.games.every(game => game.auctionWindows === 88 && game.score === 0)).toBe(true);
  expect(summarize([result]).noCashoutRate).toBe(1);
});

test("public robustness candidate matches the confirmed frozen heads-up transform", () => {
  const smallWords = ["AT", "QAT", "CAT", "HAT", "KITE", "QUA", "ZOO"];
  const production = new ProductionEngine(smallWords, { capitalAllowance: true, headsUpFaceBidWeight: 0.3 });
  const confirmed = makeFaceBidCandidate(smallWords, 0.3);
  const stripTiming = ({ elapsedMs: _elapsedMs, ...decision }: StrategyDecision) => decision;
  for (const [letters, letter] of [["AT", "Q"], ["ITE", "K"], ["OO", "Z"]] as const) {
    const myRack = new Map<string, number>();
    for (const tile of letters) myRack.set(tile, (myRack.get(tile) ?? 0) + 1);
    for (const bagTotal of [60, 2, 1, 0]) {
      const ctx: StrategyContext = { myRack, letter, myBalance: 100, bagTotal,
        participantCount: 2, auctionType: "Vickrey", estimatedPrice: 8 };
      expect(stripTiming(production.decide(ctx))).toEqual(stripTiming(confirmed.decide(ctx)));
    }
  }
});

type Pair = { seed: number; seat: number; candidate: SeriesResult; baseline: SeriesResult };
function pairedSummary(pairs: Pair[]) {
  const differences = pairs.map(pair => pair.candidate.aggregateMargin - pair.baseline.aggregateMargin);
  const average = mean(differences);
  const standardError = Math.sqrt(differences.reduce((sum, value) => sum + (value - average) ** 2, 0)
    / (differences.length - 1) / differences.length);
  return { independentUnit: "Paired seed, not individual game", n: differences.length,
    meanAggregateMarginDifference: average, standardError,
    // The sample size is fixed at 30; this is the two-sided t(29) 95% interval.
    aggregateMarginDifference95CI: [average - 2.04523 * standardError, average + 2.04523 * standardError],
    meanThreeGameScoreDifference: mean(pairs.map(pair => pair.candidate.aggregateScore - pair.baseline.aggregateScore)),
    crownsImproved: pairs.filter(pair => pair.candidate.wonServerCrown && !pair.baseline.wonServerCrown).length,
    crownsRegressed: pairs.filter(pair => pair.baseline.wonServerCrown && !pair.candidate.wonServerCrown).length };
}

test.skipIf(process.env.BOT_HEADS_UP_PUBLIC_BENCHMARK !== "1")("fixed heads-up finals robustness against public acquisition archetypes", async () => {
  const destination = process.env.BOT_HEADS_UP_PUBLIC_BENCHMARK_REPORT;
  if (!destination) throw new Error("Set BOT_HEADS_UP_PUBLIC_BENCHMARK_REPORT to a new report path");
  if (existsSync(destination)) throw new Error("Refusing to overwrite a heads-up public robustness report");
  const initialSourceHashes = sourceHashes();
  const startedAt = new Date().toISOString();
  const results: { opponent: PublicFormulaKind; candidate: ReturnType<typeof summarize>;
    baseline: ReturnType<typeof summarize>; paired: ReturnType<typeof pairedSummary>; samples: Pair[] }[] = [];
  for (const opponent of OPPONENTS) {
    const samples: Pair[] = [];
    for (const [position, seed] of SEEDS.entries()) {
      const seat = position % 2;
      const baseline = await playSeries(seed, seat, pairedPolicies(opponent, seat, false));
      const candidate = await playSeries(seed, seat, pairedPolicies(opponent, seat, true));
      samples.push({ seed, seat, candidate, baseline });
      process.stdout.write(JSON.stringify({ headsUpPublicProgress: { opponent, completed: position + 1, total: SEEDS.length, seed,
        candidateMargin: candidate.aggregateMargin, baselineMargin: baseline.aggregateMargin } }) + "\n");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    results.push({ opponent, candidate: summarize(samples.map(pair => pair.candidate)),
      baseline: summarize(samples.map(pair => pair.baseline)), paired: pairedSummary(samples), samples });
  }
  expect(sourceHashes(), "Robustness source changed during evaluation").toEqual(initialSourceHashes);
  const pooledBySeed = SEEDS.map((seed, position) => ({ seed, seat: position % 2,
    aggregateMarginDifference: mean(results.map(result => result.samples[position]!.candidate.aggregateMargin
      - result.samples[position]!.baseline.aggregateMargin)),
    threeGameScoreDifference: mean(results.map(result => result.samples[position]!.candidate.aggregateScore
      - result.samples[position]!.baseline.aggregateScore)),
    crownDifference: mean(results.map(result => Number(result.samples[position]!.candidate.wonServerCrown)
      - Number(result.samples[position]!.baseline.wonServerCrown))) }));
  const marginDifferences = pooledBySeed.map(row => row.aggregateMarginDifference);
  const marginMean = mean(marginDifferences);
  const marginSE = Math.sqrt(marginDifferences.reduce((sum, value) => sum + (value - marginMean) ** 2, 0) / 29 / 30);
  const report = { startedAt, generatedAt: new Date().toISOString(),
    modulePin: "b5ccb36aa238ad16692f8d6af54da15ef9f11324",
    frozenV1Pin: "f4569e067a1d6fafcdc773d525268856f6d1542a",
    copiedDriver: { source: "tournament-bot-benchmark.test.ts",
      sha256: "585e4fdf2a17a8d310aea7b950694bf5171fc443fd9c9527a84d0af8c462235c",
      section: "type Player through summarize; only playSeries adds sequential async game-boundary yields" },
    sourceHashes: initialSourceHashes,
    sourceFingerprintSha256: createHash("sha256").update(JSON.stringify(initialSourceHashes)).digest("hex"),
    dictionarySha256: createHash("sha256").update(wordlistText).digest("hex"),
    methodology: { stage: "Final", players: 2, gamesPerSeries: 3, auctionType: "Vickrey",
      startingBalancePerGame: 100, startingRackPerPlayer: 5, auctionWindowsPerGame: 88,
      seedOffset: SEED_OFFSET, seeds: SEEDS, tuning: "None; fixed production face weight 0.3",
      candidate: "Production StrategyEngine with capitalAllowance true and headsUpFaceBidWeight 0.3",
      control: "Frozen capital-enabled v1, paired against the same archetype by seed and measured seat",
      opponents: OPPONENTS, publicFormulaSources: PUBLIC_POLICY_SOURCES,
      opponentCaveat: "Only the published acquisition floors over frozen-v1 search/words; not verified replicas or strength claims about named live bots.",
      seatRotation: "Alternating two seats across series, fixed seat within each three-game series",
      setup: "Copied locked driver: actual creation and registration; fixture only equal-prior post-Swiss Final status; actual finals start/auction/word/end/crown reducers thereafter",
      inputs: "Own authenticated rack and public match/balance/auction/settled-payment history only",
      driver: "Same word-first transaction driver for all policies; cooperative event-loop yield after each game; simulated clock/RNG/action logic unchanged; no post-final-award actions",
      victory: "Actual server crown from three aggregate scores, then equal prior totals and lower bot id",
      cacheLifetime: "Fresh independent policies per paired series, retained across its three games; shared immutable production/frozen indexes",
      analysisUnit: "Thirty paired seeds per archetype. Overall differences equally average the two archetypes WITHIN each seed, n=30, not 180 independent games.",
      timing: "Measured in-process wall time >100ms; excludes worker/network and the production 150ms response gate",
      limitations: "This tests two fixed acquisition-price archetypes. It does not test novel word policies, adaptive rivals, Swiss/top-cut qualification or transport. Later RNG tile streams may diverge. Deadline-bounded search can vary with wall time.",
      promotion: "Report only; no automatic gate, parameter selection or production authorization" },
    equalWeightBySeed: { n: 30, meanAggregateMarginDifference: marginMean,
      aggregateMarginDifference95CI: [marginMean - 2.04523 * marginSE, marginMean + 2.04523 * marginSE],
      meanThreeGameScoreDifference: mean(pooledBySeed.map(row => row.threeGameScoreDifference)),
      meanCrownRateDifference: mean(pooledBySeed.map(row => row.crownDifference)), samples: pooledBySeed },
    results: results.map(result => ({ ...result, samples: result.samples.map(pair => ({ ...pair,
      candidate: { ...pair.candidate, games: pair.candidate.games.map(game => ({ ...game, latencyMs: undefined })) },
      baseline: { ...pair.baseline, games: pair.baseline.games.map(game => ({ ...game, latencyMs: undefined })) } })) })),
    productionPromotionAuthorized: false };
  writeFileSync(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ headsUpPublicRobustness: results.map(({ samples: _samples, ...result }) => result),
    equalWeightBySeed: { ...report.equalWeightBySeed, samples: undefined } }, null, 2) + "\n");
}, 1_800_000);

