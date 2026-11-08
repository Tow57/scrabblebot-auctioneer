import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Identity } from "spacetimedb";
import { DbConnection, tables, type SubscriptionHandle } from "./module_bindings/index.js";
import { AuctionClock, BidExposureLedger, BotController, estimatePrice, indexRows, parseTournamentId, reconstructInitialRack, type MatchSnapshot } from "./client.js";
import { StrategyWorker } from "./worker-client.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "auctioneer";
const DEBUG = process.env.BOT_DEBUG === "1";

async function main(): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(BOT_NAME)) throw new Error("BOT_NAME is a local token-file label; use 1–40 letters, digits, underscores or hyphens");
  const tournamentId = parseTournamentId(process.env.TOURNAMENT_ID);
  const tokenPath = join(process.cwd(), `.token-${BOT_NAME}`);
  let token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    try { token = readFileSync(tokenPath, "utf8").trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read the saved bot token");
    }
  }
  if (!token) throw new Error("No bot token. Link your account at /account, create a team at /team/new, generate a token at /team, then set BOT_TOKEN locally. See README.md.");

  const worker = new StrategyWorker(process.env.BOT_DICTIONARY);
  await worker.start(); // Missing/malformed dictionaries stop before any network activity.
  const auctionClock = new AuctionClock(); // Preserved across reconnects in this process.
  const bidExposure = new BidExposureLedger(); // Also survives full controller replacement.
  let recoveryInitialized = false;
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let connection: DbConnection | undefined;
  let controller: BotController | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let online = false;
  let resetSession: (() => void) | undefined;
  const log = (message: string) => console.log(`[${BOT_NAME}] ${message}`);

  function stop(code = 0): void {
    if (stopped) return;
    stopped = true;
    online = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    controller?.stop();
    loopDelay.disable();
    worker.stop();
    const previous = connection;
    connection = undefined;
    try { previous?.disconnect(); } catch { /* socket may already be closed */ }
    process.exitCode = code;
  }
  const fatal = (message: string) => { console.error(`[${BOT_NAME}] ${message}`); stop(1); };
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());

  function retryConnection(): void {
    if (stopped || reconnectTimer) return;
    if (++retries > 5) { fatal("Connection could not be established after five retries; check network, STDB_HOST/STDB_DB and bot credentials."); return; }
    const delay = Math.min(30_000, 1000 * 2 ** (retries - 1));
    log(`connection unavailable; retrying in ${delay / 1000}s`);
    const previous = connection;
    connection = undefined;
    online = false;
    controller?.stop();
    try { previous?.disconnect(); } catch { /* already closed */ }
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, delay);
  }

  function install(c: DbConnection, identity: Identity, freshToken: string): void {
    if (stopped || connection !== c) return;
    token = freshToken;
    retries = 0;
    online = true;
    let baseReady = false;
    let ownReady = false;
    let myBotId: bigint | undefined;
    let ownSubscription: SubscriptionHandle | undefined;
    let lifecycleScheduled = false;
    let joinPending = false;
    let nextJoinAt = 0;
    let registrationPending = false;
    let registrationStartedAt = 0;
    let registrationConfirmed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let sessionEpoch = 0;
    const matchSubscriptions = new Map<bigint, { ready: boolean; handle?: SubscriptionHandle; workerAtStart: ReturnType<StrategyWorker["stats"]> }>();
    const matchStates = indexRows(c.db.matchState, schedule);
    const debugSeen = new Map<string, bigint | undefined>();

    function diagnostic(stage: string, snapshot: MatchSnapshot, detail: string): void {
      if (!DEBUG) return;
      const match = matchStates.rows.get(snapshot.matchId);
      const expected = match?.currentAuctionId;
      const key = `${snapshot.matchId}/${stage}`;
      if (debugSeen.has(key) && debugSeen.get(key) === expected) return;
      debugSeen.set(key, expected);
      const cached = expected === undefined ? undefined : c.db.auction.id.find(expected);
      const now = Date.now();
      log(`[debug] ${JSON.stringify({ stage, matchId: String(snapshot.matchId), expectedAuctionId: expected === undefined ? null : String(expected),
        cachedAuctionId: cached ? String(cached.id) : null, cachedStatus: cached?.status.tag ?? null,
        letter: snapshot.letter, bagTotal: snapshot.bagTotal, balance: snapshot.myBalance,
        remainingMs: snapshot.closesAtMs === null ? null : snapshot.closesAtMs - performance.now(),
        clockCalibrated: snapshot.closesAtMs !== null,
        rawWallRemainingMs: cached ? Number(cached.closesAt.microsSinceUnixEpoch / 1000n) - now : null,
        rawReceiptAfterOpenMs: cached ? now - Number(cached.opensAt.microsSinceUnixEpoch / 1000n) : null, detail })}`);
    }

    resetSession = () => {
      sessionEpoch++;
      online = false;
      baseReady = false;
      ownReady = false;
      joinPending = false;
      registrationPending = false;
      for (const sub of matchSubscriptions.values()) sub.ready = false;
      controller?.disconnected();
    };

    function schedule(): void {
      if (lifecycleScheduled || stopped || connection !== c) return;
      lifecycleScheduled = true;
      setImmediate(() => { lifecycleScheduled = false; reconcile(); });
    }
    function wakeAfter(delay: number): void {
      if (poll || stopped || connection !== c) return;
      poll = setTimeout(() => { poll = undefined; schedule(); }, delay);
      poll.unref();
    }
    function subscriptionError(): void {
      if (connection !== c || stopped) return;
      fatal("Subscription failed. Check the configured database and generated bindings; no actions will be sent with incomplete state.");
    }
    function snapshots(): MatchSnapshot[] {
      if (!online || !baseReady || !ownReady || myBotId === undefined || connection !== c) return [];
      const result: MatchSnapshot[] = [];
      for (const p of c.db.matchParticipant.iter()) {
        if (p.botId !== myBotId) continue;
        const match = matchStates.rows.get(p.matchId);
        if (match?.status.tag !== "Running" || !matchSubscriptions.get(p.matchId)?.ready) continue;
        const auction = match.currentAuctionId === undefined ? undefined : c.db.auction.id.find(match.currentAuctionId);
        const open = auction?.status.tag === "Open" ? auction : undefined;
        const rack = new Map<string, number>();
        for (const h of c.db.myRack.iter()) if (h.matchId === match.id) rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
        const participants = [...c.db.matchParticipant.iter()].filter(x => x.matchId === match.id);
        const prices = [...c.db.auctionResult.iter()].filter(x => x.matchId === match.id)
          .sort((a, b) => a.closedAt.microsSinceUnixEpoch < b.closedAt.microsSinceUnixEpoch ? -1
            : a.closedAt.microsSinceUnixEpoch > b.closedAt.microsSinceUnixEpoch ? 1
            : a.auctionId < b.auctionId ? -1 : a.auctionId > b.auctionId ? 1 : 0).map(x => Number(x.paid));
        const snapshot: MatchSnapshot = {
          matchId: match.id, auctionId: open?.id ?? null, letter: open?.letter ?? "",
          myBalance: Number(p.balance), score: Number(p.score), myRack: rack,
          bagTotal: match.bagTotal, participantCount: participants.length,
          auctionType: match.auctionType.tag,
          closesAtMs: open ? auctionClock.deadlineFor(Number(open.closesAt.microsSinceUnixEpoch / 1000n)) : null,
          estimatedPrice: estimatePrice(prices),
        };
        if (process.env.BOT_COPIED_POLICY === "lala" && open) {
          const observedAuctions = [...c.db.auctionResult.iter()].filter(x => x.matchId === match.id)
            .map(x => ({ auctionId: x.auctionId, letter: x.letter, winnerBotId: x.winnerBotId ?? null, paid: Number(x.paid), closedAtMicros: x.closedAt.microsSinceUnixEpoch }));
          const plays = [...c.db.wordPlay.iter()].filter(x => x.matchId === match.id)
            .map(x => ({ botId: x.botId, word: x.word, playedAtMicros: x.playedAt.microsSinceUnixEpoch }));
          const initialOwnRack = reconstructInitialRack(myBotId, rack, observedAuctions, plays);
          const expectedResults = 98 - 5 * participants.length - (match.bagTotal + 1);
          // A complete scoped subscription plus conservation protects replay and
          // cold mid-match startup. Never substitute today's rack for the deal.
          const historyValid = observedAuctions.length === expectedResults
            && observedAuctions.every(x => x.auctionId !== open.id && x.closedAtMicros <= open.opensAt.microsSinceUnixEpoch);
          if (initialOwnRack && historyValid) {
            snapshot.copiedLala = { ownBotId: myBotId, initialOwnRack,
              participants: participants.map(x => ({ botId: x.botId, balance: Number(x.balance), score: Number(x.score) })),
              observedAuctions, plays };
          }
          // Include every public opponent update in worker staleness checks.
          // Words committed during this auction are valid after its open time.
          snapshot.copiedLalaRevision = `${participants.map(x => `${x.botId}:${x.balance}:${x.score}`).join(",")}/${observedAuctions.map(x => `${x.auctionId}:${x.letter}:${x.winnerBotId}:${x.paid}:${x.closedAtMicros}`).join(",")}/${plays.map(x => `${x.botId}:${x.word}:${x.playedAtMicros}`).join(",")}/${historyValid && initialOwnRack ? "ready" : "incomplete"}`;
        }
        result.push(snapshot);
        diagnostic("snapshot", snapshot, "committed subscription cache");
      }
      return result;
    }

    controller = new BotController({ read: snapshots, evaluate: s => worker.evaluate(s),
      submitBid: (auctionId, amount) => c.reducers.submitBid({ auctionId, amount }),
      submitWord: (matchId, word) => c.reducers.submitWord({ matchId, word }), report: log,
      diagnostic: DEBUG ? diagnostic : undefined, bidExposure });

    function tournament(): void {
      if (tournamentId === undefined || myBotId === undefined) return;
      const t = c.db.tournament.id.find(tournamentId);
      if (!t) { fatal(`Tournament ${tournamentId} does not exist in ${DB_NAME}. Use the organizer's current id.`); return; }
      const entry = [...c.db.tournamentEntry.iter()].find(e => e.tournamentId === tournamentId && e.botId === myBotId);
      if (t.status.tag === "Ended" || t.status.tag === "ForceEnded") {
        if (registrationConfirmed) { log(`tournament ${tournamentId} finished; stopping cleanly`); stop(); }
        else fatal(`Tournament ${tournamentId} has ended; obtain the upcoming tournament id.`);
        return;
      }
      if (entry) {
        if (!registrationConfirmed) log(`verified entry for bot ${myBotId} in tournament ${tournamentId}; staying out of practice lobbies`);
        registrationConfirmed = true;
        registrationPending = false;
        return;
      }
      if (t.status.tag !== "Registration") { fatal(`Tournament ${tournamentId} is not accepting entries and this bot is not registered.`); return; }
      if (registrationPending) {
        if (Date.now() - registrationStartedAt > 5000) fatal("Tournament registration was not confirmed in the server cache; reconnect and verify the tournament page.");
        else wakeAfter(100);
        return;
      }
      registrationPending = true;
      registrationStartedAt = Date.now();
      const epoch = sessionEpoch;
      log(`registering bot ${myBotId} for tournament ${tournamentId}`);
      void c.reducers.registerForTournament({ tournamentId }).then(() => schedule()).catch(() => {
        // A replay may already contain a successful entry. Verify before failing.
        setImmediate(() => {
          if (stopped || connection !== c || !online || epoch !== sessionEpoch) return;
          const exists = [...c.db.tournamentEntry.iter()].some(e => e.tournamentId === tournamentId && e.botId === myBotId);
          if (!exists) fatal(`Tournament ${tournamentId} registration was rejected; check registration status and bot credentials.`);
          else schedule();
        });
      });
      wakeAfter(100);
    }

    function reconcile(): void {
      if (stopped || connection !== c || !online || !baseReady || !ownReady || myBotId === undefined) return;
      const running = new Set([...c.db.matchParticipant.iter()].filter(p => p.botId === myBotId && matchStates.rows.get(p.matchId)?.status.tag === "Running").map(p => p.matchId));
      // Only this fully committed own-running set proves a match has ended.
      // Cold startup may resume a private bid from a previous process; seed
      // that uncertainty once, never for newly joined matches or reconnects.
      bidExposure.retainRunning(running);
      if (!recoveryInitialized) { bidExposure.markUnknown(running); recoveryInitialized = true; }
      for (const [id, sub] of matchSubscriptions) if (!running.has(id)) {
        const metrics = controller?.stats(id);
        const latest = worker.stats();
        const workerDelta = Object.fromEntries(Object.entries(latest).map(([key, value]) => [key, value - sub.workerAtStart[key as keyof typeof latest]]));
        log(`[metrics] ${JSON.stringify({ matchId: String(id), controller: metrics ?? null, worker: workerDelta,
          eventLoopDelayMs: { mean: loopDelay.mean / 1e6, p95: loopDelay.percentile(95) / 1e6, max: loopDelay.max / 1e6 } })}`);
        loopDelay.reset();
        matchSubscriptions.delete(id);
        for (const key of debugSeen.keys()) if (key.startsWith(`${id}/`)) debugSeen.delete(key);
        try { sub.handle?.unsubscribe(); } catch { /* closed connection */ }
        log(`match ${id} ended; cleared its subscriptions`);
      }
      for (const id of running) if (!matchSubscriptions.has(id)) {
        const sub: { ready: boolean; handle?: SubscriptionHandle; workerAtStart: ReturnType<StrategyWorker["stats"]> } = { ready: false, workerAtStart: worker.stats() };
        matchSubscriptions.set(id, sub);
        sub.handle = c.subscriptionBuilder().onApplied(() => { sub.ready = true; schedule(); }).onError(subscriptionError).subscribe([
          tables.auction.where(r => r.matchId.eq(id)),
          tables.auctionResult.where(r => r.matchId.eq(id)),
          tables.wordPlay.where(r => r.matchId.eq(id)),
          tables.matchParticipant.where(r => r.matchId.eq(id)),
          tables.myRack.where(r => r.matchId.eq(id)),
        ]);
      }
      controller?.refresh();
      if (tournamentId !== undefined) { tournament(); return; }
      if (running.size || joinPending || Date.now() < nextJoinAt) return;
      const lobby = c.db.openLobbies.iter().next().value;
      if (!lobby) { wakeAfter(1000); return; }
      if ([...c.db.openLobbyMembers.iter()].some(m => m.lobbyId === lobby.id && m.botId === myBotId)) return;
      joinPending = true;
      const epoch = sessionEpoch;
      log("joining practice lobby");
      void c.reducers.joinLobby({}).then(() => { if (epoch !== sessionEpoch) return; joinPending = false; schedule(); }).catch(() => {
        if (stopped || connection !== c || !online || epoch !== sessionEpoch) return;
        joinPending = false;
        nextJoinAt = Date.now() + 2000;
        log("lobby join declined; waiting for current activity to finish");
        wakeAfter(2000);
      });
    }

    for (const table of [c.db.matchParticipant, c.db.auction, c.db.auctionResult, c.db.wordPlay, c.db.myRack, c.db.openLobbies, c.db.openLobbyMembers, c.db.tournament, c.db.tournamentEntry]) {
      table.onInsert(schedule); table.onUpdate(schedule); table.onDelete(schedule);
    }
    c.db.auction.onInsert((ctx, auction) => {
      if (auction.status.tag === "Open" && auctionClock.observe(Number(auction.opensAt.microsSinceUnixEpoch / 1000n), ctx.event.tag)) schedule();
    });
    c.subscriptionBuilder().onApplied(() => {
      matchStates.rebuild();
      baseReady = true;
      const credential = c.db.botCredential.identity.find(identity);
      if (!credential) { fatal("This token is not a bot credential. Generate a bot token on your team page and set BOT_TOKEN locally."); return; }
      try { writeFileSync(tokenPath, token ?? freshToken, { mode: 0o600 }); }
      catch { fatal("Could not persist bot token; check the current folder permissions."); return; }
      myBotId = credential.botId;
      if (!ownSubscription) {
        log(`acting as '${c.db.bot.id.find(myBotId)?.name ?? "bot"}' (id ${myBotId})`);
        ownSubscription = c.subscriptionBuilder().onApplied(() => { ownReady = true; schedule(); }).onError(subscriptionError).subscribe([
          tables.matchParticipant.where(r => r.botId.eq(myBotId!)),
          ...(tournamentId === undefined ? [] : [tables.tournamentEntry.where(r => r.botId.eq(myBotId!))]),
        ]);
      }
      schedule();
    }).onError(subscriptionError).subscribe([
      tables.botCredential.where(r => r.identity.eq(identity)), tables.bot,
      tables.matchState, tables.openLobbies, tables.openLobbyMembers,
      ...(tournamentId === undefined ? [] : [tables.tournament.where(r => r.id.eq(tournamentId))]),
    ]);
  }

  function connect(): void {
    if (stopped) return;
    log(`connecting to ${DB_NAME} at ${HOST}${tournamentId === undefined ? " (practice)" : ` (tournament ${tournamentId})`}`);
    connection = DbConnection.builder().withUri(HOST).withDatabaseName(DB_NAME).withToken(token)
      .withAutomaticReconnect({ minDelayMs: 500, maxDelayMs: 5000 })
      .onConnect(install)
      .onAutomaticReconnect((_c, _identity, freshToken) => {
        token = freshToken;
        online = true;
        // Existing onApplied callbacks resume actions only after subscription replay.
        log("reconnected; waiting for refreshed subscriptions");
      })
      .onDisconnect((ctx, _error, nextAttempt) => {
        if (connection !== ctx || stopped) return;
        resetSession?.();
        log("disconnected; actions suspended");
        if (nextAttempt === undefined) retryConnection();
      })
      .onConnectError((_ctx, _error, nextAttempt) => {
        if (!stopped && nextAttempt === undefined) retryConnection();
      }).build();
  }
  connect();
}

void main().catch(error => {
  // Only locally constructed errors are expected during pre-network startup.
  console.error(`ScrabbleBot startup failed: ${error instanceof Error ? error.message : "unknown startup failure"}`);
  process.exitCode = 1;
});
