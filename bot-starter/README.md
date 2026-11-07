# Auctioneer tournament bot

An external TypeScript client for the organizer's ScrabbleBot auction game. It uses the exact ENABLE dictionary, a bounded rack optimizer, budget-aware bidding, early endgame cashout, and a reconnecting client. It runs on your laptop and connects to the organizer's existing server.

Based on upstream commit `b5ccb36aa238ad16692f8d6af54da15ef9f11324`, with SDK 2.12.0 and the upstream lockfiles. The game module and its rules are unchanged.

## Windows quick start

Use Node.js 24 and PowerShell. From this directory:

```powershell
./Start-Bot.ps1 -Check
./Start-Bot.ps1 -BotName auctioneer
```

The launch script prompts for your team bot token with hidden input, then the client saves it to the ignored `.token-auctioneer` file. Never paste credentials into chat, commit them, or include them in a source archive. `BotName` is a local token-file alias; it does not choose or rename the remote bot. Confirm the remote bot ID printed after connection.

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

Replace `123` with the confirmed upcoming ID. Never assume an old or ended tournament is the correct event. Tournament mode registers promptly using the bot credential, verifies entry, continues any existing practice match, and stays out of new practice lobbies. The server waits for registered entrants' practice matches before starting round one; registering promptly avoids missing a cutoff while waiting locally. Keep it running through the finals; registration does not run the bot for you. Freeze code at least 90 minutes before the confirmed start.

If registration is not yet open, wait for the organizer to open it and restart with the correct ID. Check registration at https://scrabblebot.spacetimedb.com/tournament. An offline registered bot still gets seated and misses its auctions.

## Strategy and timing

- Canonical anagram signatures and a trie enumerate legal words with repeated letters.
- A greedy legal partition seeds bounded memoized search for the best combined word reward, including unused tiles. Search is capped at 100 ms and 10,000 states; interrupted results are approximate.
- Letter bids combine immediate rack cashout gain with value from words up to two letters short. Payment history sets budget pacing; first-price bids are shaded.
- Seven-letter words cash immediately. Shorter words cash under liquidity/rack pressure and during the last four auction windows.
- `bagTotal` excludes the currently offered tile. With zero remaining, the current auction is final and its tile cannot be used by an external client: bid zero and finish existing words before closure. With one remaining, the current auction is the last usable purchase.
- A worker keeps search off the connection thread. Late or stale results are rejected. Word submissions are serialized against confirmed rack updates. The client retracts old bids before cashout and reprices after the word acknowledgment and rack update, so it does not buy against letters already spent.
- Auction deadlines use a monotonic clock calibrated from fresh live auction events, so laptop/server wall-clock differences cannot suppress bids. A cold process may wait for the next auction to calibrate; reconnects retain the existing calibration.
- A memory-only ledger preserves possible bids across reconnects. Cold recovery may send one zero cancellation before clock calibration; the server can reject it if the auction closes in transit. Purchases still require calibration and the 150 ms margin. Normal cashout waits for recovery acknowledgment or auction advance; final-tile cashout has priority.
- The tournament worker enables the tested capital allowance so useful letters receive some buying power from the initial bank. `BOT_CAPITAL_ALLOWANCE=0` selects the previous bidding policy for comparisons.

The current server discards unsold tiles and randomizes tied bids. Opponents' starting racks are private, and live top bids are unavailable to bots. Some older guide text describes these differently.

## Validation

```powershell
npm run build
npm test
npm ci --prefix ../spacetimedb --ignore-scripts
node ../spacetimedb/node_modules/esbuild/install.js
npm test --prefix ../spacetimedb
$env:BOT_BENCHMARK = '1'
$env:BOT_BENCHMARK_SEEDS = '30'
$env:BOT_BENCHMARK_REPORT = (Join-Path (Get-Location) 'benchmark-results.json')
npm run benchmark
Remove-Item Env:BOT_BENCHMARK, Env:BOT_BENCHMARK_SEEDS, Env:BOT_BENCHMARK_REPORT
```

The benchmark uses the actual in-memory server reducers and six external-bot credentials. It compares fixed paired seeds and rotating candidate seats against the original starter policies under the same reliable driver. Paired seeds are reproducible, but do not guarantee identical tile streams when bid patterns change RNG consumption. Offline results do not establish network reliability.

See `VALIDATION.md` for executed results and remaining live checks. Optional lookahead is eligible only after a 5% mean-score improvement with no worse placement or deadline behavior; the tested core remains the default unless that gate passes.

## Source release

Keep `LICENSE` and upstream attribution. Include the full repository source, dictionary, generated web bindings, both lockfiles, launch scripts, and validation results. Exclude `node_modules`, `.git`, `dist`, tokens, environment files, and this chat's `work` directory. The provided `Package-Source.ps1` produces a credential-free archive.

Push to your own public GitHub repository and give its URL to the organizer using their confirmed submission channel. The website has no repository-link field. Preparing this checkout does not publish it to GitHub.
