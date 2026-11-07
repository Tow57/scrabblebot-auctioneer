[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$statePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../work/bot-process.json'))
if (-not (Test-Path -LiteralPath $statePath)) { throw 'No background bot record. For a foreground bot, use Ctrl+C in its terminal.' }
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-Bot.ps1'))
if ($state.scriptPath -ne $scriptPath) { throw 'Background record belongs to another checkout.' }
if ($state.stopRequestPath) {
    $request = [IO.Path]::GetFullPath([string]$state.stopRequestPath)
    if ([IO.Path]::GetDirectoryName($request) -ne [IO.Path]::GetDirectoryName($statePath) -or [IO.Path]::GetFileName($request) -notmatch '^stop-auctioneer-[a-f0-9]{32}\.request$') {
        throw 'Invalid background control path.'
    }
    Set-Content -LiteralPath $request -Value 'stop'
    Write-Output 'Requested background bot shutdown; the hosting process will stop its own child tree.'
    return
}
$process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
if (-not $process) { Write-Output 'Background bot is already stopped.'; return }
if ($process.ProcessName -notin @('pwsh', 'powershell') -or $process.StartTime.ToUniversalTime().ToString('o') -ne $state.startTimeUtc) {
    throw 'Process identity changed since launch; refusing to stop a different process.'
}
# PID, start time, and checkout must match the launcher record. Stop its node
# child and worker too, rather than leaving an orphan connected to the game.
& taskkill.exe /PID $process.Id /T /F
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the recorded bot process tree.' }
Write-Output 'Background bot stopped.'
