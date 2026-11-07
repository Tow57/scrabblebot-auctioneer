// Offline strategy comparison against the actual, pinned tournament reducers.
// Opt in with BOT_BENCHMARK=1; BOT_BENCHMARK_SEEDS defaults to 30.
// BOT_BENCHMARK_REPORT optionally names the exact JSON output file to write.
// BOT_CAPITAL_ALLOWANCE=1 enables only the measured candidate's experiment.
// BOT_BENCHMARK_COMPARE_CORE=1 measures the unchanged core as the baseline.
// BOT_BENCHMARK_OPPONENTS=core fills the other five seats with core engines.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { StrategyEngine, type StrategyOptions } from "./fixtures/target-strategy";
import { DictionaryIndex } from "../../../bot-starter/src/dictionary";
import { StrategyEngine as FrozenV1Engine } from "./fixtures/v1/strategy";
import { DictionaryIndex as FrozenV1Dictionary } from "./fixtures/v1/dictionary";
import { makeOpponent, makeScaledV1, type OpponentKind } from "./fixtures/opponent-policies";
import { makeRolloutCandidate } from "./fixtures/rollout-candidate";
import { makeFaceBidCandidate } from "./fixtures/face-bid-ablation";
import { makeCashoutAblation } from "./fixtures/cashout-ablation";
import { makePublicFormulaOpponent } from "./fixtures/public-opponent-policies";
import { makeQualityFaceCandidate } from "./fixtures/quality-face-ablation";
import { estimatePrice } from "../../../bot-starter/src/client";
import { myRack, submitBid, submitWord } from "../index";
import { letterValue } from "../letters";
import type { AuctionType } from "../schema";
import {
  call,
  client,
  currentAuction,
  emptyDb,
  getMatch,
  participant,
  startMatch,
  teamWithBot,
  tick,
  VICKREY,
  FIRST_PRICE,
  type Test,
} from "./harness";

const wordlistText = readFileSync(new URL("../../wordlist.txt", import.meta.url), "utf8");
const dictionary = wordlistText.split("\n")
  .map((word) => word.trim().toUpperCase())
  .filter((word) => word.length >= 2)
  .sort((a, b) => b.length - a.length);

// Dictionary entries/trie are immutable. Every agent still owns its optimizer
// caches; building the same 173k-word index per seat would dominate this run.
let sharedIndex: DictionaryIndex | undefined;
let frozenIndex: FrozenV1Dictionary | undefined;
function indexedDictionary(): DictionaryIndex {
  return sharedIndex ??= new DictionaryIndex(dictionary);
}
const capitalAllowance = process.env.BOT_CAPITAL_ALLOWANCE === "1";
const compareCore = process.env.BOT_BENCHMARK_COMPARE_CORE === "1";
const compareV1 = process.env.BOT_BENCHMARK_COMPARE_V1 === "1";
const targetPlanning = process.env.BOT_TARGET_PLANNING === "1";
const targetDiscount = Number(process.env.BOT_TARGET_DISCOUNT ?? 0.65);
const cashoutLength = Number(process.env.BOT_CASHOUT_LENGTH ?? 7);
const liquidityMultiplier = process.env.BOT_LIQUIDITY_MULTIPLIER === undefined ? undefined : Number(process.env.BOT_LIQUIDITY_MULTIPLIER);
if (liquidityMultiplier !== undefined && ![0, 1, 2].includes(liquidityMultiplier)) throw new Error("Use liquidity multiplier 0/1/2");
const candidatePolicy = process.env.BOT_CANDIDATE_POLICY ?? "engine";
if (!["engine", "market", "market-v1", "liquid", "target", "scaled-v1", "rollout-v1", "face-v1", "quality-face-v1", "cashout-v1", "premium-floor", "linear-face"].includes(candidatePolicy)) throw new Error("Unknown candidate policy");
const bidScale = Number(process.env.BOT_BID_SCALE ?? 1);
if (!Number.isFinite(bidScale) || bidScale < 0.5 || bidScale > 2) throw new Error("Use bid scale between 0.5 and 2");
const faceBidWeight = Number(process.env.BOT_FACE_BID_WEIGHT ?? 0);
if (!Number.isFinite(faceBidWeight) || faceBidWeight < 0 || faceBidWeight > 0.5) throw new Error("Use face bid weight between 0 and 0.5");
const qualityMissing = Number(process.env.BOT_QUALITY_MISSING ?? 1);
if (qualityMissing !== 1 && qualityMissing !== 2) throw new Error("Use quality missing limit 1 or 2");
const terminalDenial = process.env.BOT_TERMINAL_DENIAL === "1";
const highRewardCashout = process.env.BOT_HIGH_REWARD_CASHOUT === undefined ? undefined : Number(process.env.BOT_HIGH_REWARD_CASHOUT);
const mainOnly = process.env.BOT_BENCHMARK_MAIN_ONLY === "1";
const trace = process.env.BOT_BENCHMARK_TRACE === "1";
if (![0.65, 0.85].includes(targetDiscount) || ![6, 7].includes(cashoutLength)) throw new Error("Use target discount 0.65/0.85 and cashout length 6/7");
const candidateOptions: StrategyOptions = { capitalAllowance, targetPlanning, targetDiscount: targetDiscount as 0.65 | 0.85,
  cashoutLength: cashoutLength as 6 | 7, liquidityMultiplier: liquidityMultiplier as 0 | 1 | 2 | undefined,
  protectCoreBid: process.env.BOT_PROTECT_CORE_BID === "1",
  targetBidFactor: Number(process.env.BOT_TARGET_BID_FACTOR ?? 2) as 0.5 | 1 | 2 };
