[CmdletBinding()]
param(
  [string]$Remote = "ubuntu@133.18.122.18",
  [string]$SshKey = "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key",
  [string]$RemoteVaultRoot = "/var/lib/umbrella-comic-studio/vault",
  [string]$LocalVaultRoot = "C:\Users\myabe\OneDrive\Desktop\Obsidian Folder",
  [string]$LogDir = "C:\Users\myabe\OneDrive\Desktop\Obsidian Folder\Umbrella Parade\漫画\04_半自動制作システム\10_オンライン版開発\data\sync-logs"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-LogLine {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$timestamp] $Message"
  Write-Host $line
  Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path $LocalVaultRoot | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$script:LogFile = Join-Path $LogDir ("vps-manga-image-sync-" + (Get-Date -Format "yyyyMMdd") + ".log")
$lastStatusFile = Join-Path $LogDir "vps-manga-image-sync-last.json"
$archiveName = "umbrella-manga-images-" + (Get-Date -Format "yyyyMMddHHmmss") + "-" + ([Guid]::NewGuid().ToString("N")) + ".tar.gz"
$localArchive = Join-Path $env:TEMP $archiveName
$stageDir = Join-Path $env:TEMP ("umbrella-manga-images-stage-" + ([Guid]::NewGuid().ToString("N")))
$remoteArchive = "/tmp/$archiveName"

$sshArgs = @(
  "-i", $SshKey,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=30",
  $Remote
)

$remoteScript = @'
set -e
ROOT="$1"
ARCHIVE="$2"
TMP="$(mktemp -d)"
export ROOT
export TMP
cd "$ROOT"
python3 - <<'PY'
import json
import os
import shutil
root = os.environ["ROOT"]
tmp = os.environ["TMP"]
image_exts = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
manga = "\u6f2b\u753b"
image = "\u753b\u50cf"
statuses = {"\u4e88\u7d04\u6e08\u307f", "\u6295\u7a3f\u6e08\u307f", "\u672a\u6295\u7a3f"}
files_dir = os.path.join(tmp, "files")
os.makedirs(files_dir, exist_ok=True)
manifest = []
for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    parts = [] if rel_dir == "." else rel_dir.replace(os.sep, "/").split("/")
    if manga not in parts or image not in parts:
        continue
    try:
        image_index = parts.index(image)
    except ValueError:
        continue
    if len(parts) <= image_index + 1 or parts[image_index + 1] not in statuses:
        continue
    for name in filenames:
        ext = os.path.splitext(name)[1].lower()
        if ext not in image_exts:
            continue
        full = os.path.join(dirpath, name)
        rel = os.path.join(rel_dir, name).replace(os.sep, "/")
        stored = f"files/{len(manifest) + 1:06d}{ext}"
        shutil.copy2(full, os.path.join(tmp, stored))
        stat = os.stat(full)
        manifest.append({
            "stored": stored,
            "relative": rel,
            "bytes": stat.st_size,
            "modifiedAt": stat.st_mtime
        })
with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
PY
tar -czf "$ARCHIVE" -C "$TMP" manifest.json files
rm -rf "$TMP"
printf '%s\n' "$ARCHIVE"
'@

$startedAt = Get-Date
try {
  Write-LogLine "VPS manga image sync started."
  Write-LogLine "Remote: $Remote"
  Write-LogLine "LocalVaultRoot: $LocalVaultRoot"

  $remoteResult = $remoteScript | & ssh @sshArgs "bash" "-s" "--" $RemoteVaultRoot $remoteArchive
  if ($LASTEXITCODE -ne 0) {
    throw "ssh failed with exit code $LASTEXITCODE"
  }
  $remoteArchivePath = ($remoteResult | Select-Object -Last 1).Trim()
  if (-not $remoteArchivePath) {
    throw "Remote archive path was empty."
  }

  & scp -i $SshKey -o BatchMode=yes -o ConnectTimeout=30 "${Remote}:${remoteArchivePath}" $localArchive
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed with exit code $LASTEXITCODE"
  }

  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
  & tar -xzf $localArchive -C $stageDir
  if ($LASTEXITCODE -ne 0) {
    throw "tar extract failed with exit code $LASTEXITCODE"
  }
  $manifestPath = Join-Path $stageDir "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Manifest was not found in archive."
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $fileCount = @($manifest).Count
  $localRootFull = [System.IO.Path]::GetFullPath($LocalVaultRoot)
  foreach ($item in @($manifest)) {
    $relativePath = [string]$item.relative
    if (-not $relativePath) { continue }
    $relativeWindows = $relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar
    $destination = [System.IO.Path]::GetFullPath((Join-Path $LocalVaultRoot $relativeWindows))
    if (-not $destination.StartsWith($localRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Unsafe destination path: $destination"
    }
    $source = Join-Path $stageDir ([string]$item.stored -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $source)) { continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
    if ($item.modifiedAt) {
      try {
        [System.IO.File]::SetLastWriteTime($destination, [DateTimeOffset]::FromUnixTimeSeconds([int64][double]$item.modifiedAt).LocalDateTime)
      } catch {}
    }
  }

  & ssh @sshArgs "rm -f '$remoteArchivePath'" | Out-Null
  Remove-Item -LiteralPath $localArchive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue

  $finishedAt = Get-Date
  $status = [ordered]@{
    ok = $true
    startedAt = $startedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    copiedOrRefreshedFiles = $fileCount
    remote = $Remote
    remoteVaultRoot = $RemoteVaultRoot
    localVaultRoot = $LocalVaultRoot
    logFile = $script:LogFile
  }
  $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $lastStatusFile -Encoding UTF8
  Write-LogLine "VPS manga image sync finished. Files in archive: $fileCount"
} catch {
  $finishedAt = Get-Date
  $status = [ordered]@{
    ok = $false
    startedAt = $startedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    error = $_.Exception.Message
    remote = $Remote
    remoteVaultRoot = $RemoteVaultRoot
    localVaultRoot = $LocalVaultRoot
    logFile = $script:LogFile
  }
  $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $lastStatusFile -Encoding UTF8
  Write-LogLine ("ERROR: " + $_.Exception.Message)
  Remove-Item -LiteralPath $localArchive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
