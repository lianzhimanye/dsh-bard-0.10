# link-plugin.ps1 - bind the dsh-bard workspace folder into a DSH profile in place.
#
# What it does: replaces <profile>\node_modules\dsh-bard with a directory junction
# pointing at this folder. After that, editing client.js / lib/*.js edits the live
# plugin - no tar pack + extract step. Restart DSH (D:\DSH\Restart-DSH.bat or quit
# and reopen) to load the new code.
#
# Usage (no admin rights needed):
#   powershell -ExecutionPolicy Bypass -File link-plugin.ps1
#   powershell -ExecutionPolicy Bypass -File link-plugin.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File link-plugin.ps1 -Unlink
#
# Caveat: if dsh-bard is later reinstalled/upgraded through the DSH plugin manager,
# pnpm replaces the junction with a real directory. Re-run this script to re-bind.

[CmdletBinding()]
param(
  [string]$Workspace = '',
  [string]$Profile = 'desktop',
  [switch]$Unlink,
  [string]$DshRoot = 'C:\Users\DENGJIAYANG\.dsh'
)

$ErrorActionPreference = 'Stop'

if (-not $Workspace) {
  $self = $PSCommandPath
  if (-not $self) { $self = $MyInvocation.MyCommand.Path }
  if (-not $self) { $self = $MyInvocation.MyCommand.Definition }
  if (-not $self) { throw 'cannot determine script path; pass -Workspace explicitly' }
  $Workspace = Split-Path -Parent $self
}

$Workspace = (Resolve-Path $Workspace).Path
$profileDir = Join-Path $DshRoot (Join-Path 'profiles' $Profile)
if (-not (Test-Path $profileDir)) { throw "profile not found: $profileDir" }
$linkPath = Join-Path $profileDir 'node_modules\dsh-bard'
$expectedLink = [System.IO.Path]::GetFullPath($linkPath)
$expectedTarget = [System.IO.Path]::GetFullPath($Workspace)

if ($Unlink) {
  if (-not (Test-Path $linkPath)) { throw "target not found: $linkPath" }
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -ne 'Junction') { throw "$linkPath is not a junction (LinkType=[$($item.LinkType)]); refusing to delete" }
  [System.IO.Directory]::Delete($linkPath)
  Write-Output "unlinked: $linkPath"
  exit 0
}

if (-not (Test-Path (Join-Path $Workspace 'package.json'))) { throw "not a plugin folder (no package.json): $Workspace" }
$manifest = Get-Content (Join-Path $Workspace 'package.json') -Raw
if ($manifest -notmatch '"name"\s*:\s*"dsh-bard"') { throw "package.json is not dsh-bard: $Workspace" }

if (Test-Path $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction') {
    $old = [System.IO.Path]::GetFullPath((@($item.Target) -join ''))
    if ($old -eq $expectedTarget) {
      Write-Output "already linked: $linkPath -> $expectedTarget"
      exit 0
    }
    [System.IO.Directory]::Delete($linkPath)
  } else {
    $backup = "$linkPath.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
    Move-Item -LiteralPath $linkPath -Destination $backup
    Write-Output "old directory backed up: $backup (delete it once verified)"
  }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $linkPath) -Force | Out-Null
$out = cmd.exe /c "mklink /J ""$expectedLink"" ""$expectedTarget"" 2>&1"
if ($LASTEXITCODE -ne 0) { throw "mklink failed (exit $LASTEXITCODE): $out" }

$after = Get-Item -LiteralPath $linkPath -Force
if ($after.LinkType -ne 'Junction') { throw "created but not a junction: LinkType=[$($after.LinkType)]" }
Write-Output ("linked: {0} -> {1}" -f $after.FullName, ([System.IO.Path]::GetFullPath((@($after.Target) -join ''))))
Write-Output 'restart DSH to take effect (D:\DSH\Restart-DSH.bat, or quit and reopen).'