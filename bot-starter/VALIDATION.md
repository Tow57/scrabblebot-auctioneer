# Validation record — November 7, 2026

## Late copied-strategy release

The owner authorized a late comparison and deployment of a copied public strategy. The selected source is MIT-licensed [Lala v2.7.5](https://github.com/dhruv-1100/lala-scrabblebot/tree/a7433c7b191c30f146f4a4d593ab845d996e50da), with unchanged parameters and an optional early return after its first selected word. Enable it with `BOT_COPIED_POLICY=lala`; unset preserves the v1.6 strategy. Attribution and limits are in [COPIED-LALA.md](COPIED-LALA.md); results and the complete copied runtime closure are in [copied-lala-validation.json](copied-lala-validation.json).

This release builds, passes 78 tests, and passes 12 native cases under the unchanged 95 ms compute rejection / 150 ms response watchdog (maximum 92.8631 / 94.9487 ms). The original copy failed one dense40 native case; revision02 preserves the effective first action and avoids later hypothetical work. Failed and corrected evidence remain preserved locally. The new performance revision repeated the same ten fixed six-player Vickrey scenarios, scoring 80.5 versus v1.6's 74.7, with four wins versus two. This is a quick comparison, not unseen tournament or 2300-strength proof. Independent same-family review checked all 22 copied runtime files against the qualified source and staged Git bytes.

Two full live practice matches completed (47309, 47328), followed by a controlled stop/restart during 47346. The restarted client verified tournament2 entry113, resumed accepted bids and words, completed 47346, and stayed out of new practice lobbies. All three observed intervals had zero worker errors, timeouts, fallbacks, stale results and rejected actions. Deadline skips were 1, 2 and 1; cold calibration skips were 1, 0 and 4. These are recorded, not counted as a pass of the earlier five-consecutive-zero-skip gate. This is the subsequently authorized late quick-screen release, not qualification of the earlier pressure-only candidate, whose 18-pair run timed out incomplete and was never deployed. Heads-up and first-price comparative strength remain unmeasured.

## Verified foundation

- Official server source and generated bindings pinned to `b5ccb36aa238ad16692f8d6af54da15ef9f11324`; SDK 2.12.0. No game module changes or publication.
- Exact supplied dictionary: 172,820 words, 156,473 unique anagram signatures; SHA-256 `b819e7b67f8f2c80640ae76f0edbe59a4a1befb6de0f348463642ad49bdd2ad3`.
- Multiway source `58786de5d77e04d3709dfcac18ec28e6734a3764` builds and passes **75 bot tests**, including multiway formula/default/opt-out/terminal guards and the seven timing-core checkpoint/cache/deadline regressions. Existing coverage includes exhaustive packing-oracle comparisons, worker deadlines, stale bigint IDs, bid cancellation, word serialization, reconnect exposure recovery, word-first work avoidance with preserved library defaults, wall-clock skew, replay calibration, and Windows file URLs with spaces and encoded characters. Earlier word-first source `f1c68e2c0b8d94e62def3d433a7207bf6c4008c3` installed, built and passed its 63 tests from a clean archive in a fresh Windows path containing spaces and `#`; that historical clean-install result does not describe the changed source.
- Anonymous deployed-schema inspection matched **all 27 generated reducers and all 30 readable table/view row shapes**, including `register_for_tournament(u64)` and the private-to-bot `my_rack` view. All 61 client binding files match the pinned tracked bindings. The server binary version is not exposed by this metadata. See `deployed-compatibility.json`.
- Full organizer module suite: **183 passed**, with the expensive benchmark separately opted in.
- Earlier capital-enabled core comparison: **30 paired Vickrey scenarios** against five frozen starter strategies. Mean score **361.8**, baseline **30.27**; mean place **1.00** versus **3.37**; the candidate finished first in all 30. In-process decision p95 **15.44 ms**, maximum **29.34 ms** in that run. This precedes the word-first computation change and does not measure its current match trajectories.
- Additional first-price and expensive-bidder fixtures passed. Offline scenarios use public state and each external bot's own authenticated rack, with no simulated-bot post-final-tile advantage. Paired seeds are reproducible but can yield different later tile streams when bid patterns change RNG consumption.

See `benchmark-results.json` for that earlier comparison and `benchmark-core-results.json` for the original core. The benchmark driver is the same for both policies, so these results measure strategy differences rather than the starter's original transport/cooldown bugs.

### Locked refinement comparison

Three fixed candidates were tested on 30 previously unseen paired seeds against each of two rosters: mixed market/starter policies and MIT-attributed public-formula archetypes over frozen v1. All entrants were external bots under the actual server reducers. The criteria and source hashes were locked before running. All 180 candidate/baseline pairs completed, and the corresponding module/fixture suite passed **208 tests** with two opt-in experiments skipped.

None qualified. Equal-weight mean score changes were **−0.57%** for face weight 0.1, **−20.63%** for face weight 0.3, and **−2.09%** for quality-gated face weighting. Their paired confidence intervals use 30 seed clusters, averaging each seed's two roster differences. Weight 0.1 improved public-roster placement but lost score on mixed tables; this does not meet the locked combined gate. No strategy was promoted. See `benchmark-holdout-results.json` and `benchmark-holdout-manifest.json`; experimental code remains under server test fixtures only.

### Separately validated two-player policy

The actual finals have two players and three games scored in aggregate. A separate six-seed pilot selected face weight 0.3 by the predeclared aggregate-margin rule. Confirmation then used **30 new seeds at offset 400**, actual tournament registration/start/auction/word/end/crown reducers, two external credentials, and three fresh games per series. Only the initial post-Swiss `Final` stage was fixtured. Both strategies used the same reliable driver, with no use of the last awarded tile after match end.

The candidate won **30/30 series** versus **16/30** for the paired frozen-v1 control. Mean three-game score was **1000.3 versus 790.2**, a **26.6%** increase. Paired aggregate-margin improvement was **503.77 points**, with a seed-paired 95% t interval **[392.12, 615.42]**. Both conditions had zero measured decision calls over 100 ms. All predeclared confirmation gates passed. See `benchmark-finals-confirmation.json`, `benchmark-finals-gate.json` and `benchmark-finals-manifest.json`.

Production applies the exact confirmed multiplier only to positive bids with **two participants, Vickrey auctions, and more than one tile remaining in the bag**. It preserves the original balance cap, word/search policy, terminal handling, larger tables and FirstPrice. The worker defaults to weight 0.3; the library defaults off. Both opt-outs are tested. The existing frozen policy and source snapshots remain available for comparison and rollback.

For the v1.3 profile before word-first work avoidance, independent same-family checks found no outstanding issues and passed full-dictionary production/frozen parity over 56 contexts. Real native-worker validation received **36/36 responses**, no timeouts/errors/restarts, p95 **65.29 ms**, maximum **66.06 ms** in the final run. All 28 conservatively comparable oracle cases matched; longer partial/deadline-adjacent cases were excluded from exactness claims. See `heads-up-native-validation.json`. These offline finals and native-worker results do not establish Swiss qualification or wins against every live rival. A live two-player tournament match has not yet been available.

A clean archive of production source `5560ebdf8aeb3cf23fb47a906e53cee6b9445ee9` installed, built and passed **61/61 bot tests** in a fresh Windows path containing spaces and `#`. After a controlled single-process restart, five consecutive full six-player practice matches (42885, 42888, 42891, 42894, 42897) completed with zero worker timeouts, fallbacks, stale results, rejected bids/words or deadline skips. Maximum decision round trip was **57.48 ms**. Mean score was 79.2 and mean place 3.4. This checks operation of the released process; the two-player adjustment is inactive in those six-player matches. See `live-headsup-validation.json`.

The promoted capital allowance was also tested against **five previous-version core bots** over 30 paired scenarios: mean score **164.83 versus 91.9**, mean place **1.20 versus 3.03**, and **25/30 first-place finishes**. First-price cases improved too. In the separate fixed expensive-bidder fixture its score declined from 160.75 to 124.25 while still finishing first in all four cases; the policy is not uniformly superior on every opponent model. See `benchmark-capital-results.json`.

### Additional two-player opponent checks

A report-only robustness check tested the earlier **v1.3 profile before word-first work avoidance** on 30 fresh seeds at offset 900 against each of two MIT-attributed acquisition archetypes. These combine published numerical bid floors with frozen-v1 word/search policies; they are not verified replicas of named live rivals. Each series used the actual three-game finals reducers and alternating seats, paired with a frozen-v1 control against the same archetype.

| Opponent archetype | v1.3 crowns | Frozen-v1 crowns | Paired aggregate-margin gain, 95% CI |
| --- | ---: | ---: | ---: |
| Premium floor | 29/30 | 7/30 | 692.90 [556.42, 829.38] |
| Linear face | 20/30 | 4/30 | 507.43 [388.67, 626.20] |

Intervals use 30 paired seeds per archetype. Averaging the two archetypes within each seed gives an equally weighted gain of 600.17 points, 95% CI [486.29, 714.05], with **n = 30**, not 180 independent games. There were **two candidate decision calls over 100 ms versus one control call**; maxima were **100.72 ms** and **100.04 ms**. These are synchronous in-process timings; the run does not measure IPC or the production 150 ms response watchdog. See `benchmark-heads-up-public-results.json`. This adds fixed-opponent robustness evidence, not universal tournament strength or a new promotion-gate pass.

### Word-first worker computation

Source `f1c68e2` enables `StrategyOptions.wordFirst` only in the production worker. Once the original current-rack search selects a word, it returns that word and plan with bid zero, skipping the augmented-rack and completion searches. The controller already cashes the word first and requests a fresh bid after the acknowledgment and authoritative rack update. The library option defaults off, preserving raw library and `decideBid` behavior. Tests cover the single optimizer call, skipped completion valuation, unchanged no-word bidding and a positive fresh bid after rack removal.

Word scoring, cashout rules, optimizer and deadlines are unchanged. Skipping an augmented search also skips its cache population, so later approximate partitions and match trajectories can differ. This is not a strict 100 ms timing fix: playable-entry sorting, greedy preparation and grouping still have unchecked stretches.

The clean archived source passed its locked install, build and **63/63 bot tests**. Its real native-worker stress check returned **12/12 legal responses**, with **zero timeouts or worker errors**, maximum round trip **106.27 ms** and maximum compute time **104.07 ms**. The sole compute sample over 100 ms was the **93-tile post-game rack boundary**, not an active-auction state; all active-composition cases stayed under 100 ms in that run. These samples do not guarantee every future decision will meet either time bound. See `word-first-native-validation.json`.

The word-first runtime completed **six consecutive full six-player practice matches** (43126, 43132, 43138, 43144, 43150, 43156): zero worker timeouts, fallbacks, stale results, rejected bids/words, deadline skips or calibration skips. Maximum decision round trip was **66.20 ms**, mean score **81.33**, mean shared place **2.83**, and shared-first rate **1/6**. The first partial post-restart interval was excluded. These varying live opponents provide operational evidence, not a controlled score comparison. See `live-word-first-validation.json`.

A separately preregistered **36-pair actual-format confirmation** completed with a clean runner exit. An additional face-0.1 premium at larger Vickrey tables won **20/36 crowns**, versus **9/36** for the current profile. Paired crown discordances were **14 improved, 3 regressed**, giving a one-sided exact p-value of **0.006362915**. Observed top-cut rates were **31/36 versus 19/36**, and mean Swiss rank improved from **6.139 to 3.444**. These results describe the fixed modeled field, not the unknown live tournament field.

**The candidate failed its locked promotion gate.** Twelve of its 25,289 synchronous decisions exceeded 100 ms, with a maximum of **100.7584 ms**; the gate required zero. The current profile had two overruns in 18,530 decisions. The candidate was not integrated or deployed, and its conditional native runner remains unrun. No threshold was relaxed. Reports, source pins, terminal receipt, gate and descriptive stage diagnosis are in `benchmark-full-format-confirmation-02*`. Any timing correction needs new validation and a fresh confirmation; these results cannot qualify changed code.

The earlier combined raw-score gate also remains failed. The earlier six-pair exploratory format pilot completed but exited 1 with a Vitest reporting timeout; its report, original source and failure receipt are preserved in `benchmark-full-format-pilot*`. The completed confirmation used cooperative simulation-step yields and retained all predeclared seeds and guards.

### Cooperative timing correction

Source `e564082` checks the deadline during playable-entry sorting, greedy construction and grouping. Trie traversal retains its strongest completed single word, and interrupted preprocessing returns a legal incumbent with `exact=false` without caching it as optimal. Exhausting the DP-state allowance still permits a time-bounded greedy fallback. The overall cooperative deadline is now **95 ms**, preserving the current-rack 40 ms and augmented-rack 85 ms stages and any tighter caller deadline. The physical measured validation guard remains **100 ms**, and the worker response watchdog remains **150 ms**.

Nine work-only logical proofs and all **70 production tests** passed. The fresh native stress run returned **12/12 legal responses**, zero timeouts/errors and zero observed compute samples over 100 ms, with maximum compute **45.72 ms** and round trip **47.34 ms**. These synthetic cases include both reachable active compositions and explicitly labeled post-game boundaries. Interrupted plans and cache trajectories can differ from the previous runtime, and checkpointing cannot prevent every OS or GC pause. See `timing-core-native-validation.json`.

After a controlled restart, this timing core completed **five consecutive full practice matches** (45287, 45294, 45301, 45309, 45316). There were zero worker timeouts, fallbacks, stale replies, rejected bids/words, deadline skips or calibration skips across 358 evaluations, 330 accepted bids and 18 accepted words. Maximum decision round trip was **60.79 ms**. Mean score was **65.8**, mean shared place **4.2**, and there were no first-place finishes. The first post-restart interval was excluded. This demonstrates operation against varying live opponents; it does not establish a strength improvement. See `live-timing-core-validation.json`.

### Confirmed larger-table bidding refinement

The new **36-pair confirmation at offset 1300** completed with a clean exit and all six locked checks passing. Both arms used the common 95 ms timing base, capital allowance, two-player face weight 0.3 and word-first computation. B added only the eligible multiway face weight 0.1. The actual tournament reducers handled four Swiss rounds, elimination and three-game finals against the same fixed 17 opponent archetypes. All 18 entrant insertion indices were used twice with balanced execution order; actual server-shuffled seat coverage is not claimed.

B won **20/36 crowns**, versus **11/36** for A. Paired discordances were **13 improved and 4 regressed**, giving a one-sided exact McNemar p-value of **0.024520874** against the predeclared 0.025 threshold. Observed top cuts were **30/36 versus 21/36** and mean Swiss rank was **3.833 versus 6.472**. B had **zero calls over 100 ms in 25,377 decisions**, maximum **95.1784 ms**; A also had zero in 19,419 calls. Other roster entrants had overruns. See `benchmark-full-format-confirmation-03*` for the original source pins, full results, terminal receipt, gate and descriptive diagnosis.

This establishes the locked comparison for this modeled roster and seed set. The top-cut/rank guards are descriptive, not population noninferiority. These synchronous timings exclude production IPC/network, and public-formula archetypes are not verified replicas of current rivals. Unknown-field wins and universal timing guarantees remain unproven. The older combined-score gate and offset-1000 confirmation remain failed; their thresholds and reports were retained.

Integrated source `58786de` implements that exact positive-bid multiplier only for **N>=3, Vickrey, bagTotal>1**, preserving normalized integer balance caps and the separate N=2 weight 0.3. The library defaults both weights to zero; the worker enables 0.1 and 0.3 respectively. `BOT_MULTIWAY_FACE_WEIGHT=0` opts out, and `BOT_CAPITAL_ALLOWANCE=0` disables both face weights. No optimizer/completion calls were added. The actual integrated build and all **75 tests** passed, including native default, override, opt-out and invalid-configuration checks. Its fresh native stress run returned **12/12 legal responses**, zero timeouts/errors, maximum compute **40.36 ms** and round trip **42.31 ms**. See `multiway-native-validation.json`.

After the controlled restart, the integrated refinement completed **five consecutive full practice matches** (45784, 45797, 45810, 45823, 45836), all with complete controller telemetry. Across **356 evaluations, 332 accepted bids and 16 accepted words**, there were zero worker timeouts, fallbacks, stale replies, rejected actions, deadline skips or calibration skips. Maximum round trip was **95.73 ms**. Mean score was **79.4**, mean shared place **3.0**, and none finished first. The initial post-restart interval was excluded. These varying live opponents provide operational evidence, not a causal strength comparison. See `live-multiway-validation.json` and `multiway-release-validation.json`.

The separate highest-reward-under-pressure word-priority correction is **not included**. Current core and cached fallback still prefer a seven-letter word first. The owner requested a pause after this refinement; the prepared correction and its planned 18-pair validation remain unapplied and unrun. This known clause of the original word-policy plan is not complete.

## Live verification

### Runtime refinement after v1.0

CPU profiling found that SDK 2.12 unique-index `find()` linearly scans cached rows. Repeated lookups through roughly 43,000 historical matches consumed about 12.8 seconds of a 45-second profile. The client now keeps a native match-ID map updated from row events and rebuilt after subscription replay. The next 45-second profile was 44.1 seconds idle, and the lookup stack disappeared from the major CPU consumers.

The first complete post-fix telemetry interval (match 42702) recorded 69/69 completed worker decisions, zero fallbacks, stale results, rejected bids or deadline skips; the only skipped bid was cold-start clock calibration. See `runtime-validation.json`. The isolated release snapshot built and passed **36 bot tests**, including 43,000-row lookup complexity and replay consistency. This changes cache access and observability, not the SDK schema, server rules, or production bidding policy.

The extended unchanged-policy soak completed **28 matches**, averaging **83.25 points** and **3.25th place**, with **2 shared-first finishes**. No worker timeouts, fallbacks, stale results, rejected bids/words, or deadline skips were recorded. Opponent composition varies, so this is operational evidence rather than a controlled strategy comparison. See `live-runtime-v1.1.json`.

### Cashout and bid ordering refinement

Review reproduced an obsolete-bid defect: the old controller could bid 35 for `S` using a `RAINBOW` rack, submit `RAINBOW`, and then suppress the zero-bid correction with 100 ms left. The client now cashes out first, retracts any prior positive bid, and waits for both acknowledgment and the authoritative rack change before repricing. Cancellation stays queued even if a later worker result wants a small positive bid; after cancellation acknowledgment, a fresh decision may bid again if time permits.

First zero retractions may use the final 150 ms while the auction remains open; positive bids and failure retries retain the 150 ms safety margin. No retraction is attempted after the local deadline. Emergency fallback skips the last usable purchase when it cannot prove an immediate gain; normal worker decisions retain the existing terminal all-in policy. Regression tests cover late acknowledgments, both rack/ack arrival orders, worker and word failures, and cancellation priority.

The cashout candidate completed five consecutive full own matches (42742, 42743, 42744, 42746, 42748) with zero timeouts, fallbacks, rejected actions or deadline skips. The extended 14-match report has no timeouts or rejected actions and one guarded late-bid skip; its mean score is 75.07 and mean place 4.07. This establishes operation, not strategy superiority. See `live-cashout-validation.json`.

### Reconnect exposure refinement

The server retains private bids after disconnect. The client now keeps a bounded memory-only exposure ledger across automatic reconnect and full controller replacement. Positive sends are recorded before transport; only a matching zero acknowledgment, a different committed auction ID, or an authoritative match end clears them. A missing cached auction row does not prove expiry. Unknown cold-start exposure is seeded once from the fully replayed own-running set.

Recovery makes one best-effort zero request even before clock calibration, then waits for acknowledgment or auction advance before normal cashout or bidding. The server may reject that request if the replay closes in transit. Further retries and every positive bid require a calibrated deadline and the usual margin. Final `bagTotal === 0` cashout proceeds immediately because currency has no terminal score. Synchronous bid and word transport exceptions use the normal recovery path. Actual server-reducer proofs and 56 bot tests cover these contracts; live recovery verification is recorded separately.

Release verification passed a clean archived-source install/build and **56 tests** in another Windows directory containing spaces and `#`. Live checks deliberately closed this bot's socket after an accepted positive bid, observed suspended actions/subscription replay and resumed bids/words, then restarted the process during match 42799 with 39 tiles remaining. The replacement acknowledged recovery zero before subsequent bids and words. A normal-process soak completed five full matches (42785, 42788, 42790, 42793, 42796): zero worker timeouts, fallbacks, rejected actions or deadline skips, maximum decision round trip 76.63 ms. See `live-reconnect-validation.json`. The normal process has no reconnect test preload.

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

The organizer's November 7 announcement confirms **10:45 PM America/Chicago**, **ECSW 1.315**, connection before the start, a public GitHub repository, and in-person attendance. The owner subsequently authorized registration for the newly opened **tournament 2** and set **10:40 PM** as the hard readiness deadline. **Tow57-Auctioneer (bot 164) is registered as entry 113**, verified from its authenticated client and the public tournament table. The public repository is https://github.com/Tow57/scrabblebot-auctioneer. No separate repository field or hand-in destination has been identified; registration and public source do not establish organizer receipt or physical attendance.

The owner clarified that ScrabbleBot is a separate side event from Breakwater and its Devpost submission. This repository is for the bot alone; no Devpost entry or tournament repository hand-in has been made for it.

Tournament mode registers promptly when a valid upcoming ID is configured, continues any existing practice match, and never joins another practice lobby. The actual server accepts busy entrants and waits for their practice matches before starting round one. The live tournament-2 launch verified entry 113 and completed its existing practice match 47073 before waiting for the tournament.

Do not use old ID 1 as a registration default. The source archive and Git commits exclude local credentials and dependencies. The public release repository is `Tow57/scrabblebot-auctioneer`; account credentials and CLI authentication are outside that repository.

## Attention

An independent **same-family** agent performed a read-only review against the pinned baseline and found no actionable P1/P2 defects in the client, worker, solver, capital allowance, monotonic clock, and launch/account/package scripts. Coverage included actual SDK replay behavior and server reducer contracts. This was not cross-family review. A full transcript audit was not performed.

A later same-family review reproduced the obsolete-bid issue described above and caught a cancellation-priority race in the first draft of its fix. The final diff resolved that finding; the reviewer independently passed six focused controller regressions and checked the SDK's transaction-update/reducer-ack contract. The full bot suite passed 46 tests.

The reconnect refinement received another independent same-family review. It caught and resolved missing-cache expiry handling and a pre-existing synchronous word-send failure. Ten focused recovery regressions passed independently; the full bot build and 56-test suite passed. This was not cross-family review.

The word-first worker change received a same-family review of the actual controller callers, opt-in default and legacy helper contract, with no outstanding P1/P2 findings. Its full bot suite passed 63 tests. This does not establish whole-match cache parity or a strict 100 ms wall-clock bound.

Live network observations and offline timings do not prove every future request will meet a deadline or predict tournament wins. Tournament 2 and registration are verified; a separate registration cutoff and repository-submission channel remain unconfirmed. The locked upstream server test dependencies are retained; no development HTTP server is started by these checks.

Fresh bot installation reports one low-severity [esbuild Windows development-server advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr). The supported bot commands use TypeScript transformation and start no esbuild HTTP development server. The requested locked dependency tree is retained.
