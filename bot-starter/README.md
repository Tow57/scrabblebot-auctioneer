# Auctioneer tournament bot

An external TypeScript client for the organizer's ScrabbleBot auction game. It uses the exact ENABLE dictionary, a bounded rack optimizer, budget-aware bidding, early endgame cashout, and a reconnecting client. It runs on your laptop and connects to the organizer's existing server.

Based on upstream commit `b5ccb36aa238ad16692f8d6af54da15ef9f11324`, with SDK 2.12.0 and the upstream lockfiles. The game module and its rules are unchanged.

## Windows quick start

Use Node.js 24 and PowerShell. From this directory:

```powershell
./Start-Bot.ps1 -Check
$env:BOT_COPIED_POLICY = 'lala'
./Start-Bot.ps1 -BotName auctioneer
```

The launch script prompts for your team bot token with hidden input, then the client saves it to the ignored `.token-auctioneer` file. Never paste credentials into chat, commit them, or include them in a source archive. `BotName` is a local token-file alias; it does not choose or rename the remote bot. Confirm the remote bot ID printed after connection. `BOT_COPIED_POLICY=lala` selects the copied Lala strategy described in [COPIED-LALA.md](COPIED-LALA.md); leaving it unset selects v1.6.

Keep the terminal open, the laptop plugged in, and the network connected. The launch script prevents system sleep while running and restores normal behavior when it exits. `-AllowSleep` opts out. Use only one process for this bot. Ctrl+C stops it.

For the hidden process started by Codex in this workspace, run `./Stop-BackgroundBot.ps1` to stop it before starting another process or switching to tournament mode. A normal foreground launch uses Ctrl+C.

`npm start` also works directly when `BOT_TOKEN` or the saved token exists. It does not prevent laptop sleep. The `prestart`, `pretest`, and `prebuild` scripts copy the organizer's checked-in bindings automatically; CLI generation is unnecessary for an unchanged schema.

The launch script installs the locked dependencies when missing and verifies esbuild using the resolved Node executable. This avoids a nested npm install-hook PATH issue seen in managed Windows terminals. Standard `npm ci` also works when Node is available to npm's child shell.

## Account and entry

1. Install the official Windows CLI from https://spacetimedb.com/install, or use the portable CLI included under this chat's `work/spacetime-cli` folder. Run `spacetime login` (the supplied `Setup-Account.ps1` finds either installation).
2. Visit https://scrabblebot.spacetimedb.com/account. Run the browser-specific linking command displayed there and refresh. With the portable CLI, replace `spacetime` by its executable path and retain the same `--root-dir` used for login.
3. Create a team and bot at https://scrabblebot.spacetimedb.com/team/new. Generate the bot token at https://scrabblebot.spacetimedb.com/team; it is displayed once.
4. Complete practice first. Confirm the organizer's event date, timezone, registration cutoff, tournament ID, and source-code submission destination.
5. Stop the practice process, then launch tournament mode:

```powershell
./Start-Bot.ps1 -BotName auctioneer -TournamentId 123
```

Replace `123` with the confirmed upcoming ID. The November 7 event uses **ID 2**; Tow57-Auctioneer (164) is registered as entry 113. Tournament mode registers using the bot credential, verifies entry, continues any existing practice match, and stays out of new practice lobbies. The server waits for registered entrants' practice matches before starting round one. Keep it running through the finals; registration does not run the bot for you. The owner set 10:40 PM Central as tonight's hard readiness deadline; contestants must attend ECSW 1.315 in person for the 10:45 PM start.

If registration is not yet open, wait for the organizer to open it and restart with the correct ID. Check registration at https://scrabblebot.spacetimedb.com/tournament. An offline registered bot still gets seated and misses its auctions.

## Strategy and timing

The following describes the original v1.6 policy. The copied Lala mode uses its unchanged fitted leave values, completion model and auction parameters in all formats and table sizes; it retains our SDK connection, rack validation, serialized submissions and worker watchdog. Its strength comparison covers six-player Vickrey tables only. Two-player and first-price native cases establish legality and timing, not comparative strength. See [COPIED-LALA.md](COPIED-LALA.md).

