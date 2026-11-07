import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { StrategyEngine } from "./strategy.js";
import { loadDictionary } from "./dictionary.js";
import type { MatchSnapshot } from "./client.js";

if (!parentPort) throw new Error("Strategy worker requires a parent port");
const configuredWeight = process.env.BOT_HEADS_UP_FACE_WEIGHT;
const headsUpFaceBidWeight = configuredWeight === undefined ? 0.3
  : configuredWeight.trim() === "" ? NaN : Number(configuredWeight);
if (!Number.isFinite(headsUpFaceBidWeight) || headsUpFaceBidWeight < 0 || headsUpFaceBidWeight > 0.5) {
  throw new Error("BOT_HEADS_UP_FACE_WEIGHT must be a finite number between 0 and 0.5");
}
const capitalAllowance = process.env.BOT_CAPITAL_ALLOWANCE !== "0";
const engine = new StrategyEngine(loadDictionary(workerData?.dictionaryPath), {
  capitalAllowance,
  headsUpFaceBidWeight: capitalAllowance ? headsUpFaceBidWeight : 0,
});
parentPort.on("message", (request: { id: number; snapshot: MatchSnapshot }) => {
  try {
    const s = request.snapshot;
    const decision = engine.decide({
      myRack: s.myRack,
      myBalance: s.myBalance,
      letter: s.letter,
      bagTotal: s.bagTotal,
      participantCount: s.participantCount,
      auctionType: s.auctionType,
      estimatedPrice: s.estimatedPrice,
      deadlineMs: performance.now() + 100,
    });
    parentPort!.postMessage({ id: request.id, matchId: s.matchId, auctionId: s.auctionId, decision });
  } catch {
    parentPort!.postMessage({ id: request.id, matchId: request.snapshot.matchId, auctionId: request.snapshot.auctionId, error: "Strategy evaluation failed" });
  }
});
parentPort.postMessage({ ready: true });
