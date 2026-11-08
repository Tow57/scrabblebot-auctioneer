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
  copiedLala?: CopiedLalaPublicContext;
  copiedLalaRevision?: string;
}

export interface CopiedLalaPublicContext {
  ownBotId: bigint;
  initialOwnRack: Map<string, number>;
  participants: { botId: bigint; balance: number; score: number }[];
  observedAuctions: { auctionId: bigint; letter: string; winnerBotId: bigint | null; paid: number; closedAtMicros: bigint }[];
  plays: { botId: bigint; word: string; playedAtMicros: bigint }[];
}

/** Conservation reconstructs our private initial five from committed own data. */
export function reconstructInitialRack(ownBotId: bigint, current: Map<string, number>, auctions: CopiedLalaPublicContext["observedAuctions"], plays: CopiedLalaPublicContext["plays"]): Map<string, number> | null {
  const result = new Map(current);
  for (const auction of auctions) if (auction.winnerBotId === ownBotId) result.set(auction.letter, (result.get(auction.letter) ?? 0) - 1);
  for (const play of plays) if (play.botId === ownBotId) for (const letter of play.word) result.set(letter, (result.get(letter) ?? 0) + 1);
  for (const [letter, n] of result) {
    if (!/^[A-Z]$/.test(letter) || !Number.isSafeInteger(n) || n < 0) return null;
    if (n === 0) result.delete(letter);
  }
  return [...result.values()].reduce((sum, n) => sum + n, 0) === 5 ? result : null;
}

export interface Decision {
  bid: number;
  word: string | null;
  plan?: string[];
  elapsedMs?: number;
  roundTripMs?: number;
  queuedMs?: number;
  policy?: string;
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
  return `${s.matchId}/${s.auctionId}/${s.letter}/${s.myBalance}/${s.score}/${s.bagTotal}/${s.participantCount}/${s.auctionType}/${s.closesAtMs}/${s.estimatedPrice}/${rackKey(s.myRack)}/${s.copiedLalaRevision ?? ""}`;
}

export function estimatePrice(prices: number[]): number {
  let estimate = 3;
  for (const price of prices) if (Number.isFinite(price) && price > 0) estimate = estimate * 0.8 + price * 0.2;
  return estimate;
}

/** Emergency bids have no immediate-gain proof, so skip both terminal auctions. */
export function fallbackBid(s: MatchSnapshot): number {
  if (!s.letter || s.bagTotal <= 1 || !Number.isFinite(s.myBalance)) return 0;
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
  bid?: { auctionId: bigint; amount: number; pending: boolean; acknowledged: boolean; desired?: number; desiredKey?: string;
    needsCancellation: boolean; cancelAttempted: boolean };
  retry?: ReturnType<typeof setTimeout>;
}

interface BidExposure {
  matchId: bigint;
  auctionId: bigint | undefined;
  recovering: boolean;
  cancelAttempted: boolean;
}

/** Main-owned, memory-only knowledge of bids that may still exist on the server. */
export class BidExposureLedger {
  private readonly entries = new Map<bigint, BidExposure>();

  get size(): number { return this.entries.size; }

  private put(exposure: BidExposure): BidExposure {
    // A bot cannot enter two matches at once. Bound even malformed input,
    // without silently evicting an outstanding financial exposure.
    if (!this.entries.has(exposure.matchId) && this.entries.size >= 32) throw new Error("Too many matches in bid recovery");
    this.entries.set(exposure.matchId, exposure);
    return exposure;
  }

  /** Called once per process, after the initial own-running set is committed. */
  markUnknown(matchIds: Iterable<bigint>): void {
    for (const matchId of matchIds) if (!this.entries.has(matchId)) {
      this.put({ matchId, auctionId: undefined, recovering: true, cancelAttempted: false });
    }
  }

  /** Absence during a partial/offline replay must never call this cleanup. */
  retainRunning(matchIds: ReadonlySet<bigint>): void {
    for (const id of this.entries.keys()) if (!matchIds.has(id)) this.entries.delete(id);
  }

  observe(snapshot: MatchSnapshot): BidExposure | undefined {
    const exposure = this.entries.get(snapshot.matchId);
    if (!exposure) return undefined;
    if (snapshot.auctionId === null) {
      // This means no cached Open row, not proof that a private bid expired.
      exposure.recovering = true;
      return exposure;
    }
    if (exposure.auctionId === undefined) exposure.auctionId = snapshot.auctionId;
    if (exposure.auctionId !== snapshot.auctionId) {
      this.entries.delete(snapshot.matchId); // A different committed current auction supersedes it.
      return undefined;
    }
    return exposure;
  }

