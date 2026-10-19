<#
  PicJot Receiver - double-click launcher (started by "PicJot Receiver.cmd").

  Builds "PicJot Receiver.exe" beside this script the first time (and after
  an update) from tray\PicJotReceiver.cs, with the C# compiler that comes
  with Windows, then starts it: the receiver runs in the background with an
  icon by the clock (docs/wifi-backup.md, stage 2). If it's already running
  from here, its status page opens instead. If the program can't be built,
  the receiver runs in this window as before.

  Automation/testing:  receiver-tray.ps1 -BuildOnly
#>
param([switch]$BuildOnly)

$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'PicJot Receiver' } catch {}

$here = $PSScriptRoot
$cs = Join-Path $here 'tray\PicJotReceiver.cs'
$ico = Join-Path $here 'tray\picjot.ico'
$exe = Join-Path $here 'PicJot Receiver.exe'

function Fail([string]$text) {
  Write-Host $text -ForegroundColor Red
  Write-Host ''
  Write-Host 'Press any key to close...'
  [void][Console]::ReadKey($true)
  exit 1
}

# The receiver in this window (the stage 1 way), when the tray can't be used.
function Run-InWindow {
  Write-Host 'Running the receiver in this window instead. Keep it open while the phone backs up.' -ForegroundColor Yellow
  & node (Join-Path $here 'receiver.js')
  exit $LASTEXITCODE
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org and try again.'
}

function Is-Stale {
  if (-not (Test-Path -LiteralPath $exe)) { return $true }
  $built = (Get-Item -LiteralPath $exe).LastWriteTimeUtc
  return ((Get-Item -LiteralPath $cs).LastWriteTimeUtc -gt $built) -or ((Get-Item -LiteralPath $ico).LastWriteTimeUtc -gt $built)
}

# Builds into a new file, then swaps it in: a program that has just quit can
# keep its file locked for a moment. Returns $null, or what went wrong.
function Build {
  $csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  if (-not (Test-Path -LiteralPath $csc)) { return "Windows' C# compiler wasn't found ($csc)." }
  $new = Join-Path $here 'PicJot Receiver.new.exe'
  Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
  $out = & $csc /nologo /target:winexe /optimize+ "/out:$new" "/win32icon:$ico" "/resource:$ico,PicJot.ico" `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $cs 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $new)) { return ($out | Out-String).Trim() }
  for ($i = 0; $i -lt 20; $i++) {
    try {
      Move-Item -LiteralPath $new -Destination $exe -Force -ErrorAction Stop
      return $null
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
  return "The old $exe is still in use."
}

$stale = Is-Stale
$running = @(Get-Process -Name 'PicJot Receiver' -ErrorAction SilentlyContinue)
$runningHere = @($running | Where-Object { $_.Path -eq $exe })

if ($BuildOnly) {
  if ($running.Count) { Fail 'PicJot Receiver is running: quit it first (right-click its icon), or run this without -BuildOnly to restart it.' }
  $problem = Build
  if ($problem) { Fail $problem }
  Write-Output "Built $exe"
  exit 0
}

# Running from here and up to date: starting it again opens its page.
if ($running.Count -and $runningHere.Count -eq $running.Count -and -not $stale) {
  Start-Process -FilePath $exe
  exit 0
}

# An older copy, or one from another folder: ask it to quit first (it
# finishes filing a backup before it goes).
if ($running.Count) {
  Write-Host 'Stopping the PicJot Receiver that is running now...'
  try { [Threading.EventWaitHandle]::OpenExisting('Local\PicJotReceiverQuit').Set() | Out-Null } catch {}
  $running | Wait-Process -Timeout 900 -ErrorAction SilentlyContinue
}

if ($stale) {
  Write-Host 'Setting up PicJot Receiver...'
  $problem = Build
  if ($problem) {
    Write-Host 'PicJot Receiver could not be set up:' -ForegroundColor Yellow
    Write-Host "  $problem"
    # An older build still works; without one, the receiver runs in this window.
    if (-not (Test-Path -LiteralPath $exe)) { Run-InWindow }
    Write-Host 'Starting the version set up earlier instead.' -ForegroundColor Yellow
  }
}

# Its first start on this PC also turns on Start with Windows (its menu
# turns it off).
Start-Process -FilePath $exe
Write-Host ''
Write-Host 'PicJot Receiver is running in the background: its icon is by the clock' -ForegroundColor Green
Write-Host '(click ^ if you do not see it). Right-click the icon for options.'
Start-Sleep -Seconds 4
