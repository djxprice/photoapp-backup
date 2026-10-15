<#
  PhotoApp PC backup - phone access over USB (Windows MTP via Shell.Application).

  Node cannot talk to MTP devices; this helper does only the device I/O:
    - list photo files and PhotoApp tag files (sidecars) on the phone,
    - copy NEW or CHANGED ones into a local staging folder,
    - or (push mode) copy one file - a backup receipt or tags-synced marker -
      into a phone folder.
  -Only <phone folder> lists/pulls just that folder's tag files (Sync tags).
  It never deletes or modifies anything on the phone.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File mtp.ps1 `
      -Staging <dir> -Pulled <pulled.json> -Result <result.json> [-ListOnly]
    powershell ... -File mtp.ps1 -Staging <dir> -Pulled <pulled.json> -Result <result.json> `
      -PushFile <file> -PushFolder <phone folder, e.g. DCIM/PhotoApp>

  Pulled index: JSON object { "<phone relative path>": "<size>|<modified ISO>" }
  of files already backed up; matching entries are skipped.
#>
param(
  [Parameter(Mandatory = $true)][string]$Staging,
  [Parameter(Mandatory = $true)][string]$Pulled,
  [Parameter(Mandatory = $true)][string]$Result,
  [switch]$ListOnly,
  [string]$PushFile,
  [string]$PushFolder,
  [string]$Only
)

$ErrorActionPreference = 'Stop'

# Folders scanned. Photos are backed up from the first three. PhotoApp's tag
# files (<md5>.json) are recognised in ANY of them: the user picks that folder
# in the app, so its name and location vary (Documents is searched for tag
# files only).
$Roots = @(
  @{ Name = 'DCIM'; Images = $true },
  @{ Name = 'Pictures'; Images = $true },
  @{ Name = 'Download'; Images = $true },
  @{ Name = 'Documents'; Images = $false }
)
$ImageExts = @('.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng')
$SidecarName = '^[0-9a-fA-F]{32}\.json$'

function Write-Utf8Json($path, $value) {
  $json = $value | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-Phone {
  $shell = New-Object -ComObject Shell.Application
  $phone = $shell.Namespace(17).Items() | Where-Object { $_.Type -match 'Mobile|Portable' } | Select-Object -First 1
  if (-not $phone) { throw 'No phone found. Connect it by USB, unlock it, and choose "File transfer".' }
  $stores = @($phone.GetFolder.Items())
  if ($stores.Count -eq 0) { throw 'Phone storage is not visible. Unlock the phone and set USB mode to "File transfer".' }
  return @{ Shell = $shell; Name = $phone.Name; Root = $stores[0].GetFolder }
}

function Get-Child($folder, $name) {
  return $folder.Items() | Where-Object { $_.Name -eq $name } | Select-Object -First 1
}

function Get-FolderByPath($root, $relPath) {
  $f = $root
  foreach ($part in $relPath.Split('/')) {
    $item = Get-Child $f $part
    if (-not $item) { return $null }
    $f = $item.GetFolder
  }
  return $f
}

# Load the pulled index into a hashtable (PS 5.1 has no -AsHashtable).
$pulledMap = @{}
if (Test-Path -LiteralPath $Pulled) {
  $obj = Get-Content -LiteralPath $Pulled -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($obj) { foreach ($p in $obj.PSObject.Properties) { $pulledMap[$p.Name] = [string]$p.Value } }
}

$phone = Get-Phone
$files = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList

# Push mode: copy one local file (a backup receipt) into the given phone folder
# (the folder holding PhotoApp's tag files), then stop - no listing or pulling.
if ($PushFile) {
  $pushed = $false
  $target = if ($PushFolder) { Get-FolderByPath $phone.Root $PushFolder } else { $null }
  if ($target) {
    $target.CopyHere($PushFile, 4 + 16 + 1024)
    $name = [IO.Path]::GetFileName($PushFile)
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $pushed -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
      $pushed = [bool](Get-Child $target $name)
    }
  } else {
    [void]$errors.Add("phone folder '$PushFolder' not found; receipt not copied to the phone")
  }
  Write-Utf8Json $Result ([ordered]@{ phone = $phone.Name; files = @(); errors = $errors; pushed = $pushed })
  exit 0
}

