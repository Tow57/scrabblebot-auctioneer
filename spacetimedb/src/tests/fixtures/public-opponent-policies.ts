// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Clockwork Labs. The repository LICENSE retains the MIT notice.
// Numerical floors adapted from the pinned, MIT-licensed public sources below.
// These stress archetypes are NOT full copies or verified replicas of those bots:
// they combine only the published acquisition floor with frozen tournament-v1
// search, word timing, completion bids, and endgame handling. No strength claim.
import { LETTER_VALUE } from "./v1/dictionary";
import type { StrategyContext, StrategyDecision } from "./v1/strategy";
import { makeScaledV1, type OpponentPolicy } from "./opponent-policies";

export type PublicFormulaKind = "premium-floor" | "linear-face";
type DictionaryInput = Parameters<typeof makeScaledV1>[1];

export const PUBLIC_POLICY_SOURCES = {
  "premium-floor": {
    author: "AlvinManojAlex",
    source: "https://github.com/AlvinManojAlex/scrabblebot/blob/305efa54d4429ebd2907d4d6df5e7f971b85d82d/bot-starter/src/strategy.ts#L162-L185",
    floorLogic: "https://github.com/AlvinManojAlex/scrabblebot/blob/305efa54d4429ebd2907d4d6df5e7f971b85d82d/bot-starter/src/strategy.ts#L237-L271",
    license: "MIT",
    licenseUrl: "https://github.com/AlvinManojAlex/scrabblebot/blob/305efa54d4429ebd2907d4d6df5e7f971b85d82d/LICENSE",
  },
  "linear-face": {
    author: "micahlai",
    source: "https://github.com/micahlai/scrabblebot/blob/6e26a0e2652cbebeae6cc382a977b3ce95feb619/bot-starter/src/strategy.ts#L293-L306",
    floorLogic: "https://github.com/micahlai/scrabblebot/blob/6e26a0e2652cbebeae6cc382a977b3ce95feb619/bot-starter/src/strategy.ts#L394-L417",
    license: "MIT",
    licenseUrl: "https://github.com/micahlai/scrabblebot/blob/6e26a0e2652cbebeae6cc382a977b3ce95feb619/LICENSE",
  },
} as const;

const PREMIUM = new Set(["J", "Q", "X", "Z"]);
const HIGH = new Set(["C", "H", "Y", "K", "F", "V", "W"]);

/** Published Alvin acquisition floors; the Monte Carlo valuation is not copied. */
export function publishedPremiumFloor(ctx: StrategyContext): number {
  const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
  if (!balance || ctx.bagTotal <= 1 || !/^[A-Z]$/.test(ctx.letter)) return 0;
  const vowel = "AEIOU".includes(ctx.letter);
  let floor: number;
  if (vowel) {
    floor = "EI".includes(ctx.letter)
      ? Math.max(11, Math.min(22, Math.floor(balance * 0.18)))
      : Math.max(11, Math.min(18, Math.floor(balance * 0.16)));
  } else if (PREMIUM.has(ctx.letter)) {
    floor = Math.max(8, Math.min(25, Math.floor(balance * 0.22)));
  } else if (HIGH.has(ctx.letter)) {
    floor = Math.max(8, Math.min(14, Math.floor(balance * 0.12)));
  } else {
    floor = 8;
  }
  if ((ctx.myRack.get(ctx.letter) ?? 0) >= 2) floor *= 0.5;
  const earlyBoost = 1 + 0.3 * Math.max(0, Math.min(1, (ctx.bagTotal - 10) / 55));
  const cap = Math.max(0, Math.min(balance * 0.28, balance - 5));
  let bid = Math.round(Math.min(floor * earlyBoost, cap));
  // The source is Vickrey-only. First-price stress uses the common v1 shading.
  if (ctx.auctionType === "FirstPrice" && bid > 0) bid = Math.max(1, Math.floor(bid * 0.8));
  return Math.min(balance, bid);
}

/** Published micahlai base floor; optional target/quality features are excluded. */
export function publishedLinearFaceFloor(ctx: StrategyContext): number {
  const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
  if (!balance || ctx.bagTotal <= 1 || !/^[A-Z]$/.test(ctx.letter)) return 0;
  let size = 0;
  let vowels = 0;
  for (const [letter, count] of ctx.myRack) {
    size += count;
    if ("AEIOU".includes(letter)) vowels += count;
  }
  const isVowel = "AEIOU".includes(ctx.letter);
  const balanceBonus = isVowel ? (vowels < size / 3 ? 3 : 0) : (vowels > size / 2 ? 2 : 0);
  const have = ctx.myRack.get(ctx.letter) ?? 0;
  let value = (LETTER_VALUE[ctx.letter] * 1.5 + 7 + balanceBonus) / (1 + have * 0.75);
  // Real completion bids still come from v1; this only suppresses the generic
  // Q floor without U. ENABLE does not contain QI, so I is not a replacement.
  if (ctx.letter === "Q" && !(ctx.myRack.get("U") ?? 0)) value = 1;
  if (size >= 14) value *= 0.45;
  if (ctx.auctionType === "FirstPrice") {
    const market = Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 8;
    value = Math.min(value * 0.7, market + 1);
  }
  return Math.max(0, Math.floor(Math.min(balance, balance * 0.38, value)));
}

export function makePublicFormulaOpponent(kind: PublicFormulaKind, dictionary: DictionaryInput): OpponentPolicy {
  if (kind !== "premium-floor" && kind !== "linear-face") throw new Error(`Unknown public formula: ${kind}`);
  const frozen = makeScaledV1(1, dictionary);
  return {
    decide(ctx): StrategyDecision {
      const started = performance.now();
      const base = frozen.decide(ctx);
      if (ctx.bagTotal <= 1) return base;
      const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
      const floor = kind === "premium-floor" ? publishedPremiumFloor(ctx) : publishedLinearFaceFloor(ctx);
      return { ...base, bid: Math.min(balance, Math.max(base.bid, floor)), elapsedMs: performance.now() - started };
    },
  };
}