const candidateSourcesSha256 = createHash("sha256").update(["strategy.ts", "dictionary.ts", "optimizer.ts"]
  .map(name => readFileSync(new URL(`../../../bot-starter/src/${name}`, import.meta.url), "utf8")).join("\n")).digest("hex");
const policyFixturesSha256 = createHash("sha256").update(["opponent-policies.ts", "v1/strategy.ts", "v1/dictionary.ts", "v1/optimizer.ts"]
  .map(name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).join("\n")).digest("hex");
const rolloutSourceSha256 = createHash("sha256").update(readFileSync(new URL("./fixtures/rollout-candidate.ts", import.meta.url))).digest("hex");
const faceBidSourceSha256 = createHash("sha256").update(readFileSync(new URL("./fixtures/face-bid-ablation.ts", import.meta.url))).digest("hex");
const cashoutSourceSha256 = createHash("sha256").update(readFileSync(new URL("./fixtures/cashout-ablation.ts", import.meta.url))).digest("hex");
const publicFormulaSourceSha256 = createHash("sha256").update(readFileSync(new URL("./fixtures/public-opponent-policies.ts", import.meta.url))).digest("hex");
const targetSourceSha256 = createHash("sha256").update(readFileSync(new URL("./fixtures/target-strategy.ts", import.meta.url))).digest("hex");
const qualityFaceSourceSha256 = createHash("sha256").update(readFileSync(new URL("./fixtures/quality-face-ablation.ts", import.meta.url))).digest("hex");
type Opponents = "starter" | "expensive" | "core" | "v1" | "mixed" | "market" | "public";
type Policy = Pick<StrategyEngine, "decide">;

function makeCandidate(): Policy {
  const index = indexedDictionary();
  switch (candidatePolicy) {
    case "cashout-v1": return makeCashoutAblation(index, { terminalDenial, highRewardCashout });
    case "face-v1": return makeFaceBidCandidate(index, faceBidWeight);
    case "quality-face-v1": return makeQualityFaceCandidate(index, faceBidWeight, qualityMissing as 1 | 2);
    case "rollout-v1": return makeRolloutCandidate(index);
    case "scaled-v1": return makeScaledV1(bidScale, index);
    case "premium-floor": case "linear-face": return makePublicFormulaOpponent(candidatePolicy, index);
    case "engine": return new StrategyEngine(index, candidateOptions);
    default: return makeOpponent(candidatePolicy as OpponentKind, index);
  }
}

// Frozen copies of the official starter's original strategy functions.
// The common driver removes transport/cooldown differences from this comparison.
const STARTER_VALUES: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

function starterBid(letter: string, myBalance: number, myRack: Map<string, number>): number {
  const value = STARTER_VALUES[letter] ?? 1;
  const have = myRack.get(letter) ?? 0;
  const want = have === 0 ? value + 2 : Math.max(1, value);
  return Math.min(want, Math.max(0, myBalance));
}