# True once nothing else (the MTP copy) has the file open.
function Test-FileReleased($path) {
  try {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'None')
    $fs.Dispose()
    return $true
  } catch {
    return $false
  }
}

# Copy one phone item into $destDir. Returns 'ok', 'nosize' or 'timeout'.
# A leftover staged file is never trusted (it may be a partial copy from an
# interrupted run); the copy only counts once it has the phone's exact size
# AND Windows has released it.
function Copy-FromPhone($item, $destDir, $expectedSize) {
  if ($expectedSize -le 0) { return 'nosize' }
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $target = Join-Path $destDir $item.Name
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  # 4 = no progress UI, 16 = yes to all, 1024 = no error UI. MTP copies are
  # asynchronous, so poll until done.
  $phone.Shell.Namespace($destDir).CopyHere($item, 4 + 16 + 1024)
  $deadline = (Get-Date).AddSeconds(120 + [math]::Ceiling($expectedSize / 2MB))
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $target) -and
        ((Get-Item -LiteralPath $target).Length -eq $expectedSize) -and
        (Test-FileReleased $target)) {
      return 'ok'
    }
    Start-Sleep -Milliseconds 150
  }
  return 'timeout'
}

function Visit($folder, $rel, $images) {
  foreach ($item in @($folder.Items())) {
    $childRel = if ($rel) { "$rel/$($item.Name)" } else { $item.Name }
    if ($item.IsFolder) {
      if ($item.Name.StartsWith('.')) { continue } # .thumbnails, .trash etc.
      Visit $item.GetFolder $childRel $images
      continue
    }
    $ext = [IO.Path]::GetExtension($item.Name).ToLowerInvariant()
    $isSidecar = $item.Name -match $SidecarName
    $isImage = $images -and ($ImageExts -contains $ext)
    if (-not $isSidecar -and -not $isImage) { continue }

    $sizeRaw = $item.ExtendedProperty('System.Size')
    $size = if ($sizeRaw) { [int64]$sizeRaw } else { 0 }
    $modRaw = $item.ExtendedProperty('System.DateModified')
    $modified = if ($modRaw) { ([datetime]$modRaw).ToUniversalTime().ToString('o') } else { '' }
    $sig = "$size|$modified"
    $already = $pulledMap.ContainsKey($childRel) -and ($pulledMap[$childRel] -eq $sig)

    $staged = $false
    if (-not $already -and -not $ListOnly) {
      $destDir = Join-Path $Staging ($rel -replace '/', '\')
      try {
        $outcome = Copy-FromPhone $item $destDir $size
        $staged = $outcome -eq 'ok'
        if ($outcome -eq 'nosize') { [void]$errors.Add("the phone reported no size for $childRel; skipped (will retry next run)") }
        elseif ($outcome -eq 'timeout') { [void]$errors.Add("timed out copying $childRel (will retry next run)") }
      } catch {
        [void]$errors.Add("failed copying ${childRel}: $($_.Exception.Message)")
      }
    }

    [void]$files.Add([ordered]@{
      rel = $childRel
      size = $size
      modified = $modified
      sig = $sig
      kind = $(if ($isSidecar) { 'sidecar' } else { 'image' })
      already = $already
      staged = $staged
    })
  }
}

if ($Only) {
  # Sync tags: just PhotoApp's tag folder, tag files only.
  $tagFolder = Get-FolderByPath $phone.Root $Only
  if (-not $tagFolder) { throw "PicJot's tag folder '$Only' was not found on the phone. Run a full backup." }
  Visit $tagFolder $Only $false
} else {
  foreach ($root in $Roots) {
    $f = Get-Child $phone.Root $root.Name
    if ($f) { Visit $f.GetFolder $root.Name $root.Images }
  }
}

Write-Utf8Json $Result ([ordered]@{
  phone = $phone.Name
  files = $files
  errors = $errors
  pushed = $false
})
