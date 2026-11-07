[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]{1,40}$')][string]$BotName = 'auctioneer',
    [ValidatePattern('^[1-9][0-9]*$')][string]$TournamentId,
    [switch]$Check,
    [switch]$AllowSleep
)

$ErrorActionPreference = 'Stop'
$oldBotName = $env:BOT_NAME
$oldTournament = $env:TOURNAMENT_ID
$oldToken = $env:BOT_TOKEN
$oldPath = $env:PATH
Push-Location -LiteralPath $PSScriptRoot
try {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Install Node.js 24 before launching.' }
    # Some Windows installations expose node through App Paths but omit it
    # from PATH, which npm's cmd.exe children need. Change this process only.
    $env:PATH = (Split-Path $nodeCommand.Source -Parent) + ';' + $oldPath
    $dependencies = @('node_modules/spacetimedb/package.json', 'node_modules/tsx/dist/cli.mjs', 'node_modules/typescript/bin/tsc', 'node_modules/esbuild/install.js')
    if (@($dependencies | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -gt 0) {
        & npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    # esbuild is the locked dependency tree's only required install hook.
    # Resolve node explicitly rather than relying on nested cmd.exe PATH lookup.
    & $nodeCommand.Source 'node_modules/esbuild/install.js'
    if ($LASTEXITCODE -ne 0) { throw 'esbuild installation check failed.' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    if ($Check) {
        & npm test
        if ($LASTEXITCODE -ne 0) { throw 'Bot tests failed.' }
        return
    }

    $env:BOT_NAME = $BotName
    $env:TOURNAMENT_ID = $TournamentId
    if (-not $env:BOT_TOKEN -and -not (Test-Path -LiteralPath ".token-$BotName")) {
        Write-Host 'Generate a bot token on https://scrabblebot.spacetimedb.com/team'
        $secret = Read-Host 'Paste bot token (hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try { $env:BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secret.Dispose() }
        if ([string]::IsNullOrWhiteSpace($env:BOT_TOKEN)) { throw 'A bot token is required.' }
    }

    if (-not $AllowSleep) {
        if (-not ('ScrabbleBot.Power' -as [type])) {
            Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace ScrabbleBot {
    public static class Power {
        [DllImport("kernel32.dll")]
        public static extern uint SetThreadExecutionState(uint flags);
    }
}
'@
        }
        if ([ScrabbleBot.Power]::SetThreadExecutionState(2147483649) -eq 0) {
            throw 'Could not keep the laptop awake. Adjust sleep settings or launch with -AllowSleep.'
        }
    }
    Write-Host 'Keep this terminal open. Ctrl+C stops the bot.'
    & npm start
    if ($LASTEXITCODE -ne 0) { throw "Bot exited with code $LASTEXITCODE. See the message above." }
}
finally {
    if (-not $AllowSleep -and ('ScrabbleBot.Power' -as [type])) {
        [void][ScrabbleBot.Power]::SetThreadExecutionState(2147483648)
    }
    $env:BOT_NAME = $oldBotName
    $env:TOURNAMENT_ID = $oldTournament
    $env:BOT_TOKEN = $oldToken
    $env:PATH = $oldPath
    Pop-Location
}