function starterWord(myRack: Map<string, number>): string | null {
  let tiles = 0;
  for (const count of myRack.values()) tiles += count;
  for (const word of dictionary) {
    if (word.length > tiles) continue;
    const used: Record<string, number> = {};
    let spellable = true;
    for (const letter of word) {
      used[letter] = (used[letter] ?? 0) + 1;
      if (used[letter]! > (myRack.get(letter) ?? 0)) {
        spellable = false;
        break;
      }
    }
    if (spellable) return word;
  }
  return null;
}

type Agent = {
  id: bigint;
  name: string;
  engine?: Policy;
  wordCache: Map<string, string | null>;
};

type RunResult = {
  seed: number;
  seat: number;
  score: number;
  place: number;
  won: boolean;
  leftoverFaceValue: number;
  finalBalance: number;
  auctions: number;
  decisions: number;
  fallbacks: number;
  /** Conservative offline wall-time overruns; not network or worker failures. */
  decisionBudgetOverruns: number;
  tilesWon: number;
  spent: number;
  purchasedFaceValue: number;
  highFaceTiles: number;
  firstCashoutSeconds: number | null;
  wordCount: number;
  longWordCount: number;
  tilesPlayed: number;
  targetDecisions: number;
  rolloutDecisions: number;
  rolloutBoosts: number;
  market: {
    commonPaidTotal: number;
    commonSales: number;
    highPaidTotal: number;
    highSales: number;
    activeBuyingSeats: number;
  };
  initialRack?: string;
  plays?: { round: number; word: string; reward: number }[];
  purchases?: { round: number; letter: string; paid: number }[];
  decisionsTrace?: { round: number; letter: string; balance: number; price: number; bagTotal: number; bid: number; word: string | null; cashout?: number; targetUsed?: boolean }[];
  decisionLatencyMs: number[];
};

