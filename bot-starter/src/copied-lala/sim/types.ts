import type { Counts } from "../engine/letters.js";
import type { Tracker, AuctionType } from "../engine/tracker.js";

// Everything an agent may look at when deciding, from its own seat.
export interface View {
  auctionType: AuctionType;
  me: number;
  n: number;
  round: number;          // 1-based index of the open auction
  letter: number;         // letter on auction
  auctionsLeft: number;   // including this one; 1 means it is the last
  rack: Counts;
  balance: number;
  score: number;
  tracker: Tracker;
  wonLast: boolean;       // won the previous auction (sim bots play then)
  nowMs?: number;         // live only: ms left in the auction window
}

export interface Action {
  words: string[];        // played in order before the bid lands
  bid: number;
}

export interface Agent {
  readonly name: string;
  startMatch?(me: number, n: number, auctionType: AuctionType): void;
  act(view: View): Action;
  endMatch?(place: number, scores: number[]): void;
}
