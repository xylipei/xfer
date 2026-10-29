<#
.SYNOPSIS
  xfer installer for Windows — per-user, no admin, no npm, no build step.
.DESCRIPTION
  Downloads a pinned xfer.mjs, verifies its SHA256, installs it under
  %LOCALAPPDATA%\xfer, writes a xfer.cmd shim and (optionally) adds the shim
  directory to the user PATH. Versions are kept side by side so -Rollback works
  without re-downloading.
.PARAMETER Version
  Release to install, e.g. 0.3.1 (without the leading v).
.PARAMETER Sha256
  Expected SHA256 of xfer.mjs. Strongly recommended: without it the bytes are
  installed unverified.
.EXAMPLE
  .\install.ps1 -Version 0.3.1 -Sha256 b2ab86e2...
.EXAMPLE
  .\install.ps1 -Check -Version 0.3.1    # exit 0 = up to date, 1 = needs update
.EXAMPLE
  .\install.ps1 -Rollback
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Sha256,
  [string]$Repo = 'xylipei/xfer',
  [string]$Base,
  [switch]$Check,
  [switch]$Rollback,
  [switch]$NoPath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root       = Join-Path $env:LOCALAPPDATA 'xfer'
$versions   = Join-Path $root 'versions'
$bin        = Join-Path $root 'bin'
$current    = Join-Path $root 'current.mjs'
$currentTxt = Join-Path $root 'current.txt'
$previousTxt= Join-Path $root 'previous.txt'
$shim       = Join-Path $bin 'xfer.cmd'

function Get-CurrentVersion {
  if (Test-Path $currentTxt) { return (Get-Content $currentTxt -Raw).Trim() }
  return ''
}

if ($Rollback) {
  if (-not (Test-Path $previousTxt)) { Write-Error 'nothing to roll back to' ; exit 1 }
  $prev = (Get-Content $previousTxt -Raw).Trim()
  $file = Join-Path $versions "xfer-$prev.mjs"
  if (-not (Test-Path $file)) { Write-Error "previous version file missing: $file"; exit 1 }
  $cur = Get-CurrentVersion
  Copy-Item $file $current -Force
  Set-Content -Path $currentTxt  -Value $prev -NoNewline
  Set-Content -Path $previousTxt -Value $cur  -NoNewline
  Write-Output "rolled back to $prev"
  exit 0
}

if ($Check) {
  if (-not $Version) { Write-Error '-Check needs -Version'; exit 2 }
  $cur = Get-CurrentVersion
  if ($cur -eq $Version -and (Test-Path $current)) { Write-Output "up-to-date: $Version"; exit 0 }
  if (-not $cur) { $cur = 'none' }
  Write-Output "needs-update: installed=$cur wanted=$Version"
  exit 1
}

if (-not $Version) { Write-Error '-Version is required (e.g. -Version 0.3.1)'; exit 2 }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error 'Node.js not found. Install Node 20+ from https://nodejs.org/en/download and re-run.'
  exit 1
}
$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  Write-Error "Node $nodeVersion is too old; xfer needs 20 or newer (https://nodejs.org/en/download)."
  exit 1
}

if (-not $Base) { $Base = "https://cdn.jsdelivr.net/gh/$Repo@v$Version" }
$url = "$Base/xfer.mjs"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("xfer-" + [guid]::NewGuid().ToString('N') + ".mjs")

Write-Output "fetching $url"
try {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
} catch {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Write-Error "download failed: $url`n$($_.Exception.Message)"
  Write-Output "hint: try -Base https://raw.githubusercontent.com/$Repo/v$Version"
  exit 1
}

if ($Sha256) {
  $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $Sha256.ToLower()) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Error "checksum mismatch: expected $Sha256 got $actual — nothing installed"
    exit 1
  }
  Write-Output 'checksum ok'
} else {
  Write-Warning 'no -Sha256 given; installing unverified bytes'
}

$dest = Join-Path $versions "xfer-$Version.mjs"
if ($DryRun) {
  Write-Output "dry-run: would install $dest"
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  exit 0
}

New-Item -ItemType Directory -Force -Path $versions, $bin | Out-Null
Copy-Item $tmp $dest -Force
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$prev = Get-CurrentVersion
if ($prev) { Set-Content -Path $previousTxt -Value $prev -NoNewline }
Copy-Item $dest $current -Force
Set-Content -Path $currentTxt -Value $Version -NoNewline

# The shim is the whole point on Windows: no shebang, no file association games.
$shimBody = "@echo off`r`nchcp 65001 >nul`r`nnode `"%~dp0..\current.mjs`" %*`r`n"
Set-Content -Path $shim -Value $shimBody -Encoding ASCII -NoNewline

if (-not $NoPath -and $env:OS -eq 'Windows_NT') {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($userPath) { $parts = @($userPath -split ';' | Where-Object { $_ }) }
  if ($parts -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (@($parts) + $bin) -join ';', 'User')
    Write-Output "added to user PATH: $bin"
    Write-Output 'open a new terminal for the change to take effect'
  }
} elseif (-not $NoPath) {
  Write-Output "PATH not modified (not Windows); shim at $shim"
}

Write-Output "installed $Version -> $shim"
& node $current -V
