# Validation record — November 7, 2026

## Verified foundation

- Official server source and generated bindings pinned to `b5ccb36aa238ad16692f8d6af54da15ef9f11324`; SDK 2.12.0. No game module changes or publication.
- Exact supplied dictionary: 172,820 words, 156,473 unique anagram signatures; SHA-256 `b819e7b67f8f2c80640ae76f0edbe59a4a1befb6de0f348463642ad49bdd2ad3`.
- TypeScript build and **46 bot tests passed**, including exhaustive packing-oracle comparisons, worker deadlines, stale bigint IDs, bid cancellation, word serialization, wall-clock skew, replay calibration, and Windows file URLs with spaces and encoded characters. Earlier clean archives also installed, built, and passed their corresponding release tests in fresh Windows directories containing spaces and `#`.
- Anonymous deployed-schema inspection matched **all 27 generated reducers and all 30 readable table/view row shapes**, including `register_for_tournament(u64)` and the private-to-bot `my_rack` view. All 61 client binding files match the pinned tracked bindings. The server binary version is not exposed by this metadata. See `deployed-compatibility.json`.
- Full organizer module suite: **183 passed**, with the expensive benchmark separately opted in.
- Actual server-reducer comparison: **30 paired Vickrey scenarios** against five frozen starter strategies. Release mean score **361.8**, baseline **30.27**; mean place **1.00** versus **3.37**; the release finished first in all 30. In-process decision p95 **15.44 ms**, maximum **29.34 ms** in that run.
- Additional first-price and expensive-bidder fixtures passed. Offline scenarios use public state and each external bot's own authenticated rack, with no simulated-bot post-final-tile advantage. Paired seeds are reproducible but can yield different later tile streams when bid patterns change RNG consumption.

See `benchmark-results.json` for the release comparison and `benchmark-core-results.json` for the original core. The benchmark driver is the same for both policies, so these results measure strategy differences rather than the starter's original transport/cooldown bugs.

The promoted capital allowance was also tested against **five previous-version core bots** over 30 paired scenarios: mean score **164.83 versus 91.9**, mean place **1.20 versus 3.03**, and **25/30 first-place finishes**. First-price cases improved too. In the separate fixed expensive-bidder fixture its score declined from 160.75 to 124.25 while still finishing first in all four cases; the policy is not uniformly superior on every opponent model. See `benchmark-capital-results.json`.

## Live verification

### Runtime refinement after v1.0

CPU profiling found that SDK 2.12 unique-index `find()` linearly scans cached rows. Repeated lookups through roughly 43,000 historical matches consumed about 12.8 seconds of a 45-second profile. The client now keeps a native match-ID map updated from row events and rebuilt after subscription replay. The next 45-second profile was 44.1 seconds idle, and the lookup stack disappeared from the major CPU consumers.

The first complete post-fix telemetry interval (match 42702) recorded 69/69 completed worker decisions, zero fallbacks, stale results, rejected bids or deadline skips; the only skipped bid was cold-start clock calibration. See `runtime-validation.json`. The isolated release snapshot built and passed **36 bot tests**, including 43,000-row lookup complexity and replay consistency. This changes cache access and observability, not the SDK schema, server rules, or production bidding policy.

The extended unchanged-policy soak completed **28 matches**, averaging **83.25 points** and **3.25th place**, with **2 shared-first finishes**. No worker timeouts, fallbacks, stale results, rejected bids/words, or deadline skips were recorded. Opponent composition varies, so this is operational evidence rather than a controlled strategy comparison. See `live-runtime-v1.1.json`.

### Cashout and bid ordering refinement

Review reproduced an obsolete-bid defect: the old controller could bid 35 for `S` using a `RAINBOW` rack, submit `RAINBOW`, and then suppress the zero-bid correction with 100 ms left. The client now cashes out first, retracts any prior positive bid, and waits for both acknowledgment and the authoritative rack change before repricing. Cancellation stays queued even if a later worker result wants a small positive bid; after cancellation acknowledgment, a fresh decision may bid again if time permits.

