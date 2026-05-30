#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(REPO_ROOT, ".env"));

const args = new Set(process.argv.slice(2));
const deleteMode = args.has("--delete") || /^(1|true|yes|on)$/i.test(process.env.MANGA_IMAGE_CLEANUP_DELETE || "");
const dryRun = !deleteMode || args.has("--dry-run");
const retentionArg = process.argv.find((arg) => arg.startsWith("--days="));
const retentionDays = Math.max(
  1,
  Number((retentionArg && retentionArg.split("=")[1]) || process.env.MANGA_IMAGE_RETENTION_DAYS || 14)
);

const DATA_DIR = path.resolve(
  process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (process.env.ONLINE_MODE ? "/data" : REPO_ROOT)
  || path.join(os.tmpdir(), "umbrella-parade-manga-online")
);
const VAULT_ROOT = path.resolve(
  process.env.VAULT_ROOT
  || path.join(DATA_DIR, "vault")
);
const REPORT_PATH = path.join(DATA_DIR, "manga-image-cleanup-report.json");

const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const mangaSegment = "\u6f2b\u753b";
const imageSegment = "\u753b\u50cf";
const targetStatusSegments = new Set([
  "\u4e88\u7d04\u6e08\u307f",
  "\u6295\u7a3f\u6e08\u307f",
  "\u672a\u6295\u7a3f"
]);

function walkFiles(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visitor);
    } else if (entry.isFile()) {
      visitor(fullPath);
    }
  }
}

function isTargetMangaImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!imageExts.has(ext)) return false;
  const relative = path.relative(VAULT_ROOT, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  const mangaIndex = parts.indexOf(mangaSegment);
  if (mangaIndex < 0) return false;
  const imageIndex = parts.indexOf(imageSegment);
  if (imageIndex < 0) return false;
  const status = parts[imageIndex + 1] || "";
  return targetStatusSegments.has(status);
}

function formatRelative(filePath) {
  return path.relative(VAULT_ROOT, filePath).replace(/\\/g, "/");
}

function main() {
  const now = Date.now();
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const report = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    dryRun,
    retentionDays,
    cutoffAt: new Date(cutoffMs).toISOString(),
    vaultRoot: VAULT_ROOT,
    scanned: 0,
    matched: 0,
    oldEnough: 0,
    deleted: 0,
    bytesDeleted: 0,
    keptRecent: 0,
    errors: [],
    samples: []
  };

  walkFiles(VAULT_ROOT, (filePath) => {
    report.scanned += 1;
    if (!isTargetMangaImage(filePath)) return;
    report.matched += 1;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      report.errors.push({ file: formatRelative(filePath), error: error.message });
      return;
    }
    if (stat.mtimeMs > cutoffMs) {
      report.keptRecent += 1;
      return;
    }
    report.oldEnough += 1;
    const sample = {
      file: formatRelative(filePath),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
    if (report.samples.length < 50) report.samples.push(sample);
    if (dryRun) return;
    try {
      fs.rmSync(filePath, { force: true });
      report.deleted += 1;
      report.bytesDeleted += stat.size;
    } catch (error) {
      report.errors.push({ file: sample.file, error: error.message });
    }
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

main();
