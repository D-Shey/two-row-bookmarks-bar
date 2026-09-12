# Packs the extension into dist\dbb-<version>.zip with only the files that
# should ship. Everything else in the repo — README, docs, agent config — stays
# out of the package.
#
#   pwsh -File build.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version  = $manifest.version

$include = @(
  'manifest.json',
  '_locales',
  'background',
  'content',
  'icons',
  'newtab',
  'options',
  'popup'
)

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist "stage-$version"
$zip = Join-Path $dist "dbb-$version.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip)   { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

foreach ($item in $include) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { throw "missing: $item" }
  Copy-Item $src (Join-Path $stage $item) -Recurse -Force
}

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$size = [Math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output "packed: $zip ($size KB)"

# Show what actually went in, so nothing unexpected ships.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$archive.Entries | Sort-Object FullName | ForEach-Object { "  $($_.FullName)" }
$archive.Dispose()