First zero retractions may use the final 150 ms while the auction remains open; positive bids and failure retries retain the 150 ms safety margin. No retraction is attempted after the local deadline. Emergency fallback skips the last usable purchase when it cannot prove an immediate gain; normal worker decisions retain the existing terminal all-in policy. Regression tests cover late acknowledgments, both rack/ack arrival orders, worker and word failures, and cancellation priority. Live validation of this candidate is tracked separately from the unchanged-policy soak above.

Team **Tow57**, bot **Tow57-Auctioneer**, bot ID **164**, on the organizer's production service. Credentials stay local in an ignored token file.

- Accepted live bids and words.
- Stopping/restarting the process resumed an existing running match.
- A test-only preload deliberately closed this bot's socket once. Logs show actions suspended, automatic reconnect, subscription refresh, then accepted bids again. The test did not change the game server or the laptop's network configuration.
- The initial operational soak completed **42664–42668**, but later traces exposed an important deadline defect. Those preliminary outcomes are retained in `live-validation-before-clock-fix.json` and are not the final release soak.

Fresh auction events were arriving while the laptop's wall clock made their deadlines appear expired. The release now converts fresh server auction timestamps to monotonic local deadlines, ignores subscription snapshots as clock anchors, retains calibration over reconnects, and keeps the 150 ms submission margin. A cold process may wait one auction for calibration. Post-fix traces show accepted bids while the raw wall-clock calculation was negative. No laptop or server clock setting was changed.

The final post-fix live soak **passed five completed matches**: IDs **42680, 42681, 42682, 42684, 42686**, scores **62, 80, 45, 33, 42**, places **3, 3, 4, 6, 5**. These results establish operation, not tournament dominance: the strongest public bots still outperform this heuristic entry. See `live-validation.json`.

The bot runs through the supplied PowerShell launcher with sleep prevention, a hidden hosting process, and the tested `Stop-BackgroundBot.ps1` control. Debug traces remain off in normal play.

## Rejected optional search

The eight-sample lookahead experiment scored **341.5** versus the core's **336** on starter tables, a **1.64%** increase below the required 5%. Against expensive bidders it declined from **160.75** to **149.75**, and one in-process decision took **152.66 ms**. It was rejected and removed from production source. `benchmark-lookahead-results.json` preserves the measured outcomes; the experimental source/patch remains in this chat's local work directory.

## Tournament and source release

The user confirmed **November 7, 2026, 10:45 PM America/Chicago**, giving a latest code freeze of **9:15 PM**. The service currently exposes only the old ended tournament ID 1. This bot is **not registered** for tonight until a valid upcoming ID is supplied or becomes verifiable from the organizer.

Tournament mode registers promptly when a valid upcoming ID is configured, continues any existing practice match, and never joins another practice lobby. This deliberately improves the earlier planned sequence: the actual server accepts busy entrants and waits for their practice matches before starting round one. A proposed client-side delay was rejected during review because registration could close before the practice match ends. A live upcoming-event registration has not yet been possible.

Do not use old ID 1 as a registration default. The source archive and Git commits exclude local credentials and dependencies. The public release repository is `Tow57/scrabblebot-auctioneer`; account credentials and CLI authentication are outside that repository.

## Attention

An independent **same-family** agent performed a read-only review against the pinned baseline and found no actionable P1/P2 defects in the client, worker, solver, capital allowance, monotonic clock, and launch/account/package scripts. Coverage included actual SDK replay behavior and server reducer contracts. This was not cross-family review. A full transcript audit was not performed.

A later same-family review reproduced the obsolete-bid issue described above and caught a cancellation-priority race in the first draft of its fix. The final diff resolved that finding; the reviewer independently passed six focused controller regressions and checked the SDK's transaction-update/reducer-ack contract. The full bot suite passed 46 tests.

Live network observations and offline timings do not prove every future request will meet a deadline or predict tournament wins. The upcoming event ID, cutoff, live registration confirmation, and organizer's repository-submission channel remain unverified. The locked upstream server test dependencies are retained; no development HTTP server is started by these checks.
