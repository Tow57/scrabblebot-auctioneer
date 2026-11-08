// Data tables learned offline: leave values (scripts/train-leave.ts) and
// stage-dependent prices (scripts/phase-prices.ts). Both are optional; the
// strategy falls back to its built-in constants when a file is missing.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, file), "utf8")) as T;
  } catch {
    return null;
  }
}

export interface LeaveTable {
  buckets: [number, number][]; // [lo, hi] of auctions left
  table: number[][][];         // [bucket][letter][copy 1..3] marginal future points
  meta?: { balCoef: number }[]; // future points per 100 coins, per bucket
}
export interface PhasePrices {
  cuts: number[];              // upper round bound of each stage
  prices: number[][];          // [stage][letter]
}

export const LEAVE: LeaveTable | null = readJson<LeaveTable>("leave-table.json");
// The same model fitted to real matches (scripts/train-leave-live.ts).
export const LEAVE_LIVE: LeaveTable | null = readJson<LeaveTable>("leave-table-live.json");
export const PHASE: PhasePrices | null = readJson<PhasePrices>("phase-prices.json");
// Refit on the most recent 900 matches (scripts/phase-prices-recent.ts).
export const PHASE_RECENT: PhasePrices | null = readJson<PhasePrices>("phase-prices-recent.json");

// Cumulative leave value (points) of holding `copies` of letter k when
// `T` auctions are left. Copies past the third are worth half the third.
export function leaveValue(T: number, k: number, copies: number, live = false): number {
  const L = live && LEAVE_LIVE ? LEAVE_LIVE : LEAVE;
  if (!L || copies <= 0) return 0;
  let b = L.buckets.findIndex(([lo, hi]) => T >= lo && T <= hi);
  if (b < 0) b = T > 40 ? 0 : L.buckets.length - 1;
  const t = L.table[b]![k]!;
  let v = 0;
  for (let j = 1; j <= Math.min(copies, 3); j++) v += t[j - 1]!;
  if (copies > 3) v += (copies - 3) * 0.5 * t[2]!;
  return v;
}

// Expected price of letter k at 1-based round `round`.
export function phasePrice(round: number, k: number, recent = false): number | null {
  const P = recent && PHASE_RECENT ? PHASE_RECENT : PHASE;
  if (!P) return null;
  const s = P.cuts.findIndex((c) => round <= c);
  return P.prices[s < 0 ? P.prices.length - 1 : s]![k]!;
}

// Future points per coin at `T` auctions left, from the same regression as the
// leave values (its balance term). 0 when no auctions are left to spend in.
export function coinValue(T: number): number {
  if (!LEAVE?.meta || T <= 2) return 0;
  let b = LEAVE.buckets.findIndex(([lo, hi]) => T >= lo && T <= hi);
  if (b < 0) b = T > 40 ? 0 : LEAVE.buckets.length - 1;
  return Math.max(0, LEAVE.meta[b]!.balCoef / 100);
}
