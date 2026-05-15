const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const IS_RAILWAY = !!(
  process.env.RAILWAY_ENVIRONMENT
  || process.env.RAILWAY_PROJECT_ID
  || process.env.RAILWAY_SERVICE_ID
  || process.env.RAILWAY_PUBLIC_DOMAIN
);
const ONLINE_MODE = IS_RAILWAY || /^(1|true|yes|on)$/i.test(String(process.env.ONLINE_MODE || ""));
const HOST = process.env.HOST || (ONLINE_MODE ? "0.0.0.0" : "127.0.0.1");
const PORT = Number(process.env.PORT || process.env.X_POST_SERVER_PORT || 8787);
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/+$/, "");
const MAX_BODY_BYTES = 25 * 1024 * 1024;
function resolveWritableDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    ONLINE_MODE ? path.join(process.cwd(), "data") : __dirname,
    path.join(os.tmpdir(), "umbrella-parade-manga-online")
  ].filter(Boolean);

  const tried = new Set();
  for (const candidate of candidates) {
    const dir = path.resolve(candidate);
    if (tried.has(dir)) continue;
    tried.add(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".write-test"), "ok", "utf8");
      fs.rmSync(path.join(dir, ".write-test"), { force: true });
      return dir;
    } catch (error) {
      console.warn(`Data directory is not writable: ${dir}`, error.message || String(error));
    }
  }
  throw new Error("No writable data directory was found.");
}

const DATA_DIR = resolveWritableDataDir();
const LOG_PATH = path.join(DATA_DIR, "x-post-server.log");
const SCHEDULE_PATH = path.join(DATA_DIR, "x-scheduled-posts.json");
const IMPORT_DIRS_PATH = path.join(DATA_DIR, "manga-import-directories.json");
const OAUTH_TOKENS_PATH = path.join(DATA_DIR, "x-oauth-tokens.json");
const RUNTIME_IMAGES_PATH = path.join(DATA_DIR, "runtime-images.json");
const SEED_IDEA_STOCK_PATH = path.join(__dirname, "seed-idea-stock.json");
const GITHUB_WORKFLOWS_DIR = path.join(__dirname, ".github", "workflows");
const GIT_DIR = path.join(__dirname, ".git");
const VAULT_ROOT = process.env.VAULT_ROOT || path.resolve(__dirname, "..", "..", "..", "..");
const DEFAULT_SCOPES = "tweet.read tweet.write users.read media.write offline.access";
const FILE_RETRY_ATTEMPTS = Number(process.env.FILE_RETRY_ATTEMPTS || 10);
const FILE_RETRY_DELAY_MS = Number(process.env.FILE_RETRY_DELAY_MS || 180);
let lastError = null;
let scheduleTickRunning = false;
const oauthSessions = new Map();
const oauthResults = new Map();
const oauthLatestResults = new Map();

function log(message, extra = null) {
  const line = `[${new Date().toISOString()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`;
  fs.appendFile(LOG_PATH, line, () => {});
  console.log(line.trim());
}

function rememberError(error, context = {}) {
  lastError = {
    at: new Date().toISOString(),
    message: error.message || String(error),
    status: error.status || null,
    context,
    detail: error.body || null
  };
  log("ERROR", lastError);
}

