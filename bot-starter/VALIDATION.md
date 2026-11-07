# Validation record — November 7, 2026

## Verified foundation

- Official server source and generated bindings pinned to `b5ccb36aa238ad16692f8d6af54da15ef9f11324`; SDK 2.12.0. No game module changes or publication.
- Exact supplied dictionary: 172,820 words, 156,473 unique anagram signatures; SHA-256 `b819e7b67f8f2c80640ae76f0edbe59a4a1befb6de0f348463642ad49bdd2ad3`.
- TypeScript build and **33 bot tests passed**, including exhaustive packing-oracle comparisons, worker deadlines, stale bigint IDs, bid cancellation, word serialization, wall-clock skew, replay calibration, and Windows file URLs with spaces and encoded characters. A clean source archive also installed, built, and passed these tests in a fresh Windows directory containing spaces and `#`.
- Full organizer module suite: **183 passed**, with the expensive benchmark separately opted in.
- Actual server-reducer comparison: **30 paired Vickrey scenarios** against five frozen starter strategies. Release mean score **361.8**, baseline **30.27**; mean place **1.00** versus **3.37**; the release finished first in all 30. In-process decision p95 **15.44 ms**, maximum **29.34 ms** in that run.
- Additional first-price and expensive-bidder fixtures passed. Offline scenarios use public state and each external bot's own authenticated rack, with no simulated-bot post-final-tile advantage. Paired seeds are reproducible but can yield different later tile streams when bid patterns change RNG consumption.

See `benchmark-results.json` for the release comparison and `benchmark-core-results.json` for the original core. The benchmark driver is the same for both policies, so these results measure strategy differences rather than the starter's original transport/cooldown bugs.

The promoted capital allowance was also tested against **five previous-version core bots** over 30 paired scenarios: mean score **164.83 versus 91.9**, mean place **1.20 versus 3.03**, and **25/30 first-place finishes**. First-price cases improved too. In the separate fixed expensive-bidder fixture its score declined from 160.75 to 124.25 while still finishing first in all four cases; the policy is not uniformly superior on every opponent model. See `benchmark-capital-results.json`.

## Live verification

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

Do not use old ID 1 as a registration default. The source archive and Git commits exclude local credentials and dependencies. The public release repository is `Tow57/scrabblebot-auctioneer`; account credentials and CLI authentication are outside that repository.

## Attention

An independent **same-family** agent performed a read-only review against the pinned baseline and found no actionable P1/P2 defects in the client, worker, solver, capital allowance, monotonic clock, and launch/account/package scripts. Coverage included actual SDK replay behavior and server reducer contracts. This was not cross-family review. A full transcript audit was not performed.

Live network observations and offline timings do not prove every future request will meet a deadline or predict tournament wins. The upcoming event ID, cutoff, live registration confirmation, and organizer's repository-submission channel remain unverified. The locked upstream server test dependencies are retained; no development HTTP server is started by these checks.
