import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { StrategyEngine } from "./strategy.js";
import { loadDictionary } from "./dictionary.js";
import type { MatchSnapshot } from "./client.js";
import { createCopiedPolicy } from "./copied-lala/adapter.js";

if (!parentPort) throw new Error("Strategy worker requires a parent port");
const configuredWeight = process.env.BOT_HEADS_UP_FACE_WEIGHT;
const headsUpFaceBidWeight = configuredWeight === undefined ? 0.3
  : configuredWeight.trim() === "" ? NaN : Number(configuredWeight);
if (!Number.isFinite(headsUpFaceBidWeight) || headsUpFaceBidWeight < 0 || headsUpFaceBidWeight > 0.5) {
  throw new Error("BOT_HEADS_UP_FACE_WEIGHT must be a finite number between 0 and 0.5");
}
const configuredMultiwayWeight = process.env.BOT_MULTIWAY_FACE_WEIGHT;
const multiwayFaceBidWeight = configuredMultiwayWeight === undefined ? 0.1
  : configuredMultiwayWeight.trim() === "" ? NaN : Number(configuredMultiwayWeight);
if (!Number.isFinite(multiwayFaceBidWeight) || multiwayFaceBidWeight < 0 || multiwayFaceBidWeight > 0.5) {
  throw new Error("BOT_MULTIWAY_FACE_WEIGHT must be a finite number between 0 and 0.5");
}
const capitalAllowance = process.env.BOT_CAPITAL_ALLOWANCE !== "0";
const words = loadDictionary(workerData?.dictionaryPath);
const copiedMode = process.env.BOT_COPIED_POLICY;
if (copiedMode !== undefined && copiedMode !== "" && copiedMode !== "lala") throw new Error("BOT_COPIED_POLICY must be lala or unset");
const copied = copiedMode === "lala" ? createCopiedPolicy(words) : undefined;
const engine = new StrategyEngine(words, {
  capitalAllowance,
  headsUpFaceBidWeight: capitalAllowance ? headsUpFaceBidWeight : 0,
  multiwayFaceBidWeight: capitalAllowance ? multiwayFaceBidWeight : 0,
  wordFirst: true,
});
parentPort.on("message", (request: { id: number; snapshot: MatchSnapshot }) => {
  try {
    const s = request.snapshot;
    const decision = copied ? (() => {
      if (!s.letter || s.auctionId === null) return { bid: 0, word: null, plan: [], elapsedMs: 0, policy: "Copied-Lala-v2.7.5" };
      if (!s.copiedLala) throw new Error("Copied Lala public history is incomplete");
      const output = copied.decide({ ...s, auctionId: s.auctionId, ...s.copiedLala });
      if (output.elapsedMs > 95) throw new Error("Copied Lala exceeded the95ms response compute limit");
      return { ...output, policy: "Copied-Lala-v2.7.5" };
    })() : engine.decide({
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