  positive(matchId: bigint, auctionId: bigint): BidExposure {
    return this.put({ matchId, auctionId, recovering: false, cancelAttempted: false });
  }

  disconnected(): void {
    for (const exposure of this.entries.values()) exposure.recovering = true;
  }

  acknowledgeZero(exposure: BidExposure | undefined): void {
    // Object identity is the request's generation token. An obsolete ACK may
    // never erase an exposure created by a newer positive request.
    if (exposure && this.entries.get(exposure.matchId) === exposure) this.entries.delete(exposure.matchId);
  }
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
  bidExposure?: BidExposureLedger;
}

export class BotController {
  private readonly matches = new Map<bigint, MatchActions>();
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private epoch = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly bidExposure: BidExposureLedger;

  constructor(private readonly options: ControllerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.bidExposure = options.bidExposure ?? new BidExposureLedger();
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
    this.bidExposure.disconnected();
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
      const exposure = this.bidExposure.observe(snapshot);
      // Recovery must not wait behind a strategy computation. Final-tile
      // cashout still runs immediately below; currency has no terminal value.
      if (exposure?.recovering && snapshot.bagTotal > 0) this.bid(snapshot, state, 0);
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
        this.act(fresh, state, decision);
        if (!decision) this.retry(snapshot.matchId, state);
      }).catch(() => {
        if (epoch !== this.epoch || this.matches.get(snapshot.matchId) !== state) return;
        state.metrics.fallbacks++;
        const roundTripMs = this.now() - requestedAt;
        state.metrics.roundTripTotalMs += roundTripMs;
        state.metrics.roundTripMaxMs = Math.max(state.metrics.roundTripMaxMs, roundTripMs);
        const fresh = this.current(snapshot.matchId);
        if (fresh && snapshotKey(fresh) === key) {
          this.act(fresh, state, null);
          this.retry(snapshot.matchId, state);
        }
      });
    }
  }

  private act(snapshot: MatchSnapshot, state: MatchActions, decision: Decision | null): void {
    if (this.bidExposure.observe(snapshot)?.recovering && snapshot.bagTotal > 0) {
      this.bid(snapshot, state, 0);
      return; // Await zero ACK or authoritative auction advance before cashout.
    }
    const planned = decision ? decision.word : cachedWord(snapshot, state.plan ?? []);
    const word = planned && canSpell(planned, snapshot.myRack) ? planned : null;
    if (state.word || word) {
      // A bid valued using letters we are about to spend must not survive
      // that cashout. Reprice only after both the ack and view update arrive.
      this.bid(snapshot, state, 0);
      if (word && !state.word) this.word(snapshot, state, word);
      return;
    }
    this.bid(snapshot, state, decision?.bid ?? fallbackBid(snapshot));
  }

  private bid(snapshot: MatchSnapshot, state: MatchActions, proposed: number): void {
    if (snapshot.auctionId === null) {
      this.options.diagnostic?.("guard", snapshot, "missing cached open auction"); return;
    }
    if (!Number.isFinite(proposed)) { this.options.diagnostic?.("guard", snapshot, "nonfinite bid"); return; }
    const amount = Math.max(0, Math.min(Math.floor(proposed), Math.floor(snapshot.myBalance)));
    if (state.word && amount > 0) { this.bid(snapshot, state, 0); return; }
    const prior = state.bid?.auctionId === snapshot.auctionId ? state.bid : undefined;
    const exposure = this.bidExposure.observe(snapshot);
    if (amount === 0 && !exposure && !prior?.needsCancellation && !(prior?.pending && (prior.desired ?? 0) > 0)) {
      this.options.diagnostic?.("guard", snapshot, "zero strategy bid without a prior positive bid"); return;
    }
    // One best-effort recovery zero may precede clock calibration. The server
    // validates its deadline and can reject it if the replay closes in transit.
    // No positive bid or subsequent uncalibrated cancellation gets this exception.
    const initialRecoveryZero = amount === 0 && exposure?.recovering && !exposure.cancelAttempted;
    if (snapshot.closesAtMs === null && !initialRecoveryZero) {
      state.metrics.uncalibratedSkips++;
      this.options.diagnostic?.("guard", snapshot, "awaiting a live server clock anchor"); return;
    }
    const remaining = snapshot.closesAtMs === null ? Infinity : snapshot.closesAtMs - this.now();
    if (remaining <= 0) {
      state.metrics.deadlineSkips++;
      this.options.diagnostic?.("guard", snapshot, "auction deadline passed"); return;
    }
    if (prior?.pending) {
      if (amount > 0 && remaining <= 150) return;
      // A cashout already invalidated this in-flight positive bid. Send its
      // queued zero before considering any value from the post-cashout rack.
      if (prior.amount > 0 && prior.desired === 0 && amount > 0) return;
      prior.desired = amount;
      prior.desiredKey = snapshotKey(snapshot);
      return;
    }
    // First zero retractions reduce exposure and may use the final 150 ms.
    // A failed cancellation can retry only with the usual safety margin.
    if (remaining <= 150 && (amount > 0 || prior?.cancelAttempted || exposure?.cancelAttempted)) {
      state.metrics.deadlineSkips++;
      this.options.diagnostic?.("guard", snapshot, `deadline remainingMs=${remaining}`); return;
    }
    if (prior?.acknowledged && prior.amount === amount) return;
    const bid: NonNullable<MatchActions["bid"]> = { auctionId: snapshot.auctionId, amount, pending: true, acknowledged: false,
      needsCancellation: amount > 0 || prior?.needsCancellation === true, cancelAttempted: amount === 0 };
    this.options.diagnostic?.("guard", snapshot, `sending amount=${amount}`);
    state.bid = bid;
    // Record before sending: a missing/rejected local ACK does not prove that
    // the positive bid failed to commit on the server.
    const sentExposure = amount > 0 ? this.bidExposure.positive(snapshot.matchId, snapshot.auctionId) : exposure;
    if (amount === 0 && sentExposure) sentExposure.cancelAttempted = true;
    const epoch = this.epoch;
    // Recovery can run directly from reconcile, so synchronous transport
    // failures must enter the same retry path as rejected reducer promises.
    // Invoke immediately to preserve zero-before-word ordering on the socket.
    let request: Promise<unknown>;
    try { request = this.options.submitBid(snapshot.auctionId, BigInt(amount)); }
    catch (error) { request = Promise.reject(error); }
    void request.then(() => {
      if (epoch !== this.epoch || state.bid !== bid) return;
      bid.pending = false;
      bid.acknowledged = true;
      bid.needsCancellation = amount > 0;
      if (amount === 0) this.bidExposure.acknowledgeZero(sentExposure);
      state.metrics.acceptedBids++;
      this.options.report?.(`bid ${amount} accepted for auction ${bid.auctionId}`);
      const fresh = this.current(snapshot.matchId);
      if (fresh && fresh.auctionId === bid.auctionId && bid.desired !== undefined && bid.desired !== bid.amount
        && (bid.desired === 0 || bid.desiredKey === snapshotKey(fresh))) {
        this.bid(fresh, state, bid.desired);
      } else if (fresh && (amount === 0 || snapshotKey(fresh) !== snapshotKey(snapshot))) {
        state.requested = undefined;
        this.refresh();
      }
    }).catch(() => {
      if (epoch !== this.epoch || state.bid !== bid) return;
      bid.pending = false;
      state.metrics.rejectedBids++;
      this.options.report?.(`bid rejected for auction ${bid.auctionId}; checking current state`);
      const fresh = this.current(snapshot.matchId);
      if (bid.amount > 0 && bid.desired === 0 && fresh?.auctionId === bid.auctionId) this.bid(fresh, state, 0);
      if (fresh?.auctionId === bid.auctionId && fresh.closesAtMs !== null && this.now() + 150 < fresh.closesAtMs) this.retry(snapshot.matchId, state);
    });
  }

  private word(snapshot: MatchSnapshot, state: MatchActions, word: string): void {
    if (!canSpell(word, snapshot.myRack)) return;
    const pending: WordPending = { rack: rackKey(snapshot.myRack), acknowledged: false };
    state.word = pending;
    const epoch = this.epoch;
    let request: Promise<unknown>;
    try { request = this.options.submitWord(snapshot.matchId, word); }
    catch (error) { request = Promise.reject(error); }
    void request.then(() => {
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
