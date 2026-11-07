[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$installed = Get-Command spacetime -ErrorAction SilentlyContinue
$portable = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../work/spacetime-cli/spacetimedb-cli.exe'))
if ($installed) {
    & $installed.Source login
} elseif (Test-Path -LiteralPath $portable) {
    $configuration = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../work/spacetime-config'))
    & $portable --root-dir $configuration login
} else {
    throw 'Install the CLI from https://spacetimedb.com/install, then run this script again.'
}
if ($LASTEXITCODE -ne 0) { throw 'Spacetime sign-in did not complete.' }
Write-Host 'Open https://scrabblebot.spacetimedb.com/account and run its linking command.'
Write-Host 'For the portable CLI, keep using its full path and the same --root-dir shown above.'
Write-Host 'Then create your team at /team/new and generate the bot token at /team.'