function seedFor(seed: number, phase: number): bigint {
  let mixed = BigInt.asUintN(64, BigInt(seed) + BigInt(phase) * 0x9e3779b97f4a7c15n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n);
  mixed = BigInt.asUintN(64, (mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn);
  return mixed ^ (mixed >> 31n);
}

function ownRack(db: Test, matchId: bigint, agent: Agent): Map<string, number> {
  // Deliberately use the authenticated view, never the private holding table.
  return new Map(myRack(db.viewContext(client(agent.name)))
    .filter((tile) => tile.matchId === matchId)
    .map((tile) => [tile.letter, tile.count]));
}

function priceForMatch(db: Test, matchId: bigint): number {
  const paid = [...db.db.auctionResult.resultByMatch.filter(matchId)]
    .sort((a, b) => a.closedAt.microsSinceUnixEpoch < b.closedAt.microsSinceUnixEpoch ? -1
      : a.closedAt.microsSinceUnixEpoch > b.closedAt.microsSinceUnixEpoch ? 1
      : a.auctionId < b.auctionId ? -1 : a.auctionId > b.auctionId ? 1 : 0)
    .map((result) => Number(result.paid));
  return estimatePrice(paid);
}

function runMatch(
  seed: number,
  seat: number,
  candidate: boolean,
  auctionType: AuctionType,
  opponents: Opponents = "starter",
): RunResult {
  const db = emptyDb();
  const agents: Agent[] = Array.from({ length: 6 }, (_, index) => {
    const name = `benchmark-${index}`;
    const measured = index === seat;
    const useEngine = measured ? candidate || compareCore : opponents === "core";
    const useFrozen = measured ? !candidate && compareV1 : opponents === "v1";
    const otherSlot = index < seat ? index : index - 1;
    const marketOpponent = !measured && (opponents === "market" || (opponents === "mixed" && otherSlot < 3));
    return {
      id: teamWithBot(db, `owner-${index}`, name),
      name,
      engine: measured && candidate ? makeCandidate()
        : !measured && opponents === "public" ? makePublicFormulaOpponent(otherSlot % 2 === 0 ? "premium-floor" : "linear-face", indexedDictionary())
        : marketOpponent ? makeOpponent("market", indexedDictionary())
        : useFrozen ? new FrozenV1Engine(frozenIndex ??= new FrozenV1Dictionary(dictionary), { capitalAllowance: true })
        : useEngine ? new StrategyEngine(indexedDictionary(), measured && candidate ? candidateOptions : { capitalAllowance: false }) : undefined,
      wordCache: new Map(),
    };
  });
  db.rng.setSeed(seedFor(seed, 0));
  const matchId = startMatch(db, auctionType, agents.map((agent) => agent.id));
  const measured = agents[seat]!;
  const result: RunResult = {
    seed, seat, score: 0, place: 0, won: false, leftoverFaceValue: 0,
    finalBalance: 0, auctions: 0, decisions: 0, fallbacks: 0, decisionBudgetOverruns: 0,
    tilesWon: 0, spent: 0, purchasedFaceValue: 0, highFaceTiles: 0,
    firstCashoutSeconds: null, wordCount: 0, longWordCount: 0, tilesPlayed: 0, targetDecisions: 0, rolloutDecisions: 0, rolloutBoosts: 0, decisionLatencyMs: [],
    market: { commonPaidTotal: 0, commonSales: 0, highPaidTotal: 0, highSales: 0, activeBuyingSeats: 0 },
  };
  if (trace) {
    result.initialRack = [...ownRack(db, matchId, measured)].flatMap(([letter, count]) => Array(count).fill(letter)).sort().join("");
    result.plays = [];
    result.purchases = [];
    result.decisionsTrace = [];
  }
  while (getMatch(db, matchId).status.tag === "Running") {
    const auction = currentAuction(db, matchId);
    const match = getMatch(db, matchId);
    const estimatedPrice = priceForMatch(db, matchId);
    // Rotate execution order as well as the measured seat. Submissions remain
    // sealed; no strategy reads pendingBid or the spectator winning-bid view.
    const order = agents.map((_, offset) => agents[(offset + result.auctions) % agents.length]!);
    for (const agent of order) {
      let bid = 0;
      for (let actions = 0; ; actions++) {
        const rack = ownRack(db, matchId, agent);
        const balance = Number(participant(db, matchId, agent.id).balance);
        let word: string | null;
        const start = performance.now();
        let exact = true;
        if (agent.engine) {
          const decision = agent.engine.decide({
            myRack: rack,
            myBalance: balance,
            letter: auction.letter,
            bagTotal: match.bagTotal,
            participantCount: agents.length,
            auctionType: auctionType.tag,
            estimatedPrice,
          });
          word = decision.word;
          bid = decision.bid;
          exact = decision.exact;
          if (agent === measured && decision.targetUsed) result.targetDecisions++;
          const rollout = decision as typeof decision & { rolloutUsed?: boolean; baseBid?: number };
          if (agent === measured && rollout.rolloutUsed) result.rolloutDecisions++;
          if (agent === measured && rollout.baseBid !== undefined && decision.bid > rollout.baseBid) result.rolloutBoosts++;
          if (agent === measured) result.decisionsTrace?.push({ round: result.auctions, letter: auction.letter,
            balance, price: estimatedPrice, bagTotal: match.bagTotal, bid, word, cashout: decision.cashout, targetUsed: decision.targetUsed });
        } else {
          const rackKey = [...rack].sort(([a], [b]) => a.localeCompare(b))
            .map(([letter, count]) => `${letter}${count}`).join("");
          if (!agent.wordCache.has(rackKey)) agent.wordCache.set(rackKey, starterWord(rack));
          word = agent.wordCache.get(rackKey)!;
          bid = starterBid(auction.letter, balance, rack);
          if (opponents === "expensive" && agent !== measured) {
            bid = Math.min(balance, "AEIOU".includes(auction.letter) ? 20 : 15);
          }
        }
        const elapsed = performance.now() - start;
        if (agent === measured) {
          result.decisions++;
          if (!exact) result.fallbacks++;
          // The solver stops cooperatively at 100ms and can have bookkeeping
          // overhead. Record actual call wall time independently of its flag.
          if (elapsed > 100) result.decisionBudgetOverruns++;
          result.decisionLatencyMs.push(elapsed);
        }
        expect(Number.isFinite(bid) && Number.isInteger(bid), "finite integer bid").toBe(true);
        expect(bid, "nonnegative bid").toBeGreaterThanOrEqual(0);
        expect(bid, "affordable bid").toBeLessThanOrEqual(balance);
        if (!word) break;
        if (actions >= 49) throw new Error("word submission loop did not consume the rack");
        // Real transactional reducers verify dictionary membership, counts,
        // scoring, identity and whether the match is still running.
        const oldScore = agent === measured ? Number(participant(db, matchId, agent.id).score) : 0;
        call(db, agent.name, (ctx) => submitWord(ctx, { matchId, word }));
        if (agent === measured) {
          result.firstCashoutSeconds ??= result.auctions * Number(match.auctionDurationMs) / 1000;
          result.wordCount++;
          result.longWordCount += Number(word.length >= 7);
          result.tilesPlayed += word.length;
          result.plays?.push({ round: result.auctions, word, reward: Number(participant(db, matchId, agent.id).score) - oldScore });
        }
      }
      // The common reliable driver excludes a tile awarded only when the game
      // ends. Neither candidate nor baseline receives a post-game cashout.
      if (match.bagTotal === 0) bid = 0;
      if (bid > 0) call(db, agent.name, (ctx) =>
        submitBid(ctx, { auctionId: auction.id, amount: BigInt(bid) }),
      );
    }
    db.clock.set(auction.closesAt);
    db.rng.setSeed(seedFor(seed, result.auctions + 1));
    tick(db, matchId);
    if (trace) {
      const sale = db.db.auctionResult.auctionId.find(auction.id);
      if (sale?.winnerBotId === measured.id) result.purchases?.push({ round: result.auctions, letter: sale.letter, paid: Number(sale.paid) });
    }
    result.auctions++;
    if (result.auctions > 98) throw new Error("finite bag did not end");
  }
  expect(result.auctions).toBe(68);
  const players = [...db.db.matchParticipant.mpByMatch.filter(matchId)];
  const mine = participant(db, matchId, measured.id);
  for (const player of players) {
    const spent = [...db.db.auctionResult.resultByMatch.filter(matchId)]
      .filter((auction) => auction.winnerBotId === player.botId)
      .reduce((sum, auction) => sum + auction.paid, 0n);
    expect(player.balance).toBe(100n + player.score - spent);
    expect(player.balance).toBeGreaterThanOrEqual(0n);
  }
  result.score = Number(mine.score);
  result.place = 1 + players.filter((player) => player.score > mine.score).length;
  result.won = result.place === 1;
  result.leftoverFaceValue = [...ownRack(db, matchId, measured)]
    .reduce((sum, [letter, count]) => sum + count * letterValue(letter), 0);
  result.finalBalance = Number(mine.balance);
  const purchases = [...db.db.auctionResult.resultByMatch.filter(matchId)]
    .filter(auction => auction.winnerBotId === measured.id);
  result.tilesWon = purchases.length;
  result.spent = Number(purchases.reduce((sum, auction) => sum + auction.paid, 0n));
  result.purchasedFaceValue = purchases.reduce((sum, auction) => sum + letterValue(auction.letter), 0);
  result.highFaceTiles = purchases.filter(auction => letterValue(auction.letter) >= 4).length;
  // Realized market prices use every public winner, not just the measured bot.
  const sold = [...db.db.auctionResult.resultByMatch.filter(matchId)]
    .filter(auction => auction.winnerBotId !== undefined);
  const common = sold.filter(auction => letterValue(auction.letter) === 1);
  const high = sold.filter(auction => letterValue(auction.letter) >= 4);
  result.market = {
    commonPaidTotal: Number(common.reduce((sum, auction) => sum + auction.paid, 0n)),
    commonSales: common.length,
    highPaidTotal: Number(high.reduce((sum, auction) => sum + auction.paid, 0n)),
    highSales: high.length,
    activeBuyingSeats: new Set(sold.map(auction => auction.winnerBotId)).size,
  };
  return result;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(runs: RunResult[]) {
  const latency = runs.flatMap((run) => run.decisionLatencyMs).sort((a, b) => a - b);
  const decisions = runs.reduce((sum, run) => sum + run.decisions, 0);
  const commonPaidTotal = runs.reduce((sum, run) => sum + run.market.commonPaidTotal, 0);
  const commonSales = runs.reduce((sum, run) => sum + run.market.commonSales, 0);
  const highPaidTotal = runs.reduce((sum, run) => sum + run.market.highPaidTotal, 0);
  const highSales = runs.reduce((sum, run) => sum + run.market.highSales, 0);
  return {
    matches: runs.length,
    meanScore: mean(runs.map((run) => run.score)),
    meanPlace: mean(runs.map((run) => run.place)),
    winRate: mean(runs.map((run) => Number(run.won))),
    meanLeftoverFaceValue: mean(runs.map((run) => run.leftoverFaceValue)),
    meanFinalBalance: mean(runs.map((run) => run.finalBalance)),
    meanTilesWon: mean(runs.map((run) => run.tilesWon)),
    meanSpent: mean(runs.map((run) => run.spent)),
    meanPurchasedFaceValue: mean(runs.map(run => run.purchasedFaceValue)),
    meanHighFaceTiles: mean(runs.map(run => run.highFaceTiles)),
    meanFirstCashoutSeconds: mean(runs.flatMap(run => run.firstCashoutSeconds === null ? [] : [run.firstCashoutSeconds])),
    noCashoutRate: runs.filter(run => run.firstCashoutSeconds === null).length / runs.length,
    meanWordCount: mean(runs.map(run => run.wordCount)),
    longWordFraction: runs.reduce((sum, run) => sum + run.longWordCount, 0) / Math.max(1, runs.reduce((sum, run) => sum + run.wordCount, 0)),
    meanTilesPlayed: mean(runs.map(run => run.tilesPlayed)),
    targetCoverage: runs.reduce((sum, run) => sum + run.targetDecisions, 0) / decisions,
    rolloutCoverage: runs.reduce((sum, run) => sum + run.rolloutDecisions, 0) / decisions,
    rolloutBoostRate: runs.reduce((sum, run) => sum + run.rolloutBoosts, 0) / decisions,
    decisions,
    decisionBudgetOverruns: runs.reduce((sum, run) => sum + run.decisionBudgetOverruns, 0),
    fallbackRate: runs.reduce((sum, run) => sum + run.fallbacks, 0) / decisions,
    market: {
      commonPaidTotal, commonSales,
      pooledCommonPaid: commonSales ? commonPaidTotal / commonSales : null,
      highPaidTotal, highSales,
      pooledHighPaid: highSales ? highPaidTotal / highSales : null,
      meanActiveBuyingSeats: mean(runs.map(run => run.market.activeBuyingSeats)),
    },
    latencyMs: {
      mean: mean(latency), p95: percentile(latency, 0.95),
      p99: percentile(latency, 0.99), max: latency.at(-1) ?? 0,
    },
  };
}

async function paired(seeds: number[], auctionType: AuctionType, opponents: Opponents) {
  const baseline: RunResult[] = [];
  const candidate: RunResult[] = [];
  for (const [index, seed] of seeds.entries()) {
    const seat = index % 6;
    baseline.push(runMatch(seed, seat, false, auctionType, opponents));
    candidate.push(runMatch(seed, seat, true, auctionType, opponents));
    // Yield between CPU-heavy matches so Vitest's worker RPC can acknowledge
    // lifecycle updates and does not time out on an otherwise passing run.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const samples = candidate.map((run, index) => ({
    seed: run.seed, seat: run.seat,
    candidate: { ...run, decisionLatencyMs: undefined },
    baseline: { ...baseline[index]!, decisionLatencyMs: undefined },
  }));
  return {
    candidate: summarize(candidate), baseline: summarize(baseline),
    pairedMeanScoreDifference: mean(candidate.map((run, index) => run.score - baseline[index]!.score)),
    pairedMeanPlaceImprovement: mean(candidate.map((run, index) => baseline[index]!.place - run.place)),
    samples,
  };
}

