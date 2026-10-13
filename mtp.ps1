<#
  PhotoApp PC backup - phone access over USB (Windows MTP via Shell.Application).

  Node cannot talk to MTP devices; this helper does only the device I/O:
    - list photo files (and PhotoApp sidecars) on the phone,
    - copy NEW or CHANGED ones into a local staging folder,
    - optionally push one file (a backup receipt) back to the phone.
  It never deletes or modifies anything on the phone.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File mtp.ps1 `
      -Staging <dir> -Pulled <pulled.json> -Result <result.json> [-ListOnly] [-PushFile <file>]

  Pulled index: JSON object { "<phone relative path>": "<size>|<modified ISO>" }
  of files already backed up; matching entries are skipped.
#>
param(
  [Parameter(Mandatory = $true)][string]$Staging,
  [Parameter(Mandatory = $true)][string]$Pulled,
  [Parameter(Mandatory = $true)][string]$Result,
  [switch]$ListOnly,
  [string]$PushFile
)

$ErrorActionPreference = 'Stop'

$Roots = @('DCIM', 'Pictures', 'Download')
$ImageExts = @('.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng')
$SidecarFolder = 'DCIM/photoAppMetadada'
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

# Push mode: copy one local file (a backup receipt) into the phone's sidecar
# folder, then stop - no listing or pulling.
if ($PushFile) {
  $target = Get-FolderByPath $phone.Root $SidecarFolder
  $pushed = $false
  if ($target) {
    $target.CopyHere($PushFile, 4 + 16 + 1024)
    $name = [IO.Path]::GetFileName($PushFile)
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $pushed -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
      $pushed = [bool](Get-Child $target $name)
    }
  } else {
    [void]$errors.Add("phone folder $SidecarFolder not found; receipt not pushed")
  }
  Write-Utf8Json $Result ([ordered]@{ phone = $phone.Name; files = @(); errors = $errors; pushed = $pushed })
  exit 0
}

function Copy-FromPhone($item, $destDir, $expectedSize) {
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $target = Join-Path $destDir $item.Name
  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -eq $expectedSize)) { return $true }
  # 4 = no progress UI, 16 = yes to all, 1024 = no error UI. MTP copies are
  # asynchronous, so wait for the file to reach its full size.
  $phone.Shell.Namespace($destDir).CopyHere($item, 4 + 16 + 1024)
  $deadline = (Get-Date).AddSeconds(120 + [math]::Ceiling($expectedSize / 2MB))
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -eq $expectedSize)) { return $true }
    Start-Sleep -Milliseconds 150
  }
  return $false
}

function Visit($folder, $rel) {
  foreach ($item in @($folder.Items())) {
    $childRel = if ($rel) { "$rel/$($item.Name)" } else { $item.Name }
    if ($item.IsFolder) {
      if ($item.Name.StartsWith('.')) { continue } # .thumbnails, .trash etc.
      Visit $item.GetFolder $childRel
      continue
    }
    $ext = [IO.Path]::GetExtension($item.Name).ToLowerInvariant()
    $isSidecar = ($rel -eq $SidecarFolder) -and ($item.Name -match $SidecarName)
    if (-not $isSidecar -and -not ($ImageExts -contains $ext)) { continue }

    $size = [int64]$item.ExtendedProperty('System.Size')
    $modRaw = $item.ExtendedProperty('System.DateModified')
    $modified = if ($modRaw) { ([datetime]$modRaw).ToUniversalTime().ToString('o') } else { '' }
    $sig = "$size|$modified"
    $already = $pulledMap.ContainsKey($childRel) -and ($pulledMap[$childRel] -eq $sig)

    $staged = $false
    if (-not $already -and -not $ListOnly) {
      $destDir = Join-Path $Staging ($rel -replace '/', '\')
      try {
        $staged = Copy-FromPhone $item $destDir $size
        if (-not $staged) { [void]$errors.Add("timed out copying $childRel") }
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

foreach ($root in $Roots) {
  $f = Get-Child $phone.Root $root
  if ($f) { Visit $f.GetFolder $root }
}

Write-Utf8Json $Result ([ordered]@{
  phone = $phone.Name
  files = $files
  errors = $errors
  pushed = $false
})