- Canonical anagram signatures and a trie enumerate legal words with repeated letters.
- A greedy legal partition seeds memoized search for the best combined word reward, including unused tiles. Search uses a cooperative 95 ms deadline and a 10,000-state limit. Preprocessing also checks the deadline; interruption returns a completed legal single word or partial partition with `exact=false`. The 5 ms reserve sits below the measured 100 ms validation limit; scheduling and garbage collection can still cause overshoot.
- Letter bids combine immediate rack cashout gain with value from words up to two letters short. Payment history sets budget pacing; first-price bids are shaded.
- Seven-letter words cash immediately. Shorter words cash under liquidity/rack pressure and during the last four auction windows.
- `bagTotal` excludes the currently offered tile. With zero remaining, the current auction is final and its tile cannot be used by an external client: bid zero and finish existing words before closure. With one remaining, the current auction is the last usable purchase.
- A worker keeps search off the connection thread. Late or stale results are rejected. Word submissions are serialized against confirmed rack updates. The client retracts old bids before cashout and reprices after the word acknowledgment and rack update, so it does not buy against letters already spent.
- The worker enables `StrategyOptions.wordFirst`: once a word is selected, it returns that word with bid zero and skips the obsolete augmented-rack and completion searches. A fresh decision bids after the confirmed rack update. The library option defaults off, preserving `decideBid` and raw library outputs. Skipping those searches also changes cache population, so later approximate trajectories may differ.
- Auction deadlines use a monotonic clock calibrated from fresh live auction events, so laptop/server wall-clock differences cannot suppress bids. A cold process may wait for the next auction to calibrate; reconnects retain the existing calibration.
- A memory-only ledger preserves possible bids across reconnects. Cold recovery may send one zero cancellation before clock calibration; the server can reject it if the auction closes in transit. Purchases still require calibration and the 150 ms margin. Normal cashout waits for recovery acknowledgment or auction advance; final-tile cashout has priority.
- The tournament worker enables the tested capital allowance so useful letters receive some buying power from the initial bank. `BOT_CAPITAL_ALLOWANCE=0` selects the previous bidding policy for comparisons.
- Vickrey matches favor useful high-value letters with separately validated face weights: **0.3 for two players** and **0.1 for three or more players**. The adjustment applies only to a positive base bid with more than one tile remaining; it stays capped at balance. FirstPrice and terminal guards retain the existing policy. `BOT_HEADS_UP_FACE_WEIGHT=0` or `BOT_MULTIWAY_FACE_WEIGHT=0` disables the corresponding adjustment; configured values must be finite from 0 to 0.5. `BOT_CAPITAL_ALLOWANCE=0` disables capital allowance and both face adjustments. Library weights still default to zero; the worker enables the confirmed settings.

The current server discards unsold tiles and randomizes tied bids. Opponents' starting racks are private, and live top bids are unavailable to bots. Some older guide text describes these differently.

## Validation

Multiway source `58786de` builds and passes **75 bot tests**. Its native stress check returned 12/12 legal responses without timeouts or worker errors. A fresh 36-pair modeled-tournament comparison passed its locked checks, with 20 crowns versus 11 for the control. These results do not guarantee wins against the live field. Earlier archive/path checks and the exact scope of each result are in `VALIDATION.md`.

```powershell
npm run build
npm test
npm ci --prefix ../spacetimedb --ignore-scripts
node ../spacetimedb/node_modules/esbuild/install.js
npm test --prefix ../spacetimedb
$env:BOT_BENCHMARK = '1'
$env:BOT_BENCHMARK_SEEDS = '30'
$env:BOT_BENCHMARK_REPORT = (Join-Path (Get-Location) 'benchmark-local-results.json')
npm run benchmark
Remove-Item Env:BOT_BENCHMARK, Env:BOT_BENCHMARK_SEEDS, Env:BOT_BENCHMARK_REPORT
```

This command reruns the historical core comparison using the actual in-memory server reducers and six external-bot credentials. It compares fixed paired seeds and rotating candidate seats against the original starter policies under the same reliable driver. The separate full-format experiment uses the current production word-first profile. Paired seeds are reproducible, but do not guarantee identical tile streams when bid patterns change RNG consumption. Offline results do not establish network reliability.

See `VALIDATION.md` for executed results and their limits. Optional lookahead failed its 5% score/placement/deadline gate and is absent from production. The old multiway raw-score holdout remains failed. The separate 36-pair actual-format confirmation completed with all locked checks passing: 20 candidate crowns versus 11 control crowns, with no candidate decisions over 100 ms. Its multiway bidding refinement is included in `strategy-v1.6`, which passed 75 tests, 12 native stress cases and five consecutive full live practice matches. These results describe the tested scenarios and do not guarantee wins against the tournament field.

## Source release

Keep `LICENSE` and upstream attribution. Include the full repository source, dictionary, generated web bindings, both lockfiles, launch scripts, and validation results. Exclude `node_modules`, `.git`, `dist`, tokens, environment files, and this chat's `work` directory. The provided `Package-Source.ps1` produces a credential-free archive.

Push to your own public GitHub repository and give its URL to the organizer using their confirmed submission channel. The website has no repository-link field. Preparing this checkout does not publish it to GitHub.
