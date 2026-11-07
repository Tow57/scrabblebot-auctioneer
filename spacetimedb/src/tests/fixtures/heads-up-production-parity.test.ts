import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DictionaryIndex } from "../../../../bot-starter/src/dictionary";
import { StrategyEngine } from "../../../../bot-starter/src/strategy";
import { makeFaceBidCandidate } from "./face-bid-ablation";
import { makeScaledV1 } from "./opponent-policies";
import type { StrategyContext } from "./v1/strategy";

test("configured production heads-up bids match the exact confirmed frozen face-0.3 factory", () => {
  const words = readFileSync(new URL("../../../wordlist.txt", import.meta.url), "utf8")
    .split(/\s+/).map(word => word.toUpperCase()).filter(word => /^[A-Z]{2,}$/.test(word));
  const dictionary = new DictionaryIndex(words);
  const production = new StrategyEngine(dictionary, { capitalAllowance: true, headsUpFaceBidWeight: 0.3 });
  const confirmed = makeFaceBidCandidate(dictionary, 0.3);
  const original = makeScaledV1(1, dictionary);
  const fixed = [["AT", "H"], ["ITE", "K"], ["UA", "Q"], ["OO", "Z"], ["AE", "X"],
    ["DLNUW", "I"], ["AEINR", "T"], ["RAINBOW", "S"]] as const;
  for (const [letters, letter] of fixed) {
    const myRack = new Map<string, number>();
    for (const tile of letters) myRack.set(tile, (myRack.get(tile) ?? 0) + 1);
    for (const [participantCount, auctionType, bagTotal] of [
      [2, "Vickrey", 60], [2, "Vickrey", 2], [2, "Vickrey", 1], [2, "Vickrey", 0],
      [6, "Vickrey", 60], [3, "Vickrey", 60], [2, "FirstPrice", 60],
    ] as const) {
      const ctx: StrategyContext = { myRack, letter, myBalance: 100, bagTotal,
        participantCount, auctionType, estimatedPrice: 8 };
      const expected = participantCount === 2 && auctionType === "Vickrey" ? confirmed.decide(ctx) : original.decide(ctx);
      const actual = production.decide(ctx);
      expect(actual.bid, `${letters}/${letter}/${participantCount}/${auctionType}/${bagTotal}`).toBe(expected.bid);
      expect(actual.word).toBe(expected.word);
      expect(actual.plan).toEqual(expected.plan);
      expect(actual.cashout).toBe(expected.cashout);
      expect(actual.exact).toBe(expected.exact);
    }
  }
});