test.skipIf(process.env.BOT_BENCHMARK !== "1")(
  `paired actual-module benchmark against ${process.env.BOT_BENCHMARK_OPPONENTS ?? "starter"} policies`,
  async () => {
    const count = Number(process.env.BOT_BENCHMARK_SEEDS ?? 30);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error("BOT_BENCHMARK_SEEDS must be an integer from 1 to 100");
    }
    const opponents = process.env.BOT_BENCHMARK_OPPONENTS ?? "starter";
    if (!["starter", "core", "v1", "mixed", "market", "public"].includes(opponents)) throw new Error("Unknown opponent roster");
    const seedOffset = Number(process.env.BOT_BENCHMARK_SEED_OFFSET ?? 0);
    if (!Number.isSafeInteger(seedOffset) || seedOffset < 0) throw new Error("Use a nonnegative integer seed offset");
    const seeds = Array.from({ length: count }, (_, index) => 10_001 + (index + seedOffset) * 7_919);
    const report = {
      generatedAt: new Date().toISOString(),
      moduleCommit: "b5ccb36aa238ad16692f8d6af54da15ef9f11324",
      dictionarySha256: createHash("sha256").update(wordlistText).digest("hex"),
      methodology: {
        players: 6,
        candidateStrategy: candidatePolicy === "quality-face-v1" ? `Frozen v1 with quality-gated face boost ${faceBidWeight}, common-letter deficit at most ${qualityMissing}`
          : candidatePolicy === "cashout-v1" ? "Frozen v1 with isolated cashout/last-usable-auction experiment"
          : candidatePolicy === "face-v1" ? `Frozen v1 useful-letter bids weighted by 1 + ${faceBidWeight} * (face - 1)`
          : candidatePolicy === "rollout-v1" ? "Bounded paired common-future marginal experiment, never lowering the v1 bid"
          : candidatePolicy === "scaled-v1" ? `Frozen v1 bid scaling by ${bidScale}`
          : candidatePolicy !== "engine" ? `${candidatePolicy} public-data-inspired policy`
          : targetPlanning ? "target-potential experiment" : capitalAllowance ? "capital allowance policy" : "validated core",
        capitalAllowance,
        targetPlanning, targetDiscount, cashoutLength, liquidityMultiplier, candidatePolicy, bidScale, faceBidWeight, qualityMissing, terminalDenial, highRewardCashout, candidateOptions, candidateSourcesSha256, policyFixturesSha256, rolloutSourceSha256, faceBidSourceSha256, cashoutSourceSha256, publicFormulaSourceSha256, targetSourceSha256, qualityFaceSourceSha256, seedOffset, mainOnly,
        inputs: "Own authenticated my_rack view, public match/participant/auction state and settled payments only",
        baseline: compareV1 ? "Frozen production tournament-v1.0 at f4569e0 with capital allowance enabled"
          : compareCore ? "Validated core with capital allowance disabled under the same reliable driver"
          : "Original starter strategy functions under the same reliable driver",
        opponents: opponents === "public" ? "Three MIT-attributed premium-floor and two linear-face numeric floor archetypes over frozen v1; not full copies or verified live rivals"
          : opponents === "market" ? "Five public-data-inspired market policies; not reconstructions of live rivals"
          : opponents === "mixed" ? "Three public-data-inspired market policies and two frozen starters; not reconstructions of live rivals"
          : opponents === "v1" ? "Five frozen production tournament-v1.0 engines, each with its own optimizer cache"
          : opponents === "core" ? "Five unchanged core engines, each with its own optimizer cache"
          : "Five frozen original starter strategies",
        expensiveOpponents: "Five frozen starter word policies bidding 20 for vowels and 15 for consonants, capped to balance",
        dictionaryIndex: "One shared immutable dictionary index; independent per-agent optimizer caches",
        pairing: "Fixed seeds reset before initial deal and each auction tick; measured seat rotates across six positions",
        limitation: "Policies can consume different RNG amounts, so paired seeds do not guarantee identical later tile streams",
        endgame: "No post-settlement cashout; both drivers skip the unusable final tile",
        priceEstimate: "EWMA of chronological positive settled payments in the current match; starts at 3 and updates 0.8 * estimate + 0.2 * paid",
        winRate: "Finishes with the highest score, including shared first places",
        latency: "In-process strategy calls only; excludes websocket/network/server latency",
        decisionBudgetOverruns: "Measured decision wall time >100ms; conservative offline budget diagnostic, not a worker/network failure",
        market: "All public auction winners: pooled paid/count for face-1 and face>=4 tiles; mean number of distinct buying seats",
        fallbackRate: "Fraction of measured decisions whose engine reports exact=false",
        strengthGate: "Report-only; correctness and affordability are asserted",
      },
      vickrey: await paired(seeds, VICKREY, opponents as Opponents),
      firstPrice: mainOnly ? null : await paired(seeds.slice(0, Math.min(count, 6)), FIRST_PRICE, opponents as Opponents),
      expensiveOpponents: mainOnly ? null : await paired(seeds.slice(0, Math.min(count, 4)), VICKREY, "expensive"),
    };
    const json = JSON.stringify(report, null, 2) + "\n";
    if (process.env.BOT_BENCHMARK_REPORT) writeFileSync(process.env.BOT_BENCHMARK_REPORT, json);
    console.log(JSON.stringify({
      vickrey: report.vickrey.candidate,
      baseline: report.vickrey.baseline,
      pairedMeanScoreDifference: report.vickrey.pairedMeanScoreDifference,
      pairedMeanPlaceImprovement: report.vickrey.pairedMeanPlaceImprovement,
      firstPrice: report.firstPrice?.candidate,
      expensiveOpponents: report.expensiveOpponents?.candidate,
    }, null, 2));
  },
  600_000,
);
