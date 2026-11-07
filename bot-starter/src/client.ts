/** Network-independent action controller. All inputs come from committed SDK caches. */
export interface MatchSnapshot {
  matchId: bigint;
  auctionId: bigint | null;
  letter: string;
  myBalance: number;
  score: number;
  myRack: Map<string, number>;
  bagTotal: number;
  participantCount: number;
  auctionType: "Vickrey" | "FirstPrice";
  /** Auction deadline in this process's monotonic clock domain; null until calibrated. */
  closesAtMs: number | null;
  estimatedPrice: number;
}

export interface Decision {
  bid: number;
  word: string | null;
  plan?: string[];
  elapsedMs?: number;
  roundTripMs?: number;
  queuedMs?: number;
}

interface RowEventSource<Row> {
  iter(): Iterable<Row>;
  onInsert(callback: (context: unknown, row: Row) => void): void;
  onUpdate(callback: (context: unknown, oldRow: Row, row: Row) => void): void;
  onDelete(callback: (context: unknown, row: Row) => void): void;
}

/** SDK 2.12 client unique-index find() scans rows; maintain a real key index. */
export function indexRows<Row extends { id: bigint }>(table: RowEventSource<Row>, changed: () => void) {
  const rows = new Map<bigint, Row>();
  table.onInsert((_ctx, row) => { rows.set(row.id, row); changed(); });
  table.onUpdate((_ctx, old, row) => { if (old.id !== row.id) rows.delete(old.id); rows.set(row.id, row); changed(); });
  table.onDelete((_ctx, row) => { rows.delete(row.id); changed(); });
  return {
    rows: rows as ReadonlyMap<bigint, Row>,
    // Rebuild once after initial subscription or replay, also removing rows
    // that disappeared while disconnected even if no row callback was emitted.
    rebuild(): void {
      rows.clear();
      for (const row of table.iter()) rows.set(row.id, row);
    },
  };
}

export interface MatchMetrics {
  evaluations: number;
  fallbacks: number;
  staleResults: number;
  acceptedBids: number;
  rejectedBids: number;
  deadlineSkips: number;
  uncalibratedSkips: number;
  acceptedWords: number;
  rejectedWords: number;
  roundTripTotalMs: number;
  roundTripMaxMs: number;
  computeTotalMs: number;
}
function matchMetrics(): MatchMetrics {
  return { evaluations: 0, fallbacks: 0, staleResults: 0, acceptedBids: 0, rejectedBids: 0,
    deadlineSkips: 0, uncalibratedSkips: 0, acceptedWords: 0, rejectedWords: 0,
    roundTripTotalMs: 0, roundTripMaxMs: 0, computeTotalMs: 0 };
}

/** Map server epoch timestamps into a local monotonic clock without wall-clock trust. */
export class AuctionClock {
  private readonly offsets: number[] = [];
  private latestOpen = -Infinity;

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}

  observe(serverOpenMs: number, eventTag: string): boolean {
    // Subscription snapshots can contain an auction already near its close.
    // Only genuinely new transaction events establish a receipt-time anchor.
    if (eventTag !== "Transaction" && eventTag !== "Reducer") return false;
    if (!Number.isFinite(serverOpenMs) || serverOpenMs <= this.latestOpen) return false;
    this.latestOpen = serverOpenMs;
    this.offsets.push(this.monotonicNow() - serverOpenMs);
    if (this.offsets.length > 8) this.offsets.shift();
    return true;
  }

  deadlineFor(serverCloseMs: number): number | null {
    if (!this.offsets.length || !Number.isFinite(serverCloseMs)) return null;
    // The earliest recent receipt yields the most conservative deadline.
    // A delayed packet must not replace a faster anchor and extend the window.
    return serverCloseMs + Math.min(...this.offsets);
  }
}

export function parseTournamentId(value: string | undefined): bigint | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > (1n << 64n) - 1n) throw new Error("TOURNAMENT_ID must be a positive u64 integer from the tournament page");
  return BigInt(value);
}

