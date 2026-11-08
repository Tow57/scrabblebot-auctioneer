// Reconstructs what one player can know about a match from public events:
// which tiles are still unseen (bag plus opponents' hidden starting tiles),
// each opponent's known tiles, balances, scores and the price history.
// Shared by the live bot and the simulator so both see the same view.

import { BAG_COUNTS, STARTING_BALANCE, type Counts, A_CODE } from "./letters.js";

export type AuctionType = "Vickrey" | "FirstPrice";

export interface PriceObs {
  round: number;
  letter: number;
  paid: number;
  winner: number | null; // player index, null when unsold
}

export interface OppState {
  id: number;            // player index
  balance: number;
  score: number;
  known: Uint8Array;     // tiles we know they hold (won and not yet played)
  hidden: number;        // starting tiles never revealed
  tilesWon: number;
  spent: number;
  wordsPlayed: number;
}

export class Tracker {
  readonly me: number;
  readonly n: number;
  readonly auctionType: AuctionType;
  readonly unseen: Uint8Array;
  readonly opps: Map<number, OppState> = new Map();
  readonly prices: PriceObs[] = [];
  round = 0;
  bagRemaining: number;
  currentLetter = -1;

  constructor(me: number, players: number[], myStart: Counts, auctionType: AuctionType, startRack = 5) {
    this.me = me;
    this.n = players.length;
    this.auctionType = auctionType;
    this.unseen = Uint8Array.from(BAG_COUNTS);
    for (let k = 0; k < 26; k++) this.unseen[k] = Math.max(0, this.unseen[k]! - myStart[k]!);
    for (const p of players) {
      if (p === me) continue;
      this.opps.set(p, {
        id: p, balance: STARTING_BALANCE, score: 0, known: new Uint8Array(26),
        hidden: startRack, tilesWon: 0, spent: 0, wordsPlayed: 0,
      });
    }
    this.bagRemaining = 98 - startRack * players.length;
  }

  unseenTotal(): number {
    let t = 0;
    for (let k = 0; k < 26; k++) t += this.unseen[k]!;
    return t;
  }

  // A new auction opened for `letter`; `bagRemaining` is the bag size after
  // that letter was drawn (match_state.bag_total).
  onAuction(letter: number, bagRemaining: number): void {
    this.round++;
    this.currentLetter = letter;
    this.bagRemaining = bagRemaining;
    if (this.unseen[letter]! > 0) this.unseen[letter]!--;
  }

  onResult(letter: number, winner: number | null, paid: number): void {
    this.prices.push({ round: this.round, letter, paid, winner });
    if (winner === null || winner === this.me) return;
    const o = this.opps.get(winner);
    if (!o) return;
    o.known[letter]!++;
    o.tilesWon++;
    o.spent += paid;
  }

  onWord(player: number, word: string): void {
    if (player === this.me) return;
    const o = this.opps.get(player);
    if (!o) return;
    o.wordsPlayed++;
    for (let i = 0; i < word.length; i++) {
      const k = word.charCodeAt(i) - A_CODE;
      if (o.known[k]! > 0) o.known[k]!--;
      else {
        // Came from their hidden starting rack: now seen.
        if (o.hidden > 0) o.hidden--;
        if (this.unseen[k]! > 0) this.unseen[k]!--;
      }
    }
  }

  setStanding(player: number, balance: number, score: number): void {
    const o = this.opps.get(player);
    if (o) {
      o.balance = balance;
      o.score = score;
    }
  }

  // Auctions left including the open one.
  auctionsLeft(): number {
    return this.bagRemaining + 1;
  }
}
