<#
  PhotoApp PC backup - double-click launcher (started by "Backup photos.cmd").

  First run: pick the backup folder (remembered in %APPDATA%\PhotoApp\backup.json)
  and optionally create a desktop shortcut. Later runs: confirm or change the
  folder, then run pc/backup.js and keep the window open with the result.

  Automation/testing:  launcher.ps1 -Destination <folder> -Yes
    -Destination  use (and remember) this folder without the picker
    -Yes          no prompts: start immediately, no shortcut offer, no final pause
#>
param(
  [string]$Destination,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'PhotoApp backup' } catch {}

$configDir = Join-Path $env:APPDATA 'PhotoApp'
$configFile = Join-Path $configDir 'backup.json'
$backupJs = Join-Path $PSScriptRoot 'backup.js'
$cmdFile = Join-Path $PSScriptRoot 'Backup photos.cmd'

function Pause-Exit([int]$code) {
  if (-not $Yes) {
    Write-Host ''
    Write-Host 'Press any key to close...'
    [void][Console]::ReadKey($true)
  }
  exit $code
}

function Read-Config {
  if (Test-Path -LiteralPath $configFile) {
    try { return (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json) } catch {}
  }
  return $null
}

function Save-Config([string]$dest) {
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $json = @{ destination = $dest } | ConvertTo-Json
  [IO.File]::WriteAllText($configFile, $json, (New-Object Text.UTF8Encoding($false)))
}

function Pick-Folder([string]$start) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Choose where PhotoApp should back up your photos (a folder on this PC or an attached drive)'
  $dlg.ShowNewFolderButton = $true
  if ($start -and (Test-Path -LiteralPath $start)) { $dlg.SelectedPath = $start }
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
  return $null
}

function Offer-Shortcut {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desktop 'Backup photos.lnk'
  if (Test-Path -LiteralPath $lnk) { return }
  $answer = Read-Host 'Put a "Backup photos" shortcut on your desktop? (Y/n)'
  if ($answer -match '^(n|no)$') { return }
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $cmdFile
  $s.WorkingDirectory = $PSScriptRoot
  $s.IconLocation = "$env:SystemRoot\System32\imageres.dll,108"
  $s.Description = 'Back up phone photos with PhotoApp'
  $s.Save()
  Write-Host "Shortcut created: $lnk"
}

Write-Host ''
Write-Host '  PhotoApp backup' -ForegroundColor Yellow
Write-Host '  ---------------'
Write-Host ''

# Node is required to run the organiser.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install it from https://nodejs.org and try again.' -ForegroundColor Red
  Pause-Exit 1
}

# Destination: argument > remembered > folder picker.
$config = Read-Config
$firstRun = -not $config
$dest = if ($Destination) { $Destination } elseif ($config) { $config.destination } else { $null }

if (-not $dest) {
  Write-Host 'Choose the folder or drive to back up to...'
  $dest = Pick-Folder $null
  if (-not $dest) { Write-Host 'No folder chosen. Nothing was backed up.'; Pause-Exit 1 }
}

# A remembered destination on an unplugged drive: offer to choose another.
# (GetPathRoot handles both "E:\..." and network "\\server\share\..." paths.)
while (-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($dest)))) {
  Write-Host "The backup drive for $dest is not connected." -ForegroundColor Yellow
  if ($Yes) { Pause-Exit 1 }
  $answer = Read-Host 'Connect it and press Enter to retry, or type C to choose a different folder'
  if ($answer -match '^c') {
    $picked = Pick-Folder $null
    if ($picked) { $dest = $picked }
  }
}

if (-not $Yes -and -not $firstRun -and -not $Destination) {
  Write-Host "Backing up to: $dest"
  $answer = Read-Host 'Press Enter to start, or type C to choose a different folder'
  if ($answer -match '^c') {
    $picked = Pick-Folder $dest
    if ($picked) { $dest = $picked }
  }
}

Save-Config $dest
if ($firstRun -and -not $Yes) { Offer-Shortcut }

Write-Host ''
Write-Host "Backing up to: $dest"
Write-Host 'Make sure the phone is plugged in, UNLOCKED, and set to "File transfer".'
Write-Host ''

& node $backupJs --to $dest
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  Write-Host 'Backup finished.' -ForegroundColor Green
} else {
  Write-Host 'Backup finished with problems (see above).' -ForegroundColor Red
  Write-Host 'If the phone was not found: unlock it, choose "File transfer" in the USB notification, and run this again.'
}
Pause-Exit $code