export function rackKey(rack: Map<string, number>): string {
  return [...rack].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c}:${n}`).join(",");
}

export function snapshotKey(s: MatchSnapshot): string {
  return `${s.matchId}/${s.auctionId}/${s.letter}/${s.myBalance}/${s.score}/${s.bagTotal}/${s.participantCount}/${s.auctionType}/${s.closesAtMs}/${s.estimatedPrice}/${rackKey(s.myRack)}`;
}

export function estimatePrice(prices: number[]): number {
  let estimate = 3;
  for (const price of prices) if (Number.isFinite(price) && price > 0) estimate = estimate * 0.8 + price * 0.2;
  return estimate;
}

/** A bounded emergency bid; never guesses that an unusable final tile has value. */
export function fallbackBid(s: MatchSnapshot): number {
  if (!s.letter || s.bagTotal === 0 || !Number.isFinite(s.myBalance)) return 0;
  const points: Record<string, number> = { B: 3, C: 3, D: 2, F: 4, G: 2, H: 4, J: 8, K: 5, M: 3, P: 3, Q: 10, V: 4, W: 4, X: 8, Y: 4, Z: 10 };
  const premium = (s.myRack.get(s.letter) ?? 0) === 0 ? 2 : 0;
  return Math.max(0, Math.min(Math.floor(s.myBalance), (points[s.letter] ?? 1) + premium));
}

function canSpell(word: string, rack: Map<string, number>): boolean {
  if (!/^[A-Z]{2,}$/.test(word)) return false;
  const needed = new Map<string, number>();
  for (const c of word) needed.set(c, (needed.get(c) ?? 0) + 1);
  return [...needed].every(([c, n]) => (rack.get(c) ?? 0) >= n);
}

function cachedWord(snapshot: MatchSnapshot, plan: string[]): string | null {
  const legal = plan.filter(word => canSpell(word, snapshot.myRack));
  const longWord = legal.find(word => word.length >= 7);
  const size = [...snapshot.myRack.values()].reduce((sum, n) => sum + n, 0);
  return longWord ?? ((snapshot.myBalance < 12 || size >= 12 || snapshot.bagTotal <= 3) ? legal[0] ?? null : null);
}

interface WordPending {
  rack: string;
  acknowledged: boolean;
}
interface MatchActions {
  metrics: MatchMetrics;
  requested?: string;
  plan?: string[];
  word?: WordPending;
  bid?: { auctionId: bigint; amount: number; pending: boolean; acknowledged: boolean; desired?: number; desiredKey?: string };
  retry?: ReturnType<typeof setTimeout>;
}

export interface ControllerOptions {
  read: () => MatchSnapshot[];
  evaluate: (snapshot: MatchSnapshot) => Promise<Decision | null>;
  submitBid: (auctionId: bigint, amount: bigint) => Promise<unknown>;
  submitWord: (matchId: bigint, word: string) => Promise<unknown>;
  report?: (message: string) => void;
  now?: () => number;
  retryMs?: number;
  diagnostic?: (stage: string, snapshot: MatchSnapshot, detail: string) => void;
}

export class BotController {
  private readonly matches = new Map<bigint, MatchActions>();
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private epoch = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: ControllerOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  stats(matchId: bigint): MatchMetrics | undefined {
    const metrics = this.matches.get(matchId)?.metrics;
    return metrics ? { ...metrics } : undefined;
  }

  /** Collapse all row callbacks from a transaction before reading the cache. */
  refresh(): void {
    if (this.stopped || this.immediate) return;
    this.immediate = setImmediate(() => {
      this.immediate = undefined;
      this.reconcile();
    });
  }

  disconnected(): void {
    this.epoch++;
    for (const state of this.matches.values()) if (state.retry) clearTimeout(state.retry);
    this.matches.clear();
  }

  stop(): void {
    this.stopped = true;
    if (this.immediate) clearImmediate(this.immediate);
    this.disconnected();
  }

  private current(id: bigint): MatchSnapshot | undefined {
    return this.options.read().find(s => s.matchId === id);
  }

  private retry(id: bigint, state: MatchActions): void {
    if (state.retry || this.stopped) return;
    state.retry = setTimeout(() => {
      state.retry = undefined;
      if (this.matches.get(id) !== state) return;
      state.requested = undefined;
      this.refresh();
    }, this.options.retryMs ?? 75);
  }

  private reconcile(): void {
    const snapshots = this.options.read();
    const live = new Set(snapshots.map(s => s.matchId));
    for (const [id, state] of this.matches) {
      if (!live.has(id)) {
        if (state.retry) clearTimeout(state.retry);
        this.matches.delete(id);
      }
    }
    for (const snapshot of snapshots) {
      const state = this.matches.get(snapshot.matchId) ?? { metrics: matchMetrics() };
      this.matches.set(snapshot.matchId, state);
      if (state.word?.acknowledged && state.word.rack !== rackKey(snapshot.myRack)) {
        state.word = undefined;
        state.requested = undefined;
      }
      const key = snapshotKey(snapshot);
      if (state.requested === key) continue;
      state.requested = key;
      const epoch = this.epoch;
      const requestedAt = this.now();
      state.metrics.evaluations++;
      void this.options.evaluate(snapshot).then(decision => {
        if (this.stopped || epoch !== this.epoch || this.matches.get(snapshot.matchId) !== state) return;
        const roundTripMs = this.now() - requestedAt;
        state.metrics.roundTripTotalMs += roundTripMs;
        state.metrics.roundTripMaxMs = Math.max(state.metrics.roundTripMaxMs, roundTripMs);
        if (!decision) state.metrics.fallbacks++;
        if (Number.isFinite(decision?.elapsedMs)) state.metrics.computeTotalMs += decision!.elapsedMs!;
        const fresh = this.current(snapshot.matchId);
        if (!fresh || snapshotKey(fresh) !== key) {
          state.metrics.staleResults++;
          this.options.diagnostic?.("stale", snapshot, "worker result no longer matches the committed snapshot");
          return;
        }
        this.options.diagnostic?.("decision", fresh, `bid=${decision?.bid ?? fallbackBid(fresh)} word=${decision?.word ?? "null"} fallback=${decision === null} roundTripMs=${roundTripMs.toFixed(1)} computeMs=${decision?.elapsedMs?.toFixed(1) ?? "null"} queuedMs=${decision?.queuedMs?.toFixed(1) ?? "null"}`);
        if (decision?.plan) state.plan = decision.plan;
        this.bid(fresh, state, decision?.bid ?? fallbackBid(fresh));
        const word = decision ? decision.word : cachedWord(fresh, state.plan ?? []);
        if (word && !state.word) this.word(fresh, state, word);
        if (!decision) this.retry(snapshot.matchId, state);
      }).catch(() => {
        if (epoch !== this.epoch || this.matches.get(snapshot.matchId) !== state) return;
        state.metrics.fallbacks++;
        const roundTripMs = this.now() - requestedAt;
        state.metrics.roundTripTotalMs += roundTripMs;
        state.metrics.roundTripMaxMs = Math.max(state.metrics.roundTripMaxMs, roundTripMs);
        const fresh = this.current(snapshot.matchId);
        if (fresh && snapshotKey(fresh) === key) {
          this.bid(fresh, state, fallbackBid(fresh));
          const word = cachedWord(fresh, state.plan ?? []);
          if (word && !state.word) this.word(fresh, state, word);
          this.retry(snapshot.matchId, state);
        }
      });
    }
  }

  private bid(snapshot: MatchSnapshot, state: MatchActions, proposed: number): void {
    if (snapshot.auctionId === null) {
      this.options.diagnostic?.("guard", snapshot, "missing cached open auction"); return;
    }
    if (snapshot.closesAtMs === null) {
      state.metrics.uncalibratedSkips++;
      this.options.diagnostic?.("guard", snapshot, "awaiting a live server clock anchor"); return;
    }
    if (this.now() + 150 >= snapshot.closesAtMs) {
      state.metrics.deadlineSkips++;
      this.options.diagnostic?.("guard", snapshot, `deadline remainingMs=${snapshot.closesAtMs - this.now()}`); return;
    }
    if (!Number.isFinite(proposed)) { this.options.diagnostic?.("guard", snapshot, "nonfinite bid"); return; }
    const amount = Math.max(0, Math.min(Math.floor(proposed), Math.floor(snapshot.myBalance)));
    const prior = state.bid;
    if (amount === 0 && (!prior || prior.auctionId !== snapshot.auctionId || prior.amount === 0)) {
      this.options.diagnostic?.("guard", snapshot, "zero strategy bid without a prior positive bid"); return;
    }
    if (prior?.auctionId === snapshot.auctionId && prior.pending) {
      prior.desired = amount;
      prior.desiredKey = snapshotKey(snapshot);
      return;
    }
    if (prior?.auctionId === snapshot.auctionId && prior.acknowledged && prior.amount === amount) return;
    const bid: NonNullable<MatchActions["bid"]> = { auctionId: snapshot.auctionId, amount, pending: true, acknowledged: false };
    this.options.diagnostic?.("guard", snapshot, `sending amount=${amount}`);
    state.bid = bid;
    const epoch = this.epoch;
    void this.options.submitBid(snapshot.auctionId, BigInt(amount)).then(() => {
      if (epoch !== this.epoch || state.bid !== bid) return;
      bid.pending = false;
      bid.acknowledged = true;
      state.metrics.acceptedBids++;
      this.options.report?.(`bid ${amount} accepted for auction ${bid.auctionId}`);
      const fresh = this.current(snapshot.matchId);
      if (fresh && bid.desired !== undefined && bid.desired !== bid.amount && bid.desiredKey === snapshotKey(fresh)) {
        this.bid(fresh, state, bid.desired);
      } else if (fresh && snapshotKey(fresh) !== snapshotKey(snapshot)) {
        state.requested = undefined;
        this.refresh();
      }
    }).catch(() => {
      if (epoch !== this.epoch || state.bid !== bid) return;
      bid.pending = false;
      state.metrics.rejectedBids++;
      this.options.report?.(`bid rejected for auction ${bid.auctionId}; checking current state`);
      const fresh = this.current(snapshot.matchId);
      if (fresh?.auctionId === bid.auctionId && fresh.closesAtMs !== null && this.now() + 150 < fresh.closesAtMs) this.retry(snapshot.matchId, state);
    });
  }

  private word(snapshot: MatchSnapshot, state: MatchActions, word: string): void {
    if (!canSpell(word, snapshot.myRack)) return;
    const pending: WordPending = { rack: rackKey(snapshot.myRack), acknowledged: false };
    state.word = pending;
    const epoch = this.epoch;
    void this.options.submitWord(snapshot.matchId, word).then(() => {
      if (epoch !== this.epoch || state.word !== pending) return;
      pending.acknowledged = true;
      state.metrics.acceptedWords++;
      this.options.report?.(`word ${word} accepted in match ${snapshot.matchId}`);
      // Ack and view updates may arrive in either order. Reconcile only clears
      // this flight when BOTH the ack and an authoritative rack change exist.
      this.refresh();
    }).catch(() => {
      if (epoch !== this.epoch || state.word !== pending) return;
      state.word = undefined;
      state.metrics.rejectedWords++;
      this.options.report?.(`word rejected in match ${snapshot.matchId}; checking current state`);
      this.retry(snapshot.matchId, state);
    });
  }
}
