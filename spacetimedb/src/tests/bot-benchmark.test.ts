// Offline strategy comparison against the actual, pinned tournament reducers.
// Opt in with BOT_BENCHMARK=1; BOT_BENCHMARK_SEEDS defaults to 30.
// BOT_BENCHMARK_REPORT optionally names the exact JSON output file to write.
// BOT_CAPITAL_ALLOWANCE=1 enables only the measured candidate's experiment.
// BOT_BENCHMARK_COMPARE_CORE=1 measures the unchanged core as the baseline.
// BOT_BENCHMARK_OPPONENTS=core fills the other five seats with core engines.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { StrategyEngine } from "../../../bot-starter/src/strategy";
import { DictionaryIndex } from "../../../bot-starter/src/dictionary";
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
function indexedDictionary(): DictionaryIndex {
  return sharedIndex ??= new DictionaryIndex(dictionary);
}
const capitalAllowance = process.env.BOT_CAPITAL_ALLOWANCE === "1";
const compareCore = process.env.BOT_BENCHMARK_COMPARE_CORE === "1";
type Opponents = "starter" | "expensive" | "core";

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
  engine?: StrategyEngine;
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
  tilesWon: number;
  spent: number;
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
    return {
      id: teamWithBot(db, `owner-${index}`, name),
      name,
      engine: useEngine ? new StrategyEngine(indexedDictionary(), {
        capitalAllowance: measured && candidate && capitalAllowance,
      }) : undefined,
      wordCache: new Map(),
    };
  });
  db.rng.setSeed(seedFor(seed, 0));
  const matchId = startMatch(db, auctionType, agents.map((agent) => agent.id));
  const measured = agents[seat]!;
  const result: RunResult = {
    seed, seat, score: 0, place: 0, won: false, leftoverFaceValue: 0,
    finalBalance: 0, auctions: 0, decisions: 0, fallbacks: 0, tilesWon: 0, spent: 0, decisionLatencyMs: [],
  };
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
          result.decisionLatencyMs.push(elapsed);
        }
        expect(Number.isFinite(bid) && Number.isInteger(bid), "finite integer bid").toBe(true);
        expect(bid, "nonnegative bid").toBeGreaterThanOrEqual(0);
        expect(bid, "affordable bid").toBeLessThanOrEqual(balance);
        if (!word) break;
        if (actions >= 49) throw new Error("word submission loop did not consume the rack");
        // Real transactional reducers verify dictionary membership, counts,
        // scoring, identity and whether the match is still running.
        call(db, agent.name, (ctx) => submitWord(ctx, { matchId, word }));
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
  return {
    matches: runs.length,
    meanScore: mean(runs.map((run) => run.score)),
    meanPlace: mean(runs.map((run) => run.place)),
    winRate: mean(runs.map((run) => Number(run.won))),
    meanLeftoverFaceValue: mean(runs.map((run) => run.leftoverFaceValue)),
    meanFinalBalance: mean(runs.map((run) => run.finalBalance)),
    meanTilesWon: mean(runs.map((run) => run.tilesWon)),
    meanSpent: mean(runs.map((run) => run.spent)),
    decisions,
    fallbackRate: runs.reduce((sum, run) => sum + run.fallbacks, 0) / decisions,
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
  process.env.BOT_BENCHMARK_OPPONENTS === "core"
    ? "paired actual-module benchmark against five unchanged core engines"
    : "paired actual-module benchmark against five frozen starter strategies",
  async () => {
    const count = Number(process.env.BOT_BENCHMARK_SEEDS ?? 30);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error("BOT_BENCHMARK_SEEDS must be an integer from 1 to 100");
    }
    const opponents = process.env.BOT_BENCHMARK_OPPONENTS ?? "starter";
    if (opponents !== "starter" && opponents !== "core") throw new Error("BOT_BENCHMARK_OPPONENTS must be starter or core");
    const seeds = Array.from({ length: count }, (_, index) => 10_001 + index * 7_919);
    const report = {
      generatedAt: new Date().toISOString(),
      moduleCommit: "b5ccb36aa238ad16692f8d6af54da15ef9f11324",
      dictionarySha256: createHash("sha256").update(wordlistText).digest("hex"),
      methodology: {
        players: 6,
        candidateStrategy: capitalAllowance ? "capital allowance experiment" : "validated core",
        capitalAllowance,
        inputs: "Own authenticated my_rack view, public match/participant/auction state and settled payments only",
        baseline: compareCore ? "Validated core with capital allowance disabled under the same reliable driver"
          : "Original starter strategy functions under the same reliable driver",
        opponents: opponents === "core" ? "Five unchanged core engines, each with its own optimizer cache"
          : "Five frozen original starter strategies",
        expensiveOpponents: "Five frozen starter word policies bidding 20 for vowels and 15 for consonants, capped to balance",
        dictionaryIndex: "One shared immutable dictionary index; independent per-agent optimizer caches",
        pairing: "Fixed seeds reset before initial deal and each auction tick; measured seat rotates across six positions",
        limitation: "Policies can consume different RNG amounts, so paired seeds do not guarantee identical later tile streams",
        endgame: "No post-settlement cashout; both drivers skip the unusable final tile",
        priceEstimate: "EWMA of chronological positive settled payments in the current match; starts at 3 and updates 0.8 * estimate + 0.2 * paid",
        winRate: "Finishes with the highest score, including shared first places",
        latency: "In-process strategy calls only; excludes websocket/network/server latency",
        fallbackRate: "Fraction of measured decisions whose engine reports exact=false",
        strengthGate: "Report-only; correctness and affordability are asserted",
      },
      vickrey: await paired(seeds, VICKREY, opponents),
      firstPrice: await paired(seeds.slice(0, Math.min(count, 6)), FIRST_PRICE, opponents),
      expensiveOpponents: await paired(seeds.slice(0, Math.min(count, 4)), VICKREY, "expensive"),
    };
    const json = JSON.stringify(report, null, 2) + "\n";
    if (process.env.BOT_BENCHMARK_REPORT) writeFileSync(process.env.BOT_BENCHMARK_REPORT, json);
    console.log(JSON.stringify({
      vickrey: report.vickrey.candidate,
      baseline: report.vickrey.baseline,
      pairedMeanScoreDifference: report.vickrey.pairedMeanScoreDifference,
      pairedMeanPlaceImprovement: report.vickrey.pairedMeanPlaceImprovement,
      firstPrice: report.firstPrice.candidate,
      expensiveOpponents: report.expensiveOpponents.candidate,
    }, null, 2));
  },
  600_000,
);