function isRetryableFileError(error) {
  const code = error && error.code;
  const message = String((error && error.message) || "");
  return ["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(code)
    || /unknown error|resource busy|being used by another process|temporarily unavailable/i.test(message);
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileRetry(action, label, filePath) {
  let lastErrorForRetry = null;
  for (let attempt = 1; attempt <= FILE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return action();
    } catch (error) {
      lastErrorForRetry = error;
      if (!isRetryableFileError(error) || attempt >= FILE_RETRY_ATTEMPTS) throw error;
      log("FILE_RETRY", {
        label,
        filePath,
        attempt,
        message: error.message || String(error)
      });
      sleepSync(FILE_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErrorForRetry;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, title, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 32px; line-height: 1.75; color: #111827; background: #f8fafc; }
    main { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 28px; }
    h1 { font-size: 22px; margin: 0 0 16px; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readJsonFile(filePath, fallback) {
  try {
    return withFileRetry(() => {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw || "null");
      return parsed && typeof parsed === "object" ? parsed : fallback;
    }, "readJsonFile", filePath);
  } catch (error) {
    rememberError(error, { route: "readJsonFile", filePath });
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  withFileRetry(() => {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }, "writeJsonFile", filePath);
}

function gitPath() {
  return process.platform === "win32" ? "git" : "/usr/bin/git";
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isGitHubActionsSchedulerMode() {
  return fs.existsSync(GITHUB_WORKFLOWS_DIR);
}

function gitScheduleSyncError(error) {
  const parts = [error.message, error.stderr, error.stdout]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean);
  return parts.join(" / ").slice(0, 1200) || "GitHub同期に失敗しました。";
}

async function syncScheduleQueueToGitHub(reason = "schedule update") {
  if (!isGitHubActionsSchedulerMode()) {
    return { ok: true, skipped: true, reason: "local_scheduler_mode" };
  }
  if (!fs.existsSync(GIT_DIR)) {
    return { ok: true, skipped: true, reason: "not_git_repo" };
  }

  const git = gitPath();
  try {
    await execFileAsync(git, ["add", "x-scheduled-posts.json"], { cwd: __dirname });
    try {
      await execFileAsync(git, ["diff", "--staged", "--quiet", "--", "x-scheduled-posts.json"], { cwd: __dirname });
      return { ok: true, skipped: true, reason: "no_schedule_changes" };
    } catch (diffError) {
      if (Number(diffError.code) !== 1) throw diffError;
    }

    await execFileAsync(git, ["commit", "-m", "chore: 予約投稿スケジュール更新 [skip ci]", "--", "x-scheduled-posts.json"], { cwd: __dirname });
    await execFileAsync(git, ["push"], { cwd: __dirname });
    const result = { ok: true, pushed: true, reason, at: new Date().toISOString() };
    log("SCHEDULE_GIT_SYNC_DONE", result);
    return result;
  } catch (error) {
    const result = { ok: false, error: gitScheduleSyncError(error), reason };
    log("SCHEDULE_GIT_SYNC_FAILED", result);
    return result;
  }
}

async function pullScheduleQueueFromGitHub(reason = "schedule list") {
  if (!isGitHubActionsSchedulerMode()) {
    return { ok: true, skipped: true, reason: "local_scheduler_mode" };
  }
  if (!fs.existsSync(GIT_DIR)) {
    return { ok: true, skipped: true, reason: "not_git_repo" };
  }

  try {
    const { stdout } = await execFileAsync(gitPath(), ["pull", "--ff-only", "origin", "main"], { cwd: __dirname });
    const result = {
      ok: true,
      pulled: true,
      reason,
      stdout: String(stdout || "").trim().slice(0, 600),
      at: new Date().toISOString()
    };
    log("SCHEDULE_GIT_PULL_DONE", result);
    return result;
  } catch (error) {
    const result = { ok: false, error: gitScheduleSyncError(error), reason };
    log("SCHEDULE_GIT_PULL_FAILED", result);
    return result;
  }
}

function findToolHtmlPath() {
  const preferred = path.join(__dirname, "漫画半自動制作ツール.html");
  if (fs.existsSync(preferred)) return preferred;
  const html = fs.readdirSync(__dirname).find((name) => /\.html$/i.test(name));
  return html ? path.join(__dirname, html) : "";
}

function sendToolHtml(res) {
  const toolHtmlPath = findToolHtmlPath();
  if (!toolHtmlPath) {
    sendHtml(res, 404, "Tool not found", "<h1>Tool HTML was not found.</h1>");
    return;
  }
  fs.readFile(toolHtmlPath, (error, content) => {
    if (error) {
      rememberError(error, { route: "sendToolHtml" });
      sendHtml(res, 500, "Tool read error", "<h1>Tool HTML could not be read.</h1>");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });

}

function sendMangaGenericHtml(res) {
  const p = path.join(__dirname, "..", "08_汎用漫画ツール", "漫画制作ツール（汎用版）.html");
  fs.readFile(p, (error, content) => {
    if (error) {
      sendHtml(res, 404, "Not found", "<h1>漫画制作ツール（汎用版）.html が見つかりません。</h1>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(content);
  });
}

function sendCharPresets(res) {
  const p = path.join(__dirname, "漫画キャラプリセット.json");
  fs.readFile(p, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(content);
  });
}

function saveMarkdownNote(relativePath, content) {
  // VAULT_ROOT = Obsidianフォルダのルート
  const safePath = relativePath.replace(/\.\./g, '').replace(/^[\\/]+/, '');
  const absPath = path.join(VAULT_ROOT, safePath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

function readImportDirectories() {
  const parsed = readJsonFile(IMPORT_DIRS_PATH, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeImportDirectories(map) {
  writeJsonFile(IMPORT_DIRS_PATH, map || {});
}

function importDirectoryForCharacter(character) {
  const map = readImportDirectories();
  const folder = String(map[String(character || "")] || "").trim();
  return folder && fs.existsSync(folder) ? folder : "";
}

function mediaTypeFromImageName(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function listImportImages(character) {
  const folder = importDirectoryForCharacter(character);
  if (!folder) return { folder: "", images: [] };
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  const images = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const fullPath = path.join(folder, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        modifiedMs: stat.mtimeMs,
        mediaType: mediaTypeFromImageName(entry.name)
      };
    })
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { folder, images };
}

function safeImportImagePath(character, imageName) {
  const folder = importDirectoryForCharacter(character);
  if (!folder) throw new Error("Import directory is not set.");
  const baseName = path.basename(String(imageName || ""));
  if (!baseName) throw new Error("Image name is empty.");
  const resolvedFolder = path.resolve(folder);
  const fullPath = path.resolve(resolvedFolder, baseName);
  if (!fullPath.startsWith(`${resolvedFolder}${path.sep}`)) {
    throw new Error("Invalid image path.");
  }
  if (!fs.existsSync(fullPath)) throw new Error("Image file was not found.");
  return fullPath;
}

function chooseFolderWithPowerShell(description = "Select manga image import folder") {
  if (process.platform !== "win32") return Promise.reject(new Error("フォルダ選択はWindows専用機能です。クラウド環境では使用できません。"));
  const ps = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const safeDescription = String(description || "Select folder").replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = '${safeDescription}'`,
    "$dialog.ShowNewFolderButton = $true",
    "$dialog.RootFolder = [System.Environment+SpecialFolder]::Desktop",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }"
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile(ps, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: false,
      timeout: 120000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("送信データが大きすぎます。画像サイズを小さくしてください。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function dataUrlToXMedia(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("画像データがbase64形式ではありません。ツールでキープ画像を読み込み直してください。");
  }
  return { mediaType: match[1], media: match[2] };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomToken(bytes = 48) {
  return base64Url(crypto.randomBytes(bytes));
}

function normalizeToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/[\r\n\t ]+/g, "");
}

function validateToken(raw) {
  const token = normalizeToken(raw);
  if (!token) throw new Error("X User Access Tokenが空です。");
  if (/[^\x21-\x7E]/.test(token)) {
    throw new Error("X User Access Tokenに日本語・全角文字・説明文が混ざっています。access_token 文字列だけを貼ってください。");
  }
  return token;
}

function friendlyXErrorMessage(message) {
  const text = String(message || "");
  const isAppOnlyError = /Application-Only is forbidden/i.test(text)
    || (/Application-Only/i.test(text) && /User Context/i.test(text));
  if (isAppOnlyError) {
    return "XのApp-only Bearer Tokenが入力されています。このツールには、投稿するXアカウント本人として認可したOAuth 2.0 User Contextのaccess_tokenが必要です。Developer PortalのApp only Access Tokenでは投稿できません。必要スコープ: tweet.read / tweet.write / users.read / media.write。";
  }
  if (/CreditsDepleted/i.test(text) || /does not have any credits/i.test(text)) {
    return "X APIのクレジット残高がありません。Developer PortalのBilling/Usage/CreditsでX API creditsを追加するまで、API経由の投稿・確認は実行できません。";
  }
  return text;
}

function safeRedirectUri(raw) {
  const localFallback = `http://127.0.0.1:${PORT}/x-callback`;
  const fallback = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/x-callback` : localFallback;
  const value = String(raw || fallback).trim();
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Callback URLはhttpまたはhttpsで始まる必要があります。");
  }
  return parsed.toString();
}

function oauthHeaders(clientId, clientSecret) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  return headers;
}

async function oauthTokenRequest(params, clientId, clientSecret) {
  const body = new URLSearchParams(params);
  if (!clientSecret) {
    body.set("client_id", clientId);
  }
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: oauthHeaders(clientId, clientSecret),
    body
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json.error_description || json.detail || json.title || json.error || json.raw || `X OAuth error: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

function oauthResultWithoutToken(result) {
  if (!result) return null;
  if (!result.ok) return result;
  return {
    ok: true,
    ready: true,
    character: result.character,
    token: {
      access_token: result.token.access_token,
      refresh_token: result.token.refresh_token || "",
      expires_in: result.token.expires_in || null,
      scope: result.token.scope || "",
      token_type: result.token.token_type || "bearer"
    },
    obtainedAt: result.obtainedAt
  };
}

function readOAuthTokenStore() {
  const parsed = readJsonFile(OAUTH_TOKENS_PATH, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeOAuthTokenStore(map) {
  writeJsonFile(OAUTH_TOKENS_PATH, map || {});
}

function storedOAuthResult(character) {
  const key = String(character || "");
  if (!key) return null;
  const record = readOAuthTokenStore()[key];
  if (!record || !record.token || !record.token.access_token) return null;
  return {
    ok: true,
    ready: true,
    character: key,
    token: record.token,
    clientId: record.clientId || "",
    clientSecret: record.clientSecret || "",
    obtainedAt: record.obtainedAt || ""
  };
}

function persistOAuthResult(result) {
  if (!result || !result.ok || !result.token || !result.token.access_token) return;
  const character = String(result.character || "");
  if (!character) return;
  const map = readOAuthTokenStore();
  const previous = map[character] || {};
  const previousToken = previous.token || {};
  map[character] = {
    character,
    token: {
      ...previousToken,
      ...result.token,
      refresh_token: result.token.refresh_token || previousToken.refresh_token || ""
    },
    clientId: result.clientId || previous.clientId || "",
    clientSecret: result.clientSecret || previous.clientSecret || "",
    obtainedAt: result.obtainedAt || previous.obtainedAt || new Date().toISOString(),
    savedAt: new Date().toISOString()
  };
  writeOAuthTokenStore(map);
}

function updatePendingScheduleTokensForCharacter(result) {
  if (!result || !result.ok || !result.token || !result.token.access_token) return 0;
  const character = String(result.character || "");
  if (!character) return 0;
  const queue = readScheduleQueue();
  let changed = 0;
  queue.forEach((job) => {
    if (String(job.character || "") !== character) return;
    if (!["pending", "posting"].includes(job.status)) return;
    job.token = validateToken(result.token.access_token);
    if (result.token.refresh_token) job.refreshToken = result.token.refresh_token;
    if (result.clientId) job.clientId = result.clientId;
    if (result.clientSecret) job.clientSecret = result.clientSecret;
    if (result.token.expires_in) job.tokenExpiresAt = Date.now() + Math.max(60, Number(result.token.expires_in)) * 1000;
    changed += 1;
  });
  if (changed) writeScheduleQueue(queue);
  return changed;
}

function rememberOAuthResult(state, result) {
  if (state) oauthResults.set(state, result);
  const character = String(result.character || "");
  if (character) oauthLatestResults.set(character, result);
  oauthLatestResults.set("__latest__", result);
  persistOAuthResult(result);
  return updatePendingScheduleTokensForCharacter(result);
}

function oauthCallbackScript(state, character) {
  const payload = JSON.stringify({
    type: "umbrella-x-oauth",
    state,
    character: character || ""
  });
  return `<script>
(function () {
  var payload = ${payload};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, "*");
    }
  } catch (error) {}
  window.setTimeout(function () {
    try { window.close(); } catch (error) {}
  }, 2500);
})();
</script>`;
}

async function xApiJson(url, token, body = null, method = "POST") {
  token = validateToken(token);
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`
    }
  };
  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const errors = Array.isArray(json.errors)
      ? json.errors.map((err) => err.detail || err.title || err.message).filter(Boolean).join(" / ")
      : "";
    const rawMessage = json.detail || json.title || json.error?.message || errors || json.raw || `X API error: ${response.status}`;
    const message = friendlyXErrorMessage(rawMessage);
    const error = new Error(message);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

async function uploadImageToX(token, imageDataUrl) {
  const { media, mediaType } = dataUrlToXMedia(imageDataUrl);
  const json = await xApiJson("https://api.x.com/2/media/upload", token, {
    media,
    media_category: "tweet_image",
    media_type: mediaType
  });
  const mediaId = json.data && (json.data.id || json.data.media_id_string);
  if (!mediaId) {
    throw new Error("Xへの画像アップロード結果からmedia_idを取得できませんでした。");
  }
  return mediaId;
}

async function createXPost(token, text, mediaId, madeWithAi) {
  const body = { text };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };
  if (madeWithAi) body.made_with_ai = true;
  const json = await xApiJson("https://api.x.com/2/tweets", token, body);
  const postId = json.data && json.data.id;
  if (!postId) {
    throw new Error("X投稿結果からPost IDを取得できませんでした。");
  }
  return {
    id: postId,
    text: json.data.text || text,
    url: `https://x.com/i/web/status/${postId}`
  };
}

async function deleteXPost(token, postId) {
  const id = String(postId || "").trim();
  if (!/^[0-9]{1,19}$/.test(id)) {
    throw new Error("削除するX Post IDが正しくありません。");
  }
  const json = await xApiJson(`https://api.x.com/2/tweets/${encodeURIComponent(id)}`, token, null, "DELETE");
  if (!json.data || json.data.deleted !== true) {
    throw new Error("X投稿削除の結果を確認できませんでした。");
  }
  return { id, deleted: true };
}

function readScheduleQueue() {
  try {
    return withFileRetry(() => {
      if (!fs.existsSync(SCHEDULE_PATH)) return [];
      const raw = fs.readFileSync(SCHEDULE_PATH, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw || "[]");
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    }, "readScheduleQueue", SCHEDULE_PATH);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    rememberError(error, { route: "readScheduleQueue" });
    throw error;
  }
}

function writeScheduleQueue(queue) {
  const payload = JSON.stringify(Array.isArray(queue) ? queue : [], null, 2);
  withFileRetry(() => {
    fs.writeFileSync(SCHEDULE_PATH, payload, "utf8");
  }, "writeScheduleQueue", SCHEDULE_PATH);
}

function publicScheduleJob(job) {
  return {
    id: job.id,
    reservationId: job.reservationId || "",
    character: job.character || "",
    title: job.title || "",
    scheduledAt: job.scheduledAt || "",
    status: job.status || "pending",
    text: job.text || "",
    createdAt: job.createdAt || "",
    postedAt: job.postedAt || "",
    post: job.post || null,
    error: job.error || "",
    deletedAt: job.deletedAt || ""
  };
}

function publicScheduleJobImage(job) {
  return {
    id: job.id || "",
    reservationId: job.reservationId || "",
    character: job.character || "",
    title: job.title || "",
    filename: job.filename || "",
    imageDataUrl: job.imageDataUrl || ""
  };
}

function markSchedulePostDeleted({ reservationId = "", scheduleJobId = "", postId = "" } = {}) {
  const queue = readScheduleQueue();
  let changed = false;
  const deletedAt = new Date().toISOString();
  queue.forEach((job) => {
    const matchesJob = scheduleJobId && job.id === scheduleJobId;
    const matchesReservation = reservationId && job.reservationId === reservationId;
    const matchesPost = postId && job.post && String(job.post.id || "") === String(postId);
    if (!(matchesJob || matchesReservation || matchesPost)) return;
    job.status = "deleted";
    job.deletedAt = deletedAt;
    job.error = "";
    changed = true;
  });
  if (changed) writeScheduleQueue(queue);
  return changed;
}

async function refreshTokenForScheduledJob(job) {
  const stored = storedOAuthResult(job.character || "");
  const storedToken = stored && stored.token ? stored.token : null;
  const refreshToken = String((storedToken && storedToken.refresh_token) || job.refreshToken || "").trim();
  const clientId = String((stored && stored.clientId) || job.clientId || "").trim();
  const clientSecret = String((stored && stored.clientSecret) || job.clientSecret || "").trim();
  if (!refreshToken || !clientId) {
    const accessToken = (storedToken && storedToken.access_token) || job.token;
    return validateToken(accessToken);
  }
  const token = await oauthTokenRequest({
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  }, clientId, clientSecret);
  job.token = validateToken(token.access_token);
  if (token.refresh_token) job.refreshToken = token.refresh_token;
  job.clientId = clientId;
  job.clientSecret = clientSecret;
  if (token.expires_in) job.tokenExpiresAt = Date.now() + Math.max(60, Number(token.expires_in)) * 1000;
  persistOAuthResult({
    ok: true,
    ready: true,
    character: job.character || "",
    token,
    clientId,
    clientSecret,
    obtainedAt: new Date().toISOString()
  });
  return job.token;
}

async function postScheduledJob(job) {
  const token = await refreshTokenForScheduledJob(job);
  const mediaId = await uploadImageToX(token, job.imageDataUrl);
  const post = await createXPost(token, job.text, mediaId, !!job.madeWithAi);
  return { post, mediaId };
}

async function tickScheduleQueue() {
  if (scheduleTickRunning) return;
  scheduleTickRunning = true;
  try {
    const queue = readScheduleQueue();
    const now = Date.now();
    let changed = false;

    for (const job of queue) {
      if (job.status !== "pending") continue;
      const dueAt = Date.parse(job.scheduledAt || "");
      if (!Number.isFinite(dueAt) || dueAt > now) continue;

      job.status = "posting";
      job.startedAt = new Date().toISOString();
      changed = true;
      writeScheduleQueue(queue);

      try {
        log("SCHEDULE_POST_START", { id: job.id, reservationId: job.reservationId || "", character: job.character || "", title: job.title || "" });
        const { post, mediaId } = await postScheduledJob(job);
        job.status = "done";
        job.postedAt = new Date().toISOString();
        job.post = post;
        job.mediaId = mediaId;
        job.error = "";
        log("SCHEDULE_POST_DONE", { id: job.id, postId: post.id, url: post.url });
      } catch (error) {
        job.status = "failed";
        job.failedAt = new Date().toISOString();
        job.error = friendlyXErrorMessage(error.message || String(error));
        job.errorDetail = error.body || null;
        rememberError(error, { route: "schedule", scheduleId: job.id });
      }
      changed = true;
      writeScheduleQueue(queue);
    }

    if (changed) writeScheduleQueue(queue);
  } finally {
    scheduleTickRunning = false;
  }
}

async function handleCancelScheduleX(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const scheduleJobId = String(payload.scheduleJobId || "").trim();
  const reservationId = String(payload.reservationId || "").trim();
  const queue = readScheduleQueue();
  const index = queue.findIndex((job) => {
    return (scheduleJobId && job.id === scheduleJobId) || (reservationId && job.reservationId === reservationId && ["pending", "failed"].includes(job.status));
  });
  if (index < 0) throw new Error("削除できるX予約が見つかりませんでした。");

  const job = queue[index];
  if (job.status === "posting") throw new Error("このX予約は現在投稿処理中のため削除できません。少し待ってから状態を確認してください。");
  if (job.status === "done") throw new Error("このX予約はすでに投稿済みです。X投稿IDが反映されたあと、X投稿削除を実行してください。");
  if (job.status === "deleted") throw new Error("このX予約はすでに削除済みです。");

  queue.splice(index, 1);
  writeScheduleQueue(queue);
  const cancelled = publicScheduleJob({ ...job, status: "cancelled", deletedAt: new Date().toISOString(), error: "" });
  log("SCHEDULE_CANCELLED", { id: cancelled.id, reservationId: cancelled.reservationId || "", character: cancelled.character || "", title: cancelled.title || "" });
  const gitPush = await syncScheduleQueueToGitHub("schedule cancel");
  sendJson(res, 200, { ok: true, job: cancelled, gitPush });
}

async function handleScheduleX(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const token = validateToken(payload.token);
  const text = String(payload.text || "").trim();
  const scheduledAtMs = Date.parse(payload.scheduledAt || "");
  if (!text) throw new Error("投稿文が空です。");
  if (!payload.imageDataUrl) throw new Error("画像データがありません。");
  if (!Number.isFinite(scheduledAtMs)) throw new Error("予約日時が正しくありません。");
  if (scheduledAtMs <= Date.now() + 30000) throw new Error("X予約投稿は30秒以上先の日時を指定してください。今すぐ投稿する場合は「今すぐXに投稿」を使ってください。");

  const job = {
    id: randomToken(12),
    reservationId: String(payload.reservationId || ""),
    character: String(payload.character || ""),
    title: String(payload.title || ""),
    scheduledAt: new Date(scheduledAtMs).toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
    token,
    refreshToken: String(payload.refreshToken || ""),
    clientId: String(payload.clientId || ""),
    clientSecret: String(payload.clientSecret || ""),
    text,
    imageDataUrl: String(payload.imageDataUrl || ""),
    filename: String(payload.filename || ""),
    madeWithAi: !!payload.madeWithAi,
    imageByteSize: payload.imageByteSize || null,
    compressed: !!payload.compressed
  };
  persistOAuthResult({
    ok: true,
    ready: true,
    character: job.character,
    token: {
      access_token: job.token,
      refresh_token: job.refreshToken || "",
      token_type: "bearer"
    },
    clientId: job.clientId,
    clientSecret: job.clientSecret,
    obtainedAt: new Date().toISOString()
  });

  const queue = readScheduleQueue().filter((item) => {
    return !(job.reservationId && item.reservationId === job.reservationId && ["pending", "posting"].includes(item.status));
  });
  queue.push(job);
  queue.sort((a, b) => Date.parse(a.scheduledAt || 0) - Date.parse(b.scheduledAt || 0));
  writeScheduleQueue(queue);
  log("SCHEDULE_QUEUED", publicScheduleJob(job));
  const gitPush = await syncScheduleQueueToGitHub("schedule queue");
  sendJson(res, 200, { ok: true, job: publicScheduleJob(job), gitPush });
}

async function handleOAuthStart(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const clientId = String(payload.clientId || "").trim();
  const clientSecret = String(payload.clientSecret || "").trim();
  if (!clientId) throw new Error("X OAuth Client IDを入力してください。");
  const redirectUri = safeRedirectUri(payload.redirectUri);
  const scopes = String(payload.scopes || DEFAULT_SCOPES).trim() || DEFAULT_SCOPES;
  const state = randomToken(32);
  const codeVerifier = randomToken(64);
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  oauthSessions.set(state, {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    character: String(payload.character || ""),
    codeVerifier,
    createdAt: Date.now()
  });
  const authorizeUrl = new URL("https://x.com/i/oauth2/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  log("OAUTH_START", { character: payload.character || "", scopes, redirectUri });
  sendJson(res, 200, { ok: true, authorizeUrl: authorizeUrl.toString(), state, redirectUri, scopes });
}

async function handleOAuthCallback(req, res) {
  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const state = requestUrl.searchParams.get("state") || "";
  const code = requestUrl.searchParams.get("code") || "";
  const errorParam = requestUrl.searchParams.get("error") || "";
  const errorDescription = requestUrl.searchParams.get("error_description") || "";
  const session = oauthSessions.get(state);

  if (!state || !session) {
    sendHtml(res, 400, "X OAuthエラー", "<h1>X OAuthエラー</h1><p>認可情報が見つかりませんでした。ツールからもう一度「Xログインしてトークン取得」を押してください。</p>");
    return;
  }

  if (errorParam) {
    const message = errorDescription || errorParam;
    rememberOAuthResult(state, { ok: false, ready: true, error: message, character: session.character });
    oauthSessions.delete(state);
    sendHtml(res, 400, "X認可がキャンセルされました", `<h1>X認可が完了しませんでした</h1><p>${escapeHtml(message)}</p><p>ツールに戻って、必要ならもう一度やり直してください。</p>${oauthCallbackScript(state, session.character)}`);
    return;
  }

  try {
    if (!code) throw new Error("Xから認可コードが返ってきませんでした。");
    const token = await oauthTokenRequest({
      code,
      grant_type: "authorization_code",
      redirect_uri: session.redirectUri,
      code_verifier: session.codeVerifier
    }, session.clientId, session.clientSecret);
    const updated = rememberOAuthResult(state, {
      ok: true,
      ready: true,
      character: session.character,
      token,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      obtainedAt: new Date().toISOString()
    });
    if (updated) await syncScheduleQueueToGitHub("oauth callback token sync");
    oauthSessions.delete(state);
    log("OAUTH_TOKEN_READY", { character: session.character || "", hasRefreshToken: !!token.refresh_token });
    sendHtml(res, 200, "Xログイン完了", `<h1>Xログインが完了しました</h1><p>${escapeHtml(session.character || "選択中キャラクター")}用のUser Context tokenを取得しました。</p><p>この画面は自動で閉じます。閉じない場合は、漫画半自動制作ツールを開き直して「OAuth取得結果確認」を押してください。</p>${oauthCallbackScript(state, session.character)}`);
  } catch (error) {
    rememberError(error, { route: "/x-callback" });
    rememberOAuthResult(state, { ok: false, ready: true, error: error.message || String(error), detail: error.body || null, character: session.character });
    oauthSessions.delete(state);
    sendHtml(res, error.status || 500, "X OAuthエラー", `<h1>X OAuthエラー</h1><p>${escapeHtml(error.message || String(error))}</p><p>Callback URL、Client ID、Client Secret、アプリ権限を確認してください。</p>${oauthCallbackScript(state, session.character)}`);
  }
}

async function handleOAuthRefresh(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const clientId = String(payload.clientId || "").trim();
  const clientSecret = String(payload.clientSecret || "").trim();
  const refreshToken = String(payload.refreshToken || "").trim();
  const character = String(payload.character || "").trim();
  if (!clientId) throw new Error("X OAuth Client IDを入力してください。");
  if (!refreshToken) throw new Error("Refresh Tokenが保存されていません。もう一度Xログインで取得してください。");
  const token = await oauthTokenRequest({
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  }, clientId, clientSecret);
  const updated = rememberOAuthResult("", {
    ok: true,
    ready: true,
    character,
    token,
    clientId,
    clientSecret,
    obtainedAt: new Date().toISOString()
  });
  const gitPush = updated ? await syncScheduleQueueToGitHub("oauth refresh token sync") : { ok: true, skipped: true, reason: "no_pending_schedule_token_updates" };
  log("OAUTH_TOKEN_REFRESHED", { hasRefreshToken: !!token.refresh_token });
  sendJson(res, 200, { ok: true, token, gitPush });
}

async function handleOAuthStore(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const character = String(payload.character || "").trim();
  if (!character) throw new Error("Character is empty.");
  const stored = storedOAuthResult(character) || {};
  const accessToken = validateToken(payload.accessToken || payload.token || payload.access_token);
  const token = {
    access_token: accessToken,
    refresh_token: String(payload.refreshToken || payload.refresh_token || stored.token?.refresh_token || ""),
    expires_in: payload.expiresIn || payload.expires_in || null,
    token_type: "bearer"
  };
  const result = {
    ok: true,
    ready: true,
    character,
    token,
    clientId: String(payload.clientId || stored.clientId || ""),
    clientSecret: String(payload.clientSecret || stored.clientSecret || ""),
    obtainedAt: new Date().toISOString()
  };
  const updated = rememberOAuthResult("", result);
  const gitPush = updated ? await syncScheduleQueueToGitHub("oauth store token sync") : { ok: true, skipped: true, reason: "no_pending_schedule_token_updates" };
  sendJson(res, 200, { ok: true, updated, gitPush });
}


function normalizeWordPressSiteUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("WordPressサイトURLを入力してください。");
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("WordPressサイトURLはhttpまたはhttpsで始まる必要があります。");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeApplicationPassword(raw) {
  return String(raw || "").replace(/\s+/g, "");
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

function wordpressEnvKeyForCharacter(raw) {
  const value = String(raw || "").trim();
  const lower = value.toLowerCase();
  if (/カーラ|carla/.test(value) || lower.includes("carla")) return "CARLA";
  if (/ヴェル|vel|vel13/.test(value) || lower.includes("vel")) return "VEL13";
  if (/べるぼ|belbo/.test(value) || lower.includes("belbo")) return "BELBO";
  return value
    .normalize("NFKC")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "DEFAULT";
}

function resolveWordPressCredentials(payload = {}) {
  const key = wordpressEnvKeyForCharacter(payload.character);
  const siteUrl = envValue(
    `WP_${key}_SITE_URL`,
    `WORDPRESS_${key}_SITE_URL`,
    "WP_SITE_URL",
    "WORDPRESS_SITE_URL"
  ) || payload.siteUrl;
  const username = envValue(
    `WP_${key}_USERNAME`,
    `WORDPRESS_${key}_USERNAME`,
    "WP_USERNAME",
    "WORDPRESS_USERNAME"
  ) || payload.username;
  const appPassword = envValue(
    `WP_${key}_APP_PASSWORD`,
    `WORDPRESS_${key}_APP_PASSWORD`,
    "WP_APP_PASSWORD",
    "WORDPRESS_APP_PASSWORD"
  ) || payload.appPassword;
  return {
    siteUrl: normalizeWordPressSiteUrl(siteUrl),
    username: String(username || "").trim(),
    appPassword: normalizeApplicationPassword(appPassword)
  };
}

function wordpressAuthHeader(username, appPassword) {
  const user = String(username || "").trim();
  const password = normalizeApplicationPassword(appPassword);
  if (!user) throw new Error("WordPressユーザー名を入力してください。");
  if (!password) throw new Error("WordPress Application Passwordを入力してください。");
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function wordpressApiUrl(siteUrl, route, params = null) {
  const url = new URL(`${normalizeWordPressSiteUrl(siteUrl)}/wp-json/wp/v2${route}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

function friendlyWordPressErrorMessage(message) {
  const text = String(message || "");
  if (/rest_cannot_create|rest_cannot_edit|401|Unauthorized/i.test(text)) {
    return "WordPressの認証に失敗しました。ユーザー名とApplication Passwordを確認してください。";
  }
  if (/rest_invalid_param|not registered|meta/i.test(text)) {
    return "WordPress投稿は作成できましたが、SWELL/OGPメタ設定の一部をREST APIが受け付けない可能性があります。";
  }
  return text;
}

async function wordpressJson(siteUrl, username, appPassword, route, options = {}) {
  const response = await fetch(wordpressApiUrl(siteUrl, route, options.params), {
    method: options.method || "GET",
    headers: {
      "Authorization": wordpressAuthHeader(username, appPassword),
      "Accept": "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json.message || json.detail || json.raw || `WordPress API error: ${response.status}`;
    const error = new Error(friendlyWordPressErrorMessage(message));
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

function dataUrlToMediaBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("画像データがbase64形式ではありません。キープ画像を読み込み直してください。");
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

function readRuntimeImages() {
  const images = readJsonFile(RUNTIME_IMAGES_PATH, []);
  return Array.isArray(images) ? images : [];
}

function writeRuntimeImages(images) {
  writeJsonFile(RUNTIME_IMAGES_PATH, Array.isArray(images) ? images : []);
}

function publicRuntimeImage(image) {
  return {
    id: image.id || "",
    character: image.character || "",
    name: image.name || "",
    category: image.category || "オンライン保存画像",
    dataUrl: image.dataUrl || "",
    createdAt: image.createdAt || "",
    source: "railway"
  };
}

function readSeedIdeaStock() {
  const payload = readJsonFile(SEED_IDEA_STOCK_PATH, { ideas: [] });
  const ideas = Array.isArray(payload) ? payload : (Array.isArray(payload.ideas) ? payload.ideas : []);
  return ideas
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      ...item,
      type: "past",
      productionStatus: "made",
      source: item.source || "old_tool_seed"
    }));
}

function handleListSeedIdeaStock(res) {
  const payload = readJsonFile(SEED_IDEA_STOCK_PATH, { generatedAt: "", count: 0, ideas: [] });
  const ideas = readSeedIdeaStock();
  sendJson(res, 200, {
    ok: true,
    generatedAt: payload.generatedAt || "",
    count: ideas.length,
    ideas
  });
}

function runtimeImageFromPayload(payload, character) {
  const dataUrl = String(payload.dataUrl || "");
  const media = dataUrlToMediaBuffer(dataUrl);
  const filename = safeMediaFilename(payload.name || payload.filename, `reference-${Date.now()}`, media.mimeType);
  return {
    id: `srv_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
    character: String(payload.character || character || "").trim() || "ヴェル13世",
    name: filename,
    category: String(payload.category || "オンライン保存画像").trim() || "オンライン保存画像",
    dataUrl,
    byteSize: media.buffer.length,
    createdAt: new Date().toISOString()
  };
}

async function handleListRuntimeImages(req, res, requestUrl) {
  const character = String(requestUrl.searchParams.get("character") || "").trim();
  const images = readRuntimeImages()
    .filter((image) => !character || image.character === character)
    .map(publicRuntimeImage);
  sendJson(res, 200, { ok: true, images });
}

async function handleSaveRuntimeImages(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const character = String(payload.character || "").trim() || "ヴェル13世";
  const rawImages = Array.isArray(payload.images) ? payload.images : [payload];
  const nextImages = rawImages
    .filter((image) => image && image.dataUrl)
    .map((image) => runtimeImageFromPayload(image, character));
  if (!nextImages.length) throw new Error("保存するキャラクター画像がありません。");
  const store = readRuntimeImages();
  store.push(...nextImages);
  writeRuntimeImages(store);
  sendJson(res, 200, { ok: true, images: nextImages.map(publicRuntimeImage) });
}

async function handleDeleteRuntimeImage(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const id = String(payload.id || "").trim();
  const character = String(payload.character || "").trim();
  if (!id) throw new Error("削除する画像IDがありません。");
  const before = readRuntimeImages();
  const after = before.filter((image) => !(image.id === id && (!character || image.character === character)));
  writeRuntimeImages(after);
  sendJson(res, 200, { ok: true, deleted: before.length - after.length });
}

function extensionForMimeType(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };
  return map[String(mimeType || "").toLowerCase()] || ".png";
}

function safeMediaFilename(raw, fallback, mimeType) {
  const ext = extensionForMimeType(mimeType);
  const ascii = String(raw || fallback || "image")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return `${ascii || fallback || "image"}${ext}`;
}

function safeVaultPath(relativePath, mimeType) {
  const ext = extensionForMimeType(mimeType);
  let normalized = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!normalized) throw new Error("保存先パスが空です。");
  if (!path.extname(normalized)) normalized = `${normalized}${ext}`;
  const finalPath = path.resolve(VAULT_ROOT, normalized);
  const rootWithSep = `${VAULT_ROOT}${path.sep}`;
  if (finalPath !== VAULT_ROOT && !finalPath.startsWith(rootWithSep)) {
    throw new Error("保存先パスがObsidian Folderの外を指しています。");
  }
  return { finalPath, relativePath: path.relative(VAULT_ROOT, finalPath).replace(/\\/g, "/") };
}

function saveMangaImageToVault(payload) {
  if (!payload || !payload.imageDataUrl) throw new Error("保存する画像データがありません。");
  const { mimeType, buffer } = dataUrlToMediaBuffer(payload.imageDataUrl);
  const target = safeVaultPath(payload.relativePath, mimeType);
  fs.mkdirSync(path.dirname(target.finalPath), { recursive: true });
  fs.writeFileSync(target.finalPath, buffer);
  return {
    relativePath: target.relativePath,
    fullPath: target.finalPath,
    mimeType,
    bytes: buffer.length,
    savedAt: new Date().toISOString()
  };
}

function safeDownloadFolderPath(folderPath) {
  const raw = String(folderPath || "").trim();
  if (!raw) throw new Error("保存先フォルダーが空です。");
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) {
    throw new Error("ドライブ直下には保存しないでください。フォルダーを指定してください。");
  }
  return resolved;
}

function safeDownloadFilename(filename, mimeType) {
  const ext = extensionForMimeType(mimeType);
  let baseName = path.basename(String(filename || `manga${ext}`)).trim();
  baseName = baseName.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!baseName) baseName = `manga${ext}`;
  if (!path.extname(baseName)) baseName = `${baseName}${ext}`;
  return baseName;
}

function saveImageToFolder(payload) {
  if (!payload || !payload.imageDataUrl) throw new Error("保存する画像データがありません。");
  const { mimeType, buffer } = dataUrlToMediaBuffer(payload.imageDataUrl);
  const folder = safeDownloadFolderPath(payload.folderPath);
  const filename = safeDownloadFilename(payload.filename, mimeType);
  fs.mkdirSync(folder, { recursive: true });
  const finalPath = path.resolve(folder, filename);
  const folderWithSep = `${folder}${path.sep}`;
  if (finalPath !== folder && !finalPath.startsWith(folderWithSep)) {
    throw new Error("保存ファイル名が正しくありません。");
  }
  fs.writeFileSync(finalPath, buffer);
  return {
    folder,
    filename,
    fullPath: finalPath,
    mimeType,
    bytes: buffer.length,
    savedAt: new Date().toISOString()
  };
}

function safeReferenceImagePath(rawPath) {
  let normalized = String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^file:\/+/i, "")
    .trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) {
    throw new Error("Remote reference image URLs are not supported by the local generator.");
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.replace(/\//g, path.sep);
  }
  let resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(__dirname, normalized);
  const root = path.resolve(VAULT_ROOT);
  const rootWithSep = `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("Reference image path must stay inside Obsidian Folder.");
  }
  if (!fs.existsSync(resolved)) {
    const fallback = findMovedReferenceImage(resolved);
    if (fallback) {
      log("REFERENCE_IMAGE_FALLBACK", {
        requested: path.relative(VAULT_ROOT, resolved).replace(/\\/g, "/"),
        resolved: path.relative(VAULT_ROOT, fallback).replace(/\\/g, "/")
      });
      resolved = fallback;
    } else {
      throw new Error(`Reference image not found: ${rawPath}`);
    }
  }
  const ext = path.extname(resolved).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    throw new Error(`Unsupported reference image type: ${path.basename(resolved)}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Reference image is not a file: ${rawPath}`);
  if (stat.size > 50 * 1024 * 1024) throw new Error(`Reference image is larger than 50MB: ${path.basename(resolved)}`);
  return resolved;
}

function findMovedReferenceImage(resolved) {
  const filename = path.basename(resolved);
  if (!filename) return "";
  const root = path.resolve(VAULT_ROOT);
  const rootWithSep = `${root}${path.sep}`;
  const parts = path.normalize(resolved).split(path.sep);
  const imageIndex = parts.lastIndexOf("画像");
  if (imageIndex < 0 || imageIndex >= parts.length - 2) return "";
  const imageRoot = parts.slice(0, imageIndex + 1).join(path.sep);
  const resolvedImageRoot = path.resolve(imageRoot);
  if (resolvedImageRoot !== root && !resolvedImageRoot.startsWith(rootWithSep)) return "";
  if (!fs.existsSync(resolvedImageRoot)) return "";
  const requestedBase = path.basename(filename, path.extname(filename));
  const requestedNumber = (requestedBase.match(/(\d+)$/) || [])[1] || "";
  const numberedCandidates = [];
  const stack = [resolvedImageRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === filename) {
        return fullPath;
      } else if (entry.isFile() && requestedNumber) {
        const candidateBase = path.basename(entry.name, path.extname(entry.name));
        if ((candidateBase.match(/(\d+)$/) || [])[1] === requestedNumber) {
          numberedCandidates.push(fullPath);
        }
      }
    }
  }
  if (numberedCandidates.length) {
    numberedCandidates.sort((a, b) => {
      const aScore = a.includes(`${path.sep}予約済み${path.sep}`) ? 0 : 1;
      const bScore = b.includes(`${path.sep}予約済み${path.sep}`) ? 0 : 1;
      return aScore - bScore || a.localeCompare(b);
    });
    return numberedCandidates[0];
  }
  return "";
}

function safeReferenceFilenameLabel(label) {
  return String(label || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function referenceFilenameWithLabel(filename, label, mimeType) {
  const cleanLabel = safeReferenceFilenameLabel(label);
  const baseName = path.basename(String(filename || `reference${extensionForMimeType(mimeType)}`));
  if (cleanLabel && baseName.startsWith(`${cleanLabel}-`)) return safeDownloadFilename(baseName, mimeType);
  return safeDownloadFilename(cleanLabel ? `${cleanLabel}-${baseName}` : baseName, mimeType);
}

function referenceImageFiles(referencePaths, referenceLabels = []) {
  const seen = new Set();
  const paths = Array.isArray(referencePaths) ? referencePaths : [];
  const labels = Array.isArray(referenceLabels) ? referenceLabels : [];
  return paths
    .map((rawPath, index) => ({
      filePath: safeReferenceImagePath(rawPath),
      label: labels[index] || ""
    }))
    .filter((entry) => entry.filePath)
    .filter((entry) => {
      const key = entry.filePath.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16)
    .map((entry) => {
      const mimeType = mediaTypeFromImageName(entry.filePath);
      return {
        filePath: entry.filePath,
        filename: referenceFilenameWithLabel(path.basename(entry.filePath), entry.label, mimeType),
        mimeType,
        buffer: fs.readFileSync(entry.filePath)
      };
    });
}

function referenceDataUrlFiles(referenceDataUrls) {
  const refs = Array.isArray(referenceDataUrls) ? referenceDataUrls : [];
  return refs
    .map((entry, index) => {
      const dataUrl = typeof entry === "string" ? entry : entry?.dataUrl;
      if (!dataUrl) return null;
      const { mimeType, buffer } = dataUrlToMediaBuffer(dataUrl);
      const normalizedType = String(mimeType || "").toLowerCase();
      if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(normalizedType)) {
        throw new Error(`Unsupported reference image type: ${mimeType || "unknown"}`);
      }
      if (buffer.length > 50 * 1024 * 1024) {
        throw new Error(`Reference image is larger than 50MB: runtime reference ${index + 1}`);
      }
      const rawFilename = typeof entry === "string" ? "" : (entry.filename || entry.name || "");
      const rawLabel = typeof entry === "string" ? "" : (entry.label || "");
      const filename = referenceFilenameWithLabel(rawFilename || `runtime-reference-${index + 1}${extensionForMimeType(mimeType)}`, rawLabel, mimeType);
      return {
        filePath: "",
        filename,
        mimeType,
        buffer
      };
    })
    .filter(Boolean);
}

async function generateOpenAIImageWithReferences(payload) {
  const apiKey = String(payload.apiKey || "").trim();
  const prompt = String(payload.prompt || "").trim();
  if (!apiKey) throw new Error("OpenAI API key is empty.");
  if (!prompt) throw new Error("Image prompt is empty.");

  const files = [
    ...referenceImageFiles(payload.referencePaths, payload.referenceLabels),
    ...referenceDataUrlFiles(payload.referenceDataUrls)
  ].slice(0, 16);
  if (!files.length) throw new Error("No reference image was selected.");

  const model = String(payload.model || "gpt-image-1.5").trim();
  const outputFormat = String(payload.output_format || "png").trim() || "png";
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  if (payload.size) form.append("size", String(payload.size));
  if (payload.quality) form.append("quality", String(payload.quality));
  if (outputFormat) form.append("output_format", outputFormat);
  if (model !== "gpt-image-2") form.append("input_fidelity", "high");
  files.forEach((file) => {
    form.append("image[]", new Blob([file.buffer], { type: file.mimeType }), file.filename);
  });

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: form
  });
  const requestId = response.headers.get("x-request-id") || response.headers.get("openai-request-id") || "";
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json.error?.message || json.message || json.detail || json.raw || `OpenAI image edit error: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = json;
    error.requestId = requestId;
    throw error;
  }
  const first = json.data && json.data[0];
  if (!first) throw new Error("OpenAI image edit returned no image.");
  const dataUrl = first.b64_json
    ? `data:image/${outputFormat};base64,${first.b64_json}`
    : first.url || "";
  if (!dataUrl) throw new Error("OpenAI image edit returned no image data.");
  return {
    imageDataUrl: dataUrl,
    requestId,
    usedReferences: files.map((file) => {
      return file.filePath
        ? path.relative(VAULT_ROOT, file.filePath).replace(/\\/g, "/")
        : file.filename;
    })
  };
}

function normalizeComparableUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    url.hash = "";
    return decodeURIComponent(url.toString()).replace(/\/+$/, "");
  } catch {
    return String(raw || "").trim();
  }
}

async function uploadMediaToWordPress(siteUrl, username, appPassword, buffer, mimeType, filename, altText = "") {
  const response = await fetch(wordpressApiUrl(siteUrl, "/media"), {
    method: "POST",
    headers: {
      "Authorization": wordpressAuthHeader(username, appPassword),
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`
    },
    body: buffer
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json.message || json.detail || json.raw || `WordPress media upload error: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  if (altText && json.id) {
    try {
      await wordpressJson(siteUrl, username, appPassword, `/media/${json.id}`, {
        method: "POST",
        body: { alt_text: altText, title: altText }
      });
    } catch (error) {
      log("WP_MEDIA_ALT_WARNING", { mediaId: json.id, message: error.message });
    }
  }
  return json;
}

async function downloadImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`アイキャッチ画像URLを取得できませんでした: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

async function findMediaBySourceUrl(siteUrl, username, appPassword, sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const basename = decodeURIComponent(path.basename(parsed.pathname)).replace(/\.[^.]+$/, "");
    const list = await wordpressJson(siteUrl, username, appPassword, "/media", {
      params: { per_page: 100, search: basename.slice(0, 40) }
    });
    const target = normalizeComparableUrl(sourceUrl);
    return Array.isArray(list)
      ? list.find((item) => normalizeComparableUrl(item.source_url) === target) || null
      : null;
  } catch (error) {
    log("WP_FIND_MEDIA_WARNING", { message: error.message });
    return null;
  }
}

async function ensureMediaFromUrl(siteUrl, username, appPassword, imageUrl, altText) {
  const existing = await findMediaBySourceUrl(siteUrl, username, appPassword, imageUrl);
  if (existing) return existing;
  const { buffer, mimeType } = await downloadImageBuffer(imageUrl);
  const hash = crypto.createHash("sha1").update(imageUrl).digest("hex").slice(0, 10);
  const filename = safeMediaFilename(`featured-${hash}`, `featured-${hash}`, mimeType);
  return await uploadMediaToWordPress(siteUrl, username, appPassword, buffer, mimeType, filename, altText);
}

async function ensureWordPressCategory(siteUrl, username, appPassword, name, slug) {
  const found = await wordpressJson(siteUrl, username, appPassword, "/categories", {
    params: { slug, per_page: 100 }
  });
  if (Array.isArray(found) && found[0] && found[0].id) return found[0].id;
  const created = await wordpressJson(siteUrl, username, appPassword, "/categories", {
    method: "POST",
    body: { name, slug }
  });
  if (!created.id) throw new Error("WordPressカテゴリーIDを取得できませんでした。");
  return created.id;
}

function wordpressImageBlock(media, altText) {
  const id = Number(media.id);
  const src = escapeHtml(media.source_url || media.guid?.rendered || "");
  const alt = escapeHtml(altText || "");
  return `<!-- wp:image {"id":${id},"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt="${alt}" class="wp-image-${id}"/></figure>
<!-- /wp:image -->`;
}

function wordpressMetaPayload(featuredMediaId, ogImageUrl, swell = {}) {
  return {
    // SWELL display override settings.
    swell_meta_show_thumb: swell.showThumb || "show",
    swell_meta_show_related: swell.showRelated || "show",
    swell_meta_show_author: swell.showAuthor || "hide",
    // SEO SIMPLE PACK uses ssp_meta_image for per-post og:image.
    ssp_meta_image: ogImageUrl || "",
    // Keep common SEO plugin aliases as a soft fallback.
    ssp_meta_ogp_img: ogImageUrl || "",
    ssp_meta_og_image: ogImageUrl || "",
    "_yoast_wpseo_opengraph-image": ogImageUrl || "",
    rank_math_facebook_image: ogImageUrl || "",
    aioseo_og_image_custom_url: ogImageUrl || "",
    og_image: ogImageUrl || "",
    og_image_id: featuredMediaId || ""
  };
}


function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlRpcValue(value) {
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(xmlRpcValue).join("")}</data></array></value>`;
  }
  if (value && typeof value === "object") {
    const members = Object.entries(value).map(([key, val]) => {
      return `<member><name>${xmlEscape(key)}</name>${xmlRpcValue(val)}</member>`;
    }).join("");
    return `<value><struct>${members}</struct></value>`;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return `<value><int>${value}</int></value>`;
  }
  if (typeof value === "boolean") {
    return `<value><boolean>${value ? "1" : "0"}</boolean></value>`;
  }
  return `<value><string>${xmlEscape(value)}</string></value>`;
}

function xmlRpcRequest(methodName, params) {
  const paramXml = params.map((param) => `<param>${xmlRpcValue(param)}</param>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>${xmlEscape(methodName)}</methodName><params>${paramXml}</params></methodCall>`;
}

function xmlRpcFaultMessage(xml) {
  if (!/<fault>/i.test(xml)) return "";
  const stringMatch = xml.match(/<name>\s*faultString\s*<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>\s*<\/value>/i)
    || xml.match(/<string>([\s\S]*?)<\/string>/i);
  return stringMatch ? stringMatch[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&") : "XML-RPC fault";
}

async function wordpressXmlRpc(siteUrl, methodName, params) {
  const endpoint = `${normalizeWordPressSiteUrl(siteUrl)}/xmlrpc.php`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xmlRpcRequest(methodName, params)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WordPress XML-RPC error: HTTP ${response.status}`);
  }
  const fault = xmlRpcFaultMessage(text);
  if (fault) throw new Error(fault);
  return text;
}

function xmlRpcDecode(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlStructMemberValue(structXml, name) {
  const pattern = new RegExp(`<name>\\s*${name}\\s*<\\/name>\\s*<value>\\s*(?:<[^>]+>)?([\\s\\S]*?)(?:<\\/[^>]+>)?\\s*<\\/value>`, "i");
  const match = String(structXml || "").match(pattern);
  return match ? xmlRpcDecode(match[1].replace(/<[^>]+>/g, "").trim()) : "";
}

async function readWordPressCustomFieldIdsXmlRpc(siteUrl, username, appPassword, postId) {
  const xml = await wordpressXmlRpc(siteUrl, "wp.getPost", [
    1,
    String(username || "").trim(),
    normalizeApplicationPassword(appPassword),
    Number(postId),
    ["custom_fields"]
  ]);
  const section = xml.match(/<name>\s*custom_fields\s*<\/name>\s*<value>\s*<array>\s*<data>([\s\S]*?)<\/data>\s*<\/array>\s*<\/value>/i);
  const idsByKey = {};
  if (!section) return idsByKey;
  const structRegex = /<struct>([\s\S]*?)<\/struct>/gi;
  let match;
  while ((match = structRegex.exec(section[1]))) {
    const id = xmlStructMemberValue(match[1], "id");
    const key = xmlStructMemberValue(match[1], "key");
    if (!key || !id) continue;
    idsByKey[key] = idsByKey[key] || [];
    idsByKey[key].push(id);
  }
  return idsByKey;
}

async function updateWordPressCustomFieldsXmlRpc(siteUrl, username, appPassword, postId, metaPayload) {
  const idsByKey = await readWordPressCustomFieldIdsXmlRpc(siteUrl, username, appPassword, postId).catch((error) => {
    log("WP_META_XMLRPC_READ_WARNING", { postId, message: error.message });
    return {};
  });
  const customFields = [];
  Object.entries(metaPayload)
    .filter(([, value]) => value !== undefined && value !== null)
    .forEach(([key, value]) => {
      const ids = idsByKey[key] || [];
      if (ids.length) {
        ids.forEach((id) => customFields.push({ id: String(id), key, value: String(value) }));
      } else {
        customFields.push({ key, value: String(value) });
      }
    });
  if (!customFields.length) return;
  await wordpressXmlRpc(siteUrl, "wp.editPost", [
    1,
    String(username || "").trim(),
    normalizeApplicationPassword(appPassword),
    Number(postId),
    { custom_fields: customFields }
  ]);
}

async function applyWordPressPostMeta(siteUrl, username, appPassword, postId, metaPayload) {
  let restError = null;
  let restSucceeded = false;
  try {
    await wordpressJson(siteUrl, username, appPassword, `/posts/${postId}`, {
      method: "POST",
      body: { meta: metaPayload }
    });
    restSucceeded = true;
  } catch (error) {
    restError = error;
    log("WP_META_REST_WARNING", { postId, message: error.message });
  }

  try {
    await updateWordPressCustomFieldsXmlRpc(siteUrl, username, appPassword, postId, metaPayload);
    return { method: restSucceeded ? "rest+xmlrpc" : "xmlrpc", restError: restError ? restError.message : "" };
  } catch (error) {
    if (restSucceeded) {
      const xmlRpcMessage = error.message || String(error);
      const metaError = new Error(`RESTは成功しましたが、XML-RPCで既存カスタムフィールド更新に失敗しました: ${xmlRpcMessage}`);
      metaError.xmlRpcError = error;
      throw metaError;
    }
    const combined = restError ? `${restError.message} / XML-RPC: ${error.message}` : error.message;
    const metaError = new Error(combined);
    metaError.restError = restError;
    metaError.xmlRpcError = error;
    throw metaError;
  }
}


function wordpressDateGmt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("WordPress予約日時が正しくありません。");
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function wordpressDateLocal(value, fallbackUtc = "") {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.length === 16 ? `${raw}:00` : raw;
  }
  if (fallbackUtc) {
    const date = new Date(fallbackUtc);
    if (Number.isNaN(date.getTime())) throw new Error("WordPress予約日時が正しくありません。");
    return date.toISOString().replace(/\.\d{3}Z$/, "");
  }
  throw new Error("WordPress予約日時が正しくありません。");
}

async function handleCheckWordPress(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const { siteUrl, username, appPassword } = resolveWordPressCredentials(payload);
  const user = await wordpressJson(siteUrl, username, appPassword, "/users/me", {
    params: { context: "edit" }
  });
  sendJson(res, 200, { ok: true, user: { id: user.id, name: user.name, slug: user.slug } });
}

async function handleUpdateWordPressSchedule(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const { siteUrl, username, appPassword } = resolveWordPressCredentials(payload);
  const postId = Number(payload.postId || 0);
  const scheduled = Date.parse(payload.scheduledAt || "");
  if (!postId) throw new Error("WordPress投稿IDがありません。");
  if (!Number.isFinite(scheduled)) throw new Error("WordPress予約日時が正しくありません。");
  if (scheduled <= Date.now() + 30000) throw new Error("WordPress予約投稿は30秒以上先の日時を指定してください。");

  const post = await wordpressJson(siteUrl, username, appPassword, `/posts/${postId}`, {
    method: "POST",
    body: {
      status: "future",
      date: wordpressDateLocal(payload.scheduledLocal, payload.scheduledAt),
      date_gmt: wordpressDateGmt(payload.scheduledAt)
    }
  });

  sendJson(res, 200, {
    ok: true,
    post: {
      id: post.id,
      link: post.link,
      status: post.status,
      slug: post.slug,
      date: post.date || "",
      date_gmt: post.date_gmt || ""
    }
  });
}

async function handlePostWordPress(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const { siteUrl, username, appPassword } = resolveWordPressCredentials(payload);
  const status = String(payload.status || "future").trim();
  const title = String(payload.title || "").trim();
  const slug = String(payload.slug || "").trim();
  const excerpt = String(payload.excerpt || "").trim();
  const featuredImageUrl = String(payload.featuredImageUrl || payload.ogImageUrl || "").trim();
  const warnings = [];

  if (!title) throw new Error("WordPress投稿タイトルが空です。");
  if (!slug) throw new Error("WordPress投稿スラッグが空です。");
  if (!payload.imageDataUrl) throw new Error("WordPressへ送る漫画画像がありません。");
  if (!featuredImageUrl) throw new Error("固定アイキャッチURLが空です。");
  if (status === "future") {
    const scheduled = Date.parse(payload.scheduledAt || "");
    if (!Number.isFinite(scheduled)) throw new Error("WordPress予約日時が正しくありません。");
    if (scheduled <= Date.now() + 30000) throw new Error("WordPress予約投稿は30秒以上先の日時を指定してください。");
  }

  const categoryId = await ensureWordPressCategory(
    siteUrl,
    username,
    appPassword,
    payload.categoryName || "4コマ漫画",
    payload.categorySlug || "4-panel-comic"
  );

  const mediaData = dataUrlToMediaBuffer(payload.imageDataUrl);
  const mediaFilename = safeMediaFilename(payload.filename, `manga-${Date.now()}`, mediaData.mimeType);
  const mangaMedia = await uploadMediaToWordPress(
    siteUrl,
    username,
    appPassword,
    mediaData.buffer,
    mediaData.mimeType,
    mediaFilename,
    payload.altText || title
  );

  const featuredMedia = await ensureMediaFromUrl(siteUrl, username, appPassword, featuredImageUrl, payload.altText || title);
  const postBody = {
    title,
    content: wordpressImageBlock(mangaMedia, payload.altText || title),
    excerpt,
    slug,
    status,
    categories: [categoryId],
    featured_media: featuredMedia.id
  };
  if (status === "future") {
    postBody.date = wordpressDateLocal(payload.scheduledLocal, payload.scheduledAt);
    postBody.date_gmt = wordpressDateGmt(payload.scheduledAt);
  }

  const postId = Number(payload.postId || 0);
  const post = postId
    ? await wordpressJson(siteUrl, username, appPassword, `/posts/${postId}`, {
        method: "POST",
        body: postBody
      })
    : await wordpressJson(siteUrl, username, appPassword, "/posts", {
        method: "POST",
        body: postBody
      });

  const metaPayload = wordpressMetaPayload(featuredMedia.id, payload.ogImageUrl || featuredImageUrl, payload.swell || {});
  try {
    const metaResult = await applyWordPressPostMeta(siteUrl, username, appPassword, post.id, metaPayload);
    log("WP_META_APPLIED", { postId: post.id, method: metaResult.method });
  } catch (error) {
    warnings.push("SWELL/OGPメタを自動反映できませんでした。XML-RPCが無効、またはカスタムフィールド権限が不足している可能性があります。");
    log("WP_META_WARNING", { postId: post.id, message: error.message });
  }

  sendJson(res, 200, {
    ok: true,
    post: {
      id: post.id,
      link: post.link,
      status: post.status,
      slug: post.slug,
      date: post.date || "",
      date_gmt: post.date_gmt || ""
    },
    media: { id: mangaMedia.id, source_url: mangaMedia.source_url },
    featuredMedia: { id: featuredMedia.id, source_url: featuredMedia.source_url },
    warnings
  });
}


const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && ["/", "/tool", "/tool/"].includes(requestUrl.pathname)) {
    sendToolHtml(res);
    return;
  }

  if (req.method === "GET" && ["/manga-tool", "/manga-tool/"].includes(requestUrl.pathname)) {
    sendMangaGenericHtml(res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/char-presets") {
    sendCharPresets(res);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/save-markdown-note") {
    try {
      const raw = await readBody(req);
      const { relativePath, content } = JSON.parse(raw || "{}");
      if (!relativePath || !content) throw new Error("relativePath と content は必須です。");
      const absPath = saveMarkdownNote(relativePath, content);
      log("MARKDOWN_NOTE_SAVED", { absPath });
      sendJson(res, 200, { ok: true, absPath });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "umbrella-parade-manga-online",
      port: PORT,
      host: HOST,
      onlineMode: ONLINE_MODE,
      publicBaseUrl: PUBLIC_BASE_URL || "",
      dataDir: DATA_DIR
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/last-error") {
    sendJson(res, 200, { ok: true, error: lastError });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/seed-idea-stock") {
    handleListSeedIdeaStock(res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/runtime-images") {
    try {
      await handleListRuntimeImages(req, res, requestUrl);
    } catch (error) {
      rememberError(error, { route: "/runtime-images" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Runtime image list error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/runtime-images") {
    try {
      await handleSaveRuntimeImages(req, res);
    } catch (error) {
      rememberError(error, { route: "/runtime-images" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Runtime image save error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/runtime-images/delete") {
    try {
      await handleDeleteRuntimeImage(req, res);
    } catch (error) {
      rememberError(error, { route: "/runtime-images/delete" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Runtime image delete error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/import-directory") {
    try {
      const character = requestUrl.searchParams.get("character") || "";
      const result = listImportImages(character);
      sendJson(res, 200, { ok: true, character, ...result });
    } catch (error) {
      rememberError(error, { route: "/import-directory" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Import directory error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/choose-import-directory") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const character = String(payload.character || "").trim();
      if (!character) throw new Error("Character is empty.");
      const folder = await chooseFolderWithPowerShell();
      if (!folder) {
        sendJson(res, 200, { ok: true, cancelled: true, character });
        return;
      }
      const map = readImportDirectories();
      map[character] = folder;
      writeImportDirectories(map);
      const result = listImportImages(character);
      sendJson(res, 200, { ok: true, character, ...result });
    } catch (error) {
      rememberError(error, { route: "/choose-import-directory" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Import directory selection error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/choose-download-directory") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const character = String(payload.character || "").trim();
      const folder = await chooseFolderWithPowerShell("Select manga image download folder");
      if (!folder) {
        sendJson(res, 200, { ok: true, cancelled: true, character });
        return;
      }
      sendJson(res, 200, { ok: true, character, folder });
    } catch (error) {
      rememberError(error, { route: "/choose-download-directory" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Download directory selection error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/import-image-file") {
    try {
      const character = requestUrl.searchParams.get("character") || "";
      const name = requestUrl.searchParams.get("name") || "";
      const filePath = safeImportImagePath(character, name);
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": mediaTypeFromImageName(filePath),
        "Cache-Control": "no-store"
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      rememberError(error, { route: "/import-image-file" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Import image file error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/import-image-data") {
    try {
      const character = requestUrl.searchParams.get("character") || "";
      const name = requestUrl.searchParams.get("name") || "";
      const filePath = safeImportImagePath(character, name);
      const mediaType = mediaTypeFromImageName(filePath);
      const dataUrl = `data:${mediaType};base64,${fs.readFileSync(filePath).toString("base64")}`;
      sendJson(res, 200, { ok: true, character, filename: path.basename(filePath), mediaType, dataUrl });
    } catch (error) {
      rememberError(error, { route: "/import-image-data" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Import image data error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/oauth/start") {
    try {
      await handleOAuthStart(req, res);
    } catch (error) {
      rememberError(error, { route: "/oauth/start" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "X OAuth開始でエラーが起きました。", detail: error.body || null });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/x-callback") {
    await handleOAuthCallback(req, res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/oauth/result") {
    const state = requestUrl.searchParams.get("state") || "";
    const result = oauthResults.get(state);
    if (!state) {
      sendJson(res, 400, { ok: false, error: "OAuth stateがありません。" });
    } else if (!result) {
      sendJson(res, 200, { ok: true, ready: false });
    } else {
      sendJson(res, result.ok ? 200 : 500, oauthResultWithoutToken(result));
      if (result.ok) oauthResults.delete(state);
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/oauth/latest") {
    const character = requestUrl.searchParams.get("character") || "";
    let result = character ? oauthLatestResults.get(character) : null;
    if (!result && character) result = storedOAuthResult(character);
    if (!result && oauthLatestResults.size === 1) {
      result = Array.from(oauthLatestResults.values())[0];
    }
    if (!result) result = oauthLatestResults.get("__latest__");
    if (!result) {
      sendJson(res, 200, { ok: true, ready: false });
    } else {
      sendJson(res, result.ok ? 200 : 500, oauthResultWithoutToken(result));
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/oauth/refresh") {
    try {
      await handleOAuthRefresh(req, res);
    } catch (error) {
      rememberError(error, { route: "/oauth/refresh" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Xトークン更新でエラーが起きました。", detail: error.body || null });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/oauth/store") {
    try {
      await handleOAuthStore(req, res);
    } catch (error) {
      rememberError(error, { route: "/oauth/store" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "OAuth token store error.", detail: error.body || null });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/check-wordpress") {
    try {
      await handleCheckWordPress(req, res);
    } catch (error) {
      rememberError(error, { route: "/check-wordpress" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "WordPress接続確認でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/post-wordpress") {
    try {
      await handlePostWordPress(req, res);
    } catch (error) {
      rememberError(error, { route: "/post-wordpress" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "WordPress投稿でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/update-wordpress-schedule") {
    try {
      await handleUpdateWordPressSchedule(req, res);
    } catch (error) {
      rememberError(error, { route: "/update-wordpress-schedule" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "WordPress予約日時更新でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/save-manga-image") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const saved = saveMangaImageToVault(payload);
      log("MANGA_IMAGE_SAVED", {
        character: payload.character || "",
        title: payload.title || "",
        relativePath: saved.relativePath,
        bytes: saved.bytes
      });
      sendJson(res, 200, { ok: true, saved });
    } catch (error) {
      rememberError(error, { route: "/save-manga-image" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "漫画画像のローカル保存でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/save-image-to-folder") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const saved = saveImageToFolder(payload);
      log("IMAGE_SAVED_TO_FOLDER", {
        character: payload.character || "",
        title: payload.title || "",
        fullPath: saved.fullPath,
        bytes: saved.bytes
      });
      sendJson(res, 200, { ok: true, saved });
    } catch (error) {
      rememberError(error, { route: "/save-image-to-folder" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "画像のフォルダー保存でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/generate-openai-image-with-references") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const generated = await generateOpenAIImageWithReferences(payload);
      log("OPENAI_IMAGE_WITH_REFERENCES", {
        model: payload.model || "",
        references: generated.usedReferences,
        requestId: generated.requestId || ""
      });
      sendJson(res, 200, { ok: true, ...generated });
    } catch (error) {
      rememberError(error, { route: "/generate-openai-image-with-references" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "OpenAI reference image generation failed.",
        detail: error.body || null,
        requestId: error.requestId || ""
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/check-token") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const token = validateToken(payload.token);
      const json = await xApiJson("https://api.x.com/2/users/me", token, null, "GET");
      sendJson(res, 200, { ok: true, user: json.data || null });
    } catch (error) {
      rememberError(error, { route: "/check-token" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "Xトークン確認でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/schedule-list") {
    const gitPull = await pullScheduleQueueFromGitHub("schedule list");
    const jobs = readScheduleQueue().map(publicScheduleJob);
    sendJson(res, 200, { ok: true, jobs, gitPull });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/schedule-image") {
    try {
      const id = String(requestUrl.searchParams.get("id") || "").trim();
      const reservationId = String(requestUrl.searchParams.get("reservationId") || "").trim();
      if (!id && !reservationId) throw new Error("X予約キューIDが指定されていません。");
      const job = readScheduleQueue().find((item) => {
        return (id && item.id === id) || (reservationId && item.reservationId === reservationId);
      });
      if (!job) {
        const error = new Error("X予約キューの画像が見つかりませんでした。");
        error.status = 404;
        throw error;
      }
      if (!job.imageDataUrl) throw new Error("このX予約キューには画像データが保存されていません。");
      sendJson(res, 200, { ok: true, image: publicScheduleJobImage(job) });
    } catch (error) {
      rememberError(error, { route: "/schedule-image" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "X予約キュー画像の取得でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/schedule-x") {
    try {
      await handleScheduleX(req, res);
    } catch (error) {
      rememberError(error, { route: "/schedule-x" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "X予約投稿の登録でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/cancel-x-schedule") {
    try {
      await handleCancelScheduleX(req, res);
    } catch (error) {
      rememberError(error, { route: "/cancel-x-schedule" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "X予約削除でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/delete-x") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const token = validateToken(payload.token);
      const postId = String(payload.postId || "").trim();
      log("DELETE_X_START", { postId, reservationId: payload.reservationId || "", character: payload.character || "", title: payload.title || "" });
      const deleted = await deleteXPost(token, postId);
      const queueChanged = markSchedulePostDeleted({
        reservationId: String(payload.reservationId || ""),
        scheduleJobId: String(payload.scheduleJobId || ""),
        postId
      });
      const gitPush = queueChanged ? await syncScheduleQueueToGitHub("schedule delete") : { ok: true, skipped: true, reason: "schedule_not_changed" };
      log("DELETE_X_DONE", deleted);
      sendJson(res, 200, { ok: true, deleted, gitPush });
    } catch (error) {
      rememberError(error, { route: "/delete-x" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "X投稿削除でエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/post-x") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const token = validateToken(payload.token);
      const text = String(payload.text || "").trim();

      if (!text) throw new Error("投稿文が空です。");
      if (!payload.imageDataUrl) throw new Error("画像データがありません。");

      log("POST_START", {
        character: payload.character || "",
        title: payload.title || "",
        textLength: text.length,
        imageByteSize: payload.imageByteSize || null,
        compressed: !!payload.compressed
      });
      const mediaId = await uploadImageToX(token, payload.imageDataUrl);
      log("MEDIA_UPLOADED", { mediaId });
      const post = await createXPost(token, text, mediaId, !!payload.madeWithAi);
      log("POST_CREATED", { id: post.id, url: post.url });
      sendJson(res, 200, { ok: true, post, mediaId });
    } catch (error) {
      rememberError(error, { route: "/post-x" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "X投稿サーバーでエラーが起きました。",
        detail: error.body || null
      });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.on("error", (error) => {
  rememberError(error, { route: "server.listen" });
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. 既にX投稿サーバーが起動している可能性があります。`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const displayUrl = PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
  log(`Umbrella Parade manga online server running at ${displayUrl}`);
  console.log("このウィンドウを閉じると投稿サーバーも停止します。");

  // GitHub Actions (.github/workflows) が存在する場合はローカルスケジューラーを無効化
  // → GitHub Actions 側だけが投稿を担当し、二重投稿を防ぐ
  const hasGitHubActions = isGitHubActionsSchedulerMode();
  if (hasGitHubActions) {
    log("ローカルスケジューラー無効（GitHub Actions モード）二重投稿防止のため、予約投稿はGitHub Actionsが担当します。");
    // GitHubから最新のスケジュールを取得してローカルを同期
    pullScheduleQueueFromGitHub("server startup");
  } else {
    setInterval(tickScheduleQueue, 30000);
    setTimeout(tickScheduleQueue, 2000);
    log("ローカルスケジューラー有効（スタンドアロンモード）");
  }
});
