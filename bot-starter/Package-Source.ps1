[CmdletBinding()]
param([string]$Destination)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (-not $Destination) { $Destination = Join-Path (Split-Path $repository -Parent) 'scrabblebot-source.zip' }
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'Archive already exists. Choose a new destination to preserve the previous release.' }
Push-Location -LiteralPath $repository
try {
    $files = @(& git ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate repository files.' }
    Add-Type -AssemblyName System.IO.Compression
    $archive = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in ($files | Sort-Object -Unique)) {
            if ($relative -match '(^|/)(node_modules|\.git|dist|target|work)(/|$)|(^|/)\.env[^/]*$|(^|/)\.token-[^/]*$|\.(log|zip|pem|key)$') { continue }
            $absolute = [IO.Path]::GetFullPath((Join-Path $repository $relative))
            if (-not $absolute.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'A source path escaped the repository.' }
            if (Test-Path -LiteralPath $absolute -PathType Leaf) {
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $absolute, ('scrabblebot/' + $relative.Replace('\', '/')))
            }
        }
    } finally { $archive.Dispose() }
} finally { Pop-Location }
Write-Output $Destination
