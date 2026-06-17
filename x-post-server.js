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
const FORCE_LOCAL_SCHEDULER = /^(1|true|yes|on)$/i.test(String(process.env.LOCAL_SCHEDULER || ""));
const FORCE_PERSISTENT_DATA_DIR = /^(1|true|yes|on)$/i.test(String(process.env.DATA_DIR_PERSISTENT || ""));
const HOST = process.env.HOST || (ONLINE_MODE ? "0.0.0.0" : "127.0.0.1");
const PORT = Number(process.env.PORT || process.env.X_POST_SERVER_PORT || 8787);
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/+$/, "");
const MAX_BODY_BYTES = 60 * 1024 * 1024;
function resolveWritableDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    ONLINE_MODE ? "/data" : "",
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
const CLIENT_STATE_PATH = path.join(DATA_DIR, "client-state.json");
const MANGA_IMAGE_CLEANUP_REPORT_PATH = path.join(DATA_DIR, "manga-image-cleanup-report.json");
const SEED_IDEA_STOCK_PATH = path.join(__dirname, "seed-idea-stock.json");
const SEED_RUNTIME_IMAGES_PATH = path.join(__dirname, "seed-runtime-images.json");
const SEED_RUNTIME_IMAGES_DIR = path.join(__dirname, "seed-runtime-images");
const STATIC_ASSETS_DIR = path.join(__dirname, "assets");
const GITHUB_WORKFLOWS_DIR = path.join(__dirname, ".github", "workflows");
const GIT_DIR = path.join(__dirname, ".git");
const GITHUB_API_BASE = String(process.env.PERSISTENCE_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const PERSISTENCE_GITHUB_TOKEN = String(
  process.env.PERSISTENCE_GITHUB_TOKEN
  || process.env.GH_TOKEN
  || process.env.GITHUB_TOKEN
  || ""
).trim();
const PERSISTENCE_GITHUB_REPOSITORY = String(
  process.env.PERSISTENCE_GITHUB_REPOSITORY
  || process.env.GITHUB_REPOSITORY
  || "UmbrellaParade/4comic-online"
).trim();
const PERSISTENCE_GITHUB_BRANCH = String(process.env.PERSISTENCE_GITHUB_BRANCH || process.env.GITHUB_BRANCH || "main").trim();
const PERSISTENCE_SCHEDULE_PATH = String(process.env.PERSISTENCE_SCHEDULE_PATH || ".persistent/x-scheduled-posts.enc.json")
  .replace(/^\/+/, "")
  .replace(/\\/g, "/");
const PERSISTENCE_ENCRYPTION_KEY = String(
  process.env.PERSISTENCE_ENCRYPTION_KEY
  || process.env.SCHEDULE_ENCRYPTION_KEY
  || ""
).trim();
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
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Umbrella-Sync-Key",
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

function sendVaultBrowserHtml(res) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Umbrella Parade Vault</title>
  <style>
    :root { color-scheme: dark; --bg: #090912; --panel: #141421; --line: #2d2d42; --text: #f8fafc; --muted: #a8b0c2; --accent: #f472b6; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; z-index: 2; padding: 14px 16px; background: rgba(9,9,18,.96); border-bottom: 1px solid var(--line); backdrop-filter: blur(10px); }
    h1 { margin: 0 0 10px; font-size: 18px; letter-spacing: 0; }
    .controls { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; }
    .nav-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .nav-controls button { min-height: 34px; padding: 6px 10px; }
    .file-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.08); }
    .file-controls button { min-height: 34px; padding: 6px 10px; }
    input, button { min-height: 40px; border: 1px solid var(--line); border-radius: 8px; background: #0f1020; color: var(--text); padding: 8px 10px; font-size: 14px; }
    button { cursor: pointer; background: #24243a; }
    button:disabled { cursor: default; opacity: .45; }
    button.primary { background: var(--accent); color: #170511; border-color: var(--accent); font-weight: 700; }
    button.danger { background: #3a1720; color: #fecdd3; border-color: #7f1d1d; }
    main { padding: 14px; max-width: 1120px; margin: 0 auto; }
    .path { color: var(--muted); font-size: 13px; margin: 8px 0 14px; word-break: break-all; }
    .breadcrumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
    .breadcrumbs button { min-height: 30px; padding: 4px 8px; font-size: 12px; background: #191a2c; }
    .breadcrumbs span { color: var(--muted); align-self: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .item { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 10px; min-height: 104px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
    .item button { width: 100%; text-align: left; background: transparent; border: 0; padding: 0; min-height: 0; color: var(--text); }
    .item-actions { display: flex; gap: 6px; margin-top: 2px; }
    .item-actions button { width: auto; min-height: 30px; padding: 4px 8px; border: 1px solid var(--line); background: #202036; font-size: 12px; text-align: center; }
    .item-actions button.danger { border-color: #7f1d1d; background: #3a1720; color: #fecdd3; }
    .thumb { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; background: #080812; border: 1px solid var(--line); }
    .name { font-size: 13px; overflow-wrap: anywhere; line-height: 1.35; }
    .meta { color: var(--muted); font-size: 11px; margin-top: auto; }
    .status { margin-top: 10px; color: var(--muted); font-size: 13px; }
    .error { color: #fca5a5; }
    @media (max-width: 640px) {
      .controls { grid-template-columns: 1fr; }
      .nav-controls { display: grid; grid-template-columns: repeat(3, 1fr); }
      .file-controls { display: grid; grid-template-columns: 1fr 1fr; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
      header { padding: 12px; }
      main { padding: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Umbrella Parade Vault</h1>
    <div class="controls">
      <input id="syncKey" type="password" placeholder="クラウド同期キー">
      <button id="saveKey" type="button">キー保存</button>
      <button id="reload" class="primary" type="button">表示更新</button>
    </div>
    <div class="nav-controls">
      <button id="historyBack" type="button">← 戻る</button>
      <button id="upPath" type="button">ひとつ上</button>
      <button id="rootPath" type="button">トップ</button>
    </div>
    <div class="file-controls">
      <button id="createFolder" type="button">フォルダー作成</button>
      <button id="uploadFile" type="button">ファイル追加</button>
      <input id="uploadFileInput" type="file" multiple hidden>
    </div>
    <div id="status" class="status">同期キーを入れて表示更新を押してください。</div>
  </header>
  <main>
    <div class="path" id="pathLabel">/</div>
    <div class="breadcrumbs" id="breadcrumbs"></div>
    <div class="grid" id="grid"></div>
  </main>
  <script>
    const KEY_STORAGE = "umbrellaVaultBrowserSyncKey";
    const state = { path: "" };
    const keyInput = document.getElementById("syncKey");
    const statusEl = document.getElementById("status");
    const grid = document.getElementById("grid");
    const pathLabel = document.getElementById("pathLabel");
    const breadcrumbs = document.getElementById("breadcrumbs");
    const historyBackButton = document.getElementById("historyBack");
    const upPathButton = document.getElementById("upPath");
    const rootPathButton = document.getElementById("rootPath");
    const createFolderButton = document.getElementById("createFolder");
    const uploadFileButton = document.getElementById("uploadFile");
    const uploadFileInput = document.getElementById("uploadFileInput");
    keyInput.value = localStorage.getItem(KEY_STORAGE) || "";
    state.path = new URLSearchParams(location.search).get("path") || "";
    document.getElementById("saveKey").addEventListener("click", () => {
      localStorage.setItem(KEY_STORAGE, keyInput.value.trim());
      setStatus("同期キーを保存しました。");
    });
    document.getElementById("reload").addEventListener("click", () => loadPath(state.path, false));
    createFolderButton.addEventListener("click", createFolderInCurrentPath);
    uploadFileButton.addEventListener("click", () => uploadFileInput.click());
    uploadFileInput.addEventListener("change", uploadFilesToCurrentPath);
    historyBackButton.addEventListener("click", () => {
      if (history.length > 1) history.back();
      else loadPath(parentPath(state.path));
    });
    upPathButton.addEventListener("click", () => loadPath(parentPath(state.path)));
    rootPathButton.addEventListener("click", () => loadPath(""));
    window.addEventListener("popstate", (event) => {
      const path = (event.state && event.state.path) || new URLSearchParams(location.search).get("path") || "";
      loadPath(path, false);
    });
    function setStatus(message, error = false) {
      statusEl.textContent = message || "";
      statusEl.className = "status" + (error ? " error" : "");
    }
    function authHeaders() {
      const key = keyInput.value.trim() || localStorage.getItem(KEY_STORAGE) || "";
      return key ? { "X-Umbrella-Sync-Key": key } : {};
    }
    async function postJson(url, payload) {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || "処理に失敗しました。");
      return json;
    }
    function joinPath(base, name) {
      return [base, name].filter(Boolean).join("/").replace(/\\/+/g, "/");
    }
    function parentPath(path) {
      const parts = String(path || "").split("/").filter(Boolean);
      parts.pop();
      return parts.join("/");
    }
    function setLocationPath(path) {
      const url = new URL(location.href);
      if (path) url.searchParams.set("path", path);
      else url.searchParams.delete("path");
      const next = url.pathname + url.search + url.hash;
      if (next !== location.pathname + location.search + location.hash) {
        history.pushState({ path }, "", next);
      }
    }
    function updateNavigation() {
      const hasPath = !!state.path;
      upPathButton.disabled = !hasPath;
      rootPathButton.disabled = !hasPath;
      renderBreadcrumbs();
    }
    function renderBreadcrumbs() {
      breadcrumbs.innerHTML = "";
      const rootButton = document.createElement("button");
      rootButton.type = "button";
      rootButton.textContent = "トップ";
      rootButton.addEventListener("click", () => loadPath(""));
      breadcrumbs.appendChild(rootButton);
      const parts = String(state.path || "").split("/").filter(Boolean);
      let current = "";
      parts.forEach((part) => {
        const sep = document.createElement("span");
        sep.textContent = ">";
        breadcrumbs.appendChild(sep);
        current = current ? current + "/" + part : part;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = part;
        const target = current;
        button.addEventListener("click", () => loadPath(target));
        breadcrumbs.appendChild(button);
      });
    }
    function formatBytes(size) {
      const n = Number(size || 0);
      if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
      if (n > 1024) return (n / 1024).toFixed(1) + " KB";
      return n + " B";
    }
    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("ファイルを読み込めませんでした。"));
        reader.readAsDataURL(file);
      });
    }
    async function createFolderInCurrentPath() {
      const name = prompt("作成するフォルダー名を入力してください。");
      if (!name || !name.trim()) return;
      try {
        setStatus("フォルダーを作成中です...");
        await postJson("/vault-create-folder", { path: state.path, name: name.trim() });
        await loadPath(state.path, false);
        setStatus("フォルダーを作成しました。");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }
    async function uploadFilesToCurrentPath(event) {
      const files = Array.from((event.target && event.target.files) || []);
      uploadFileInput.value = "";
      if (!files.length) return;
      try {
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          setStatus("ファイル追加中です... " + (index + 1) + "/" + files.length + " " + file.name);
          const dataUrl = await fileToDataUrl(file);
          await postJson("/vault-upload-file", { path: state.path, name: file.name, dataUrl });
        }
        await loadPath(state.path, false);
        setStatus(files.length + "件のファイルを追加しました。");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }
    async function deleteVaultEntry(entry) {
      if (!entry || !entry.path) return;
      const label = entry.type === "directory" ? "フォルダー" : "ファイル";
      if (!confirm(label + "「" + entry.name + "」を削除しますか？\\nこの操作は元に戻せません。")) return;
      try {
        setStatus("削除中です...");
        await postJson("/vault-delete", { path: entry.path });
        await loadPath(state.path, false);
        setStatus(label + "を削除しました。");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }
    async function loadPath(path = "", push = true) {
      state.path = path || "";
      pathLabel.textContent = "/" + state.path;
      grid.innerHTML = "";
      updateNavigation();
      if (push) setLocationPath(state.path);
      setStatus("読み込み中です...");
      try {
        const res = await fetch("/vault-list?path=" + encodeURIComponent(state.path), { headers: authHeaders() });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.error || "読み込みに失敗しました。");
        renderItems(json);
        setStatus((json.entries || []).length + "件を表示しています。");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }
    function renderItems(json) {
      grid.innerHTML = "";
      if (json.path) {
        grid.appendChild(createNavItem("ひとつ上へ", "folder", () => loadPath(parentPath(json.path)), "上のフォルダーへ戻る"));
      }
      for (const entry of json.entries || []) {
        if (entry.type === "directory") {
          grid.appendChild(createNavItem(entry.name, "folder", () => loadPath(entry.path), "フォルダー", entry));
        } else {
          grid.appendChild(createFileItem(entry));
        }
      }
    }
    function createNavItem(name, type, onClick, meta, entry = null) {
      const cell = document.createElement("div");
      cell.className = "item";
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = '<div class="name">' + (type === "folder" ? "[フォルダー] " : "") + escapeHtml(name) + '</div>';
      button.addEventListener("click", onClick);
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = meta || "";
      cell.append(button, m);
      if (entry) {
        const actions = document.createElement("div");
        actions.className = "item-actions";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "削除";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteVaultEntry(entry);
        });
        actions.appendChild(del);
        cell.appendChild(actions);
      }
      return cell;
    }
    function createFileItem(entry) {
      const cell = document.createElement("div");
      cell.className = "item";
      if (entry.image) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.alt = entry.name;
        loadImageBlob(entry.path, img);
        cell.appendChild(img);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = '<div class="name">' + escapeHtml(entry.name) + '</div>';
      button.addEventListener("click", () => openFile(entry.path, entry.name));
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatBytes(entry.size) + " / " + (entry.modifiedAt || "");
      const actions = document.createElement("div");
      actions.className = "item-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "削除";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteVaultEntry(entry);
      });
      actions.appendChild(del);
      cell.append(button, meta, actions);
      return cell;
    }
    async function loadImageBlob(path, img) {
      try {
        const res = await fetch("/vault-file?path=" + encodeURIComponent(path), { headers: authHeaders() });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        img.src = url;
        img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      } catch {}
    }
    async function openFile(path, name) {
      try {
        const res = await fetch("/vault-file?path=" + encodeURIComponent(path), { headers: authHeaders() });
        if (!res.ok) throw new Error("ファイルを開けませんでした。");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.download = name || "download";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }
    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    }
    loadPath(state.path, false);
  </script>
</body>
</html>`);
}

function vaultAccessKey(req, requestUrl) {
  return String(req.headers["x-umbrella-sync-key"] || requestUrl.searchParams.get("key") || "").trim();
}

function ensureVaultAccess(req, requestUrl) {
  const expected = clientStateSyncKey();
  if (!expected) {
    const error = new Error("Vault browser requires CLIENT_STATE_SYNC_KEY.");
    error.status = 403;
    throw error;
  }
  if (vaultAccessKey(req, requestUrl) !== expected) {
    const error = new Error("同期キーが違うか未入力です。");
    error.status = 403;
    throw error;
  }
}

function safeVaultFilePath(rawPath = "") {
  const clean = String(rawPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (clean.includes("..")) {
    const error = new Error("Invalid vault path.");
    error.status = 400;
    throw error;
  }
  const root = path.resolve(VAULT_ROOT);
  const target = path.resolve(root, clean);
  if (!pathEqualsOrInside(root, target)) {
    const error = new Error("Vault path is outside the allowed folder.");
    error.status = 400;
    throw error;
  }
  return { fullPath: target, relativePath: path.relative(root, target).replace(/\\/g, "/") };
}

function vaultEntryPayload(root, fullPath, entry) {
  const stat = fs.statSync(fullPath);
  const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
  const ext = path.extname(entry.name).toLowerCase();
  return {
    name: entry.name,
    path: relativePath,
    type: entry.isDirectory() ? "directory" : "file",
    size: entry.isFile() ? stat.size : 0,
    modifiedAt: stat.mtime.toISOString().slice(0, 19).replace("T", " "),
    image: entry.isFile() && [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
  };
}

function listVaultFolder(req, res, requestUrl) {
  ensureVaultAccess(req, requestUrl);
  const { fullPath, relativePath } = safeVaultFilePath(requestUrl.searchParams.get("path") || "");
  if (!fs.existsSync(fullPath)) {
    const error = new Error("Vault path was not found.");
    error.status = 404;
    throw error;
  }
  if (!fs.statSync(fullPath).isDirectory()) {
    const error = new Error("Vault path is not a folder.");
    error.status = 400;
    throw error;
  }
  const root = path.resolve(VAULT_ROOT);
  const entries = fs.readdirSync(fullPath, { withFileTypes: true })
    .filter((entry) => ![".git"].includes(entry.name))
    .map((entry) => vaultEntryPayload(root, path.join(fullPath, entry.name), entry))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "ja");
    });
  sendJson(res, 200, { ok: true, root: VAULT_ROOT, path: relativePath, entries });
}

function sendVaultFile(req, res, requestUrl) {
  ensureVaultAccess(req, requestUrl);
  const { fullPath } = safeVaultFilePath(requestUrl.searchParams.get("path") || "");
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    const error = new Error("Vault file was not found.");
    error.status = 404;
    throw error;
  }
  res.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": mediaTypeFromImageName(fullPath),
    "Cache-Control": "private, no-store"
  });
  fs.createReadStream(fullPath).pipe(res);
}

function safeVaultEntryName(rawName = "") {
  const cleaned = String(rawName || "").trim().replace(/[<>:"|?*]/g, "");
  if (!cleaned) {
    const error = new Error("名前が空です。");
    error.status = 400;
    throw error;
  }
  if (cleaned.includes("/") || cleaned.includes("\\") || cleaned.includes("\0") || cleaned.includes("..")) {
    const error = new Error("名前に使えない文字が含まれています。");
    error.status = 400;
    throw error;
  }
  return cleaned;
}

function safeVaultChildPath(parentPath = "", rawName = "") {
  const parent = safeVaultFilePath(parentPath);
  if (!fs.existsSync(parent.fullPath) || !fs.statSync(parent.fullPath).isDirectory()) {
    const error = new Error("追加先フォルダーが見つかりません。");
    error.status = 404;
    throw error;
  }
  const name = safeVaultEntryName(rawName);
  return safeVaultFilePath([parent.relativePath, name].filter(Boolean).join("/"));
}

function uniqueVaultFilePath(target) {
  if (!fs.existsSync(target.fullPath)) return target;
  const dir = path.dirname(target.fullPath);
  const ext = path.extname(target.fullPath);
  const base = path.basename(target.fullPath, ext);
  for (let index = 2; index <= 999; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!fs.existsSync(candidate)) {
      return {
        fullPath: candidate,
        relativePath: path.relative(path.resolve(VAULT_ROOT), candidate).replace(/\\/g, "/")
      };
    }
  }
  const error = new Error("同じ名前のファイルが多すぎます。名前を変えて追加してください。");
  error.status = 409;
  throw error;
}

function createVaultFolder(payload = {}) {
  const target = safeVaultChildPath(payload.path, payload.name);
  if (fs.existsSync(target.fullPath)) {
    const error = new Error("同じ名前のフォルダーまたはファイルがすでにあります。");
    error.status = 409;
    throw error;
  }
  fs.mkdirSync(target.fullPath, { recursive: false });
  return { path: target.relativePath };
}

function ensureVaultFolder(payload = {}) {
  const target = safeVaultFilePath(payload.path || "");
  if (!target.relativePath) return { path: "" };
  fs.mkdirSync(target.fullPath, { recursive: true });
  return { path: target.relativePath };
}

function uploadVaultFile(payload = {}) {
  if (!payload.dataUrl) {
    const error = new Error("追加するファイルデータがありません。");
    error.status = 400;
    throw error;
  }
  const { mimeType, buffer } = dataUrlToMediaBuffer(payload.dataUrl);
  const target = uniqueVaultFilePath(safeVaultChildPath(payload.path, payload.name || `upload-${Date.now()}`));
  withFileRetry(() => fs.writeFileSync(target.fullPath, buffer), "vault-upload-file", target.fullPath);
  return {
    path: target.relativePath,
    name: path.basename(target.fullPath),
    mimeType,
    bytes: buffer.length
  };
}

function deleteVaultEntry(payload = {}) {
  const target = safeVaultFilePath(payload.path);
  if (!target.relativePath) {
    const error = new Error("Vaultのトップは削除できません。");
    error.status = 400;
    throw error;
  }
  if (!fs.existsSync(target.fullPath)) {
    const error = new Error("削除対象が見つかりません。");
    error.status = 404;
    throw error;
  }
  const stat = fs.statSync(target.fullPath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target.fullPath);
    if (entries.length) {
      const error = new Error("中身があるフォルダーは削除できません。先に中のファイルを削除してください。");
      error.status = 400;
      throw error;
    }
    fs.rmdirSync(target.fullPath);
    return { path: target.relativePath, type: "directory" };
  }
  if (!stat.isFile()) {
    const error = new Error("この種類の項目は削除できません。");
    error.status = 400;
    throw error;
  }
  withFileRetry(() => fs.rmSync(target.fullPath, { force: true }), "vault-delete-file", target.fullPath);
  return { path: target.relativePath, type: "file" };
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

function pathEqualsOrInside(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPersistentDataDir() {
  if (!ONLINE_MODE) return true;
  if (FORCE_PERSISTENT_DATA_DIR) return true;
  const dataDir = path.resolve(DATA_DIR);
  const railwayVolume = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (railwayVolume && pathEqualsOrInside(railwayVolume, dataDir)) return true;
  if (process.platform !== "win32" && dataDir === "/data") return true;
  return false;
}

function isRemoteSchedulePersistenceConfigured() {
  return !!(PERSISTENCE_GITHUB_TOKEN && PERSISTENCE_GITHUB_REPOSITORY && PERSISTENCE_GITHUB_BRANCH && PERSISTENCE_ENCRYPTION_KEY);
}

function schedulePersistenceStatus() {
  const hasToken = !!PERSISTENCE_GITHUB_TOKEN;
  const hasEncryptionKey = !!PERSISTENCE_ENCRYPTION_KEY;
  const dataDirPersistent = isPersistentDataDir();
  const remoteScheduleConfigured = isRemoteSchedulePersistenceConfigured();
  return {
    dataDir: DATA_DIR,
    dataDirPersistent,
    remoteSchedule: {
      configured: remoteScheduleConfigured,
      repository: PERSISTENCE_GITHUB_REPOSITORY || "",
      branch: PERSISTENCE_GITHUB_BRANCH || "",
      path: PERSISTENCE_SCHEDULE_PATH,
      encrypted: remoteScheduleConfigured,
      missing: {
        token: !hasToken,
        encryptionKey: !hasEncryptionKey
      }
    },
    durable: dataDirPersistent || remoteScheduleConfigured,
    warning: dataDirPersistent || remoteScheduleConfigured
      ? ""
      : "Railwayの永続Volumeか、暗号化GitHub永続化が未設定です。再デプロイ時に予約キューが消える可能性があります。"
  };
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

function githubContentApiPath(remotePath) {
  return String(remotePath || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function githubRepositoryApiPath() {
  return String(PERSISTENCE_GITHUB_REPOSITORY || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function githubApiJson(method, apiPath, body = null) {
  const url = /^https?:\/\//i.test(String(apiPath || ""))
    ? String(apiPath)
    : `${GITHUB_API_BASE}${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${PERSISTENCE_GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json.message || json.detail || json.raw || `GitHub API error: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

function encryptionKeyBuffer() {
  if (!PERSISTENCE_ENCRYPTION_KEY) throw new Error("PERSISTENCE_ENCRYPTION_KEY is required for encrypted persistence.");
  return crypto.createHash("sha256").update(PERSISTENCE_ENCRYPTION_KEY, "utf8").digest();
}

function encryptPersistentJson(payload, label) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeyBuffer(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: 1,
    encrypted: true,
    algorithm: "aes-256-gcm",
    label,
    updatedAt: new Date().toISOString(),
    payload: {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64")
    }
  }, null, 2);
}

function decryptPersistentJson(rawText) {
  const parsed = JSON.parse(String(rawText || "null"));
  if (!parsed || typeof parsed !== "object" || parsed.encrypted !== true) return parsed;
  const payload = parsed.payload || {};
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKeyBuffer(),
    Buffer.from(String(payload.iv || ""), "base64")
  );
  decipher.setAuthTag(Buffer.from(String(payload.tag || ""), "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(String(payload.data || ""), "base64")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

async function readGitHubTextFile(remotePath) {
  const repo = githubRepositoryApiPath();
  const filePath = githubContentApiPath(remotePath);
  try {
    const json = await githubApiJson(
      "GET",
      `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(PERSISTENCE_GITHUB_BRANCH)}`
    );
    if (!json || json.type !== "file") return { exists: false, text: "", sha: "" };
    let content = String(json.content || "").replace(/\s+/g, "");
    if (!content && json.git_url) {
      const blob = await githubApiJson("GET", json.git_url);
      content = String(blob.content || "").replace(/\s+/g, "");
    }
    if (!content) return { exists: true, text: "", sha: json.sha || "" };
    return {
      exists: true,
      text: Buffer.from(content, "base64").toString("utf8"),
      sha: json.sha || ""
    };
  } catch (error) {
    if (Number(error.status) === 404) return { exists: false, text: "", sha: "" };
    throw error;
  }
}

async function writeGitHubTextFile(remotePath, text, message) {
  const repo = githubRepositoryApiPath();
  const filePath = githubContentApiPath(remotePath);
  const current = await readGitHubTextFile(remotePath);
  const body = {
    message,
    branch: PERSISTENCE_GITHUB_BRANCH,
    content: Buffer.from(String(text || ""), "utf8").toString("base64")
  };
  if (current.sha) body.sha = current.sha;
  const json = await githubApiJson("PUT", `/repos/${repo}/contents/${filePath}`, body);
  return {
    ok: true,
    path: remotePath,
    sha: json.content && json.content.sha ? json.content.sha : "",
    commit: json.commit && json.commit.sha ? json.commit.sha : ""
  };
}

function scheduleJobKey(job) {
  if (job && job.id) return `id:${job.id}`;
  if (job && job.reservationId) return `reservation:${job.reservationId}`;
  return "";
}

function scheduleJobUpdatedMs(job) {
  const candidates = [
    job && job.deletedAt,
    job && job.postedAt,
    job && job.failedAt,
    job && job.startedAt,
    job && job.createdAt,
    job && job.scheduledAt
  ];
  for (const value of candidates) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function mergeScheduleQueues(primary, secondary) {
  const map = new Map();
  for (const job of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!job || typeof job !== "object") continue;
    const key = scheduleJobKey(job);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || scheduleJobUpdatedMs(job) >= scheduleJobUpdatedMs(existing)) {
      map.set(key, job);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => Date.parse(a.scheduledAt || 0) - Date.parse(b.scheduledAt || 0));
}

async function readRemoteScheduleQueue() {
  if (!isRemoteSchedulePersistenceConfigured()) {
    return { ok: true, configured: false, exists: false, queue: [] };
  }
  const remote = await readGitHubTextFile(PERSISTENCE_SCHEDULE_PATH);
  if (!remote.exists) return { ok: true, configured: true, exists: false, queue: [] };
  const parsed = decryptPersistentJson(remote.text);
  const queue = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  return { ok: true, configured: true, exists: true, queue, count: queue.length, sha: remote.sha };
}

async function restoreScheduleQueueFromPersistentStore(reason = "startup") {
  if (!isRemoteSchedulePersistenceConfigured()) {
    return { ok: true, skipped: true, reason: "remote_schedule_not_configured" };
  }
  const remote = await readRemoteScheduleQueue();
  const localQueue = readScheduleQueue();
  if (!remote.exists) {
    if (localQueue.length) {
      const pushed = await syncScheduleQueueToGitHub(`${reason}: seed remote schedule`);
      return { ok: true, restored: false, seeded: true, localCount: localQueue.length, pushed };
    }
    return { ok: true, restored: false, exists: false, localCount: 0 };
  }

  const merged = mergeScheduleQueues(remote.queue, localQueue);
  writeScheduleQueue(merged);
  const result = {
    ok: true,
    restored: true,
    remoteCount: remote.queue.length,
    localCount: localQueue.length,
    mergedCount: merged.length,
    reason
  };
  if (merged.length !== remote.queue.length) {
    result.pushed = await syncScheduleQueueToGitHub(`${reason}: merge remote schedule`);
  }
  return result;
}

function isGitHubActionsSchedulerMode() {
  // RailwayデプロイではローカルスケジューラーでX投稿する（GitHub同期不可のため）
  if (process.env.RAILWAY_ENVIRONMENT !== undefined || process.env.RAILWAY_PROJECT_ID !== undefined) {
    return false;
  }
  // GitHub Actionsランナー上でのみtrue（VPSに.github/workflowsがあっても除外）
  if (process.env.GITHUB_ACTIONS !== "true") {
    return false;
  }
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
  if (isRemoteSchedulePersistenceConfigured()) {
    try {
      const queue = readScheduleQueue();
      const encrypted = encryptPersistentJson(queue, "x-scheduled-posts");
      const written = await writeGitHubTextFile(
        PERSISTENCE_SCHEDULE_PATH,
        encrypted,
        `chore: sync encrypted X schedule [skip ci]`
      );
      const result = {
        ok: true,
        pushed: true,
        backend: "github_contents_encrypted",
        encrypted: true,
        reason,
        count: queue.length,
        path: PERSISTENCE_SCHEDULE_PATH,
        commit: written.commit || "",
        at: new Date().toISOString()
      };
      log("SCHEDULE_REMOTE_SYNC_DONE", result);
      return result;
    } catch (error) {
      const result = { ok: false, backend: "github_contents_encrypted", error: gitScheduleSyncError(error), reason };
      log("SCHEDULE_REMOTE_SYNC_FAILED", result);
      return result;
    }
  }

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
  if (isRemoteSchedulePersistenceConfigured()) {
    try {
      const result = await restoreScheduleQueueFromPersistentStore(reason);
      log("SCHEDULE_REMOTE_RESTORE_DONE", result);
      return { ...result, backend: "github_contents_encrypted" };
    } catch (error) {
      const result = { ok: false, backend: "github_contents_encrypted", error: gitScheduleSyncError(error), reason };
      log("SCHEDULE_REMOTE_RESTORE_FAILED", result);
      return result;
    }
  }

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

function defaultImportDirectoryForCharacter(character) {
  const map = {
    "ヴェル13世": ["Umbrella Parade", "漫画", "01_ヴェル13世", "画像"],
    "カーラ・マンソン": ["Umbrella Parade", "漫画", "02_カーラ・マンソン", "画像"],
    "べるぼ": ["Umbrella Parade", "漫画", "03_べるぼ", "画像"],
    "アマモリ": ["Umbrella Parade", "漫画", "05_アマモリ", "画像"],
    "アマヨミ": ["Umbrella Parade", "漫画", "06_アマヨミ", "画像"]
  };
  const parts = map[String(character || "").trim()];
  if (!parts) return "";
  const folder = path.join(VAULT_ROOT, ...parts);
  return fs.existsSync(folder) ? folder : "";
}

function importDirectoryForCharacter(character) {
  const map = readImportDirectories();
  const folder = String(map[String(character || "")] || "").trim();
  return folder && fs.existsSync(folder) ? folder : defaultImportDirectoryForCharacter(character);
}

function mediaTypeFromImageName(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function staticAssetPath(assetPath) {
  const clean = decodeURIComponent(String(assetPath || ""))
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  const resolved = path.resolve(STATIC_ASSETS_DIR, clean);
  const root = path.resolve(STATIC_ASSETS_DIR);
  if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    const error = new Error("Asset path is not allowed.");
    error.status = 400;
    throw error;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const error = new Error("Asset not found.");
    error.status = 404;
    throw error;
  }
  return resolved;
}

function sendStaticAsset(res, assetPath) {
  try {
    const filePath = staticAssetPath(assetPath);
    res.writeHead(200, {
      "Content-Type": mediaTypeFromImageName(filePath),
      "Cache-Control": "public, max-age=86400"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendHtml(res, error.status || 500, "Asset error", "<h1>Asset could not be loaded.</h1>");
  }
}

function listImportImages(character) {
  const folder = importDirectoryForCharacter(character);
  if (!folder) return { folder: "", images: [] };
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  const images = [];
  const root = path.resolve(folder);
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !allowed.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = fs.statSync(fullPath);
      const relativeName = path.relative(root, fullPath).replace(/\\/g, "/");
      images.push({
        name: relativeName,
        displayName: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        modifiedMs: stat.mtimeMs,
        mediaType: mediaTypeFromImageName(entry.name)
      });
    }
  }
  images.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { folder, images };
}

function safeImportImagePath(character, imageName) {
  const folder = importDirectoryForCharacter(character);
  if (!folder) throw new Error("Import directory is not set.");
  const safeName = String(imageName || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!safeName || safeName.includes("..")) throw new Error("Image name is empty.");
  const resolvedFolder = path.resolve(folder);
  const fullPath = path.resolve(resolvedFolder, safeName);
  if (fullPath !== resolvedFolder && !fullPath.startsWith(`${resolvedFolder}${path.sep}`)) {
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

function normalizeXUsername(raw) {
  return String(raw || "").trim().replace(/^@+/, "").toLowerCase();
}

async function xUserForToken(token) {
  const json = await xApiJson("https://api.x.com/2/users/me", token, null, "GET");
  return json.data || null;
}

function assertExpectedXUsername(character, expectedUsername, user) {
  const expected = normalizeXUsername(expectedUsername);
  if (!expected) return;
  const actual = normalizeXUsername(user && user.username);
  if (!actual || actual !== expected) {
    const label = character || "selected character";
    throw new Error(`${label} expected @${expected}, but X authorized @${actual || "unknown"}. Switch the X account and try OAuth again.`);
  }
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
      expires_at: result.token.expires_at || result.expiresAt || null,
      scope: result.token.scope || "",
      token_type: result.token.token_type || "bearer"
    },
    user: result.user || null,
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
  const token = { ...record.token };
  if (!token.expires_at && record.expiresAt) token.expires_at = record.expiresAt;
  if (!token.expires_in && token.expires_at) {
    const remain = Math.floor((Date.parse(token.expires_at) - Date.now()) / 1000);
    if (Number.isFinite(remain) && remain > 0) token.expires_in = remain;
  }
  return {
    ok: true,
    ready: true,
    character: key,
    token,
    clientId: record.clientId || "",
    clientSecret: record.clientSecret || "",
    user: record.user || null,
    obtainedAt: record.obtainedAt || "",
    expiresAt: record.expiresAt || token.expires_at || ""
  };
}

function persistOAuthResult(result) {
  if (!result || !result.ok || !result.token || !result.token.access_token) return;
  const character = String(result.character || "");
  if (!character) return;
  const map = readOAuthTokenStore();
  const previous = map[character] || {};
  const previousToken = previous.token || {};
  const expiresAt = result.token.expires_at
    || result.expiresAt
    || (result.token.expires_in ? new Date(Date.now() + Math.max(60, Number(result.token.expires_in)) * 1000).toISOString() : "")
    || previous.expiresAt
    || previousToken.expires_at
    || "";
  map[character] = {
    character,
    token: {
      ...previousToken,
      ...result.token,
      refresh_token: result.token.refresh_token || previousToken.refresh_token || "",
      expires_at: expiresAt || undefined
    },
    clientId: result.clientId || previous.clientId || "",
    clientSecret: result.clientSecret || previous.clientSecret || "",
    user: result.user || previous.user || null,
    expiresAt,
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

function summarizeXErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  return {
    title: body.title || "",
    detail: body.detail || "",
    type: body.type || "",
    status: body.status || "",
    errors: Array.isArray(body.errors)
      ? body.errors.slice(0, 3).map((error) => ({
          title: error.title || "",
          detail: error.detail || "",
          message: error.message || ""
        }))
      : []
  };
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
  const baseBody = { text };
  if (mediaId) baseBody.media = { media_ids: [String(mediaId)] };
  const body = { ...baseBody };
  if (madeWithAi) body.made_with_ai = true;
  let json;
  try {
    json = await xApiJson("https://api.x.com/2/tweets", token, body);
  } catch (error) {
    if (madeWithAi && error.status === 403) {
      log("X_POST_RETRY_WITHOUT_AI_LABEL", {
        status: error.status,
        detail: summarizeXErrorBody(error.body)
      });
      json = await xApiJson("https://api.x.com/2/tweets", token, baseBody);
    } else {
      throw error;
    }
  }
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
        job.imageDataUrl = "";
        log("SCHEDULE_POST_DONE", { id: job.id, postId: post.id, url: post.url });
      } catch (error) {
        job.status = "failed";
        job.failedAt = new Date().toISOString();
        job.error = friendlyXErrorMessage(error.message || String(error));
        job.errorDetail = error.body || null;
        job.imageDataUrl = "";
        rememberError(error, { route: "schedule", scheduleId: job.id });
      }
      changed = true;
      writeScheduleQueue(queue);
    }

    if (changed) {
      writeScheduleQueue(queue);
      await syncScheduleQueueToGitHub("schedule tick");
    }
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

async function handlePostScheduleNow(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const scheduleJobId = String(payload.scheduleJobId || payload.id || "").trim();
  const reservationId = String(payload.reservationId || "").trim();
  const queue = readScheduleQueue();
  const job = queue.find((item) => {
    return (scheduleJobId && item.id === scheduleJobId)
      || (reservationId && item.reservationId === reservationId);
  });
  if (!job) throw new Error("投稿するX予約が見つかりませんでした。");
  if (job.status === "done") {
    sendJson(res, 200, { ok: true, alreadyDone: true, job: publicScheduleJob(job), gitPush: { ok: true, skipped: true, reason: "already_done" } });
    return;
  }
  if (job.status === "posting") throw new Error("このX予約は現在投稿処理中です。少し待ってから確認してください。");
  if (job.status === "deleted" || job.status === "cancelled") throw new Error("このX予約は削除済みのため投稿できません。");

  job.status = "posting";
  job.startedAt = new Date().toISOString();
  job.error = "";
  writeScheduleQueue(queue);

  try {
    log("SCHEDULE_POST_NOW_START", { id: job.id, reservationId: job.reservationId || "", character: job.character || "", title: job.title || "" });
    const { post, mediaId } = await postScheduledJob(job);
    job.status = "done";
    job.postedAt = new Date().toISOString();
    job.post = post;
    job.mediaId = mediaId;
    job.error = "";
    job.errorDetail = null;
    writeScheduleQueue(queue);
    const gitPush = await syncScheduleQueueToGitHub("schedule post now");
    log("SCHEDULE_POST_NOW_DONE", { id: job.id, postId: post.id, url: post.url });
    sendJson(res, 200, { ok: true, job: publicScheduleJob(job), gitPush });
  } catch (error) {
    job.status = "failed";
    job.failedAt = new Date().toISOString();
    job.error = friendlyXErrorMessage(error.message || String(error));
    job.errorDetail = error.body || null;
    writeScheduleQueue(queue);
    await syncScheduleQueueToGitHub("schedule post now failed").catch((syncError) => {
      log("SCHEDULE_POST_NOW_FAILED_SYNC_ERROR", { message: syncError.message || String(syncError) });
    });
    rememberError(error, { route: "/post-schedule-now", scheduleId: job.id });
    sendJson(res, error.status || 500, {
      ok: false,
      error: job.error,
      detail: error.body || null,
      job: publicScheduleJob(job)
    });
  }
}

async function handleScheduleX(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const character = String(payload.character || "");
  const stored = storedOAuthResult(character) || {};
  const storedToken = stored.token || {};
  const accessToken = String(storedToken.access_token || payload.token || "").trim();
  const refreshToken = String(storedToken.refresh_token || payload.refreshToken || "").trim();
  if (!accessToken && !refreshToken) throw new Error("Xトークンが保存されていません。Xトークン更新、またはXログインしてトークン取得を行ってください。");
  const token = accessToken ? validateToken(accessToken) : "";
  const text = String(payload.text || "").trim();
  const scheduledAtMs = Date.parse(payload.scheduledAt || "");
  if (!text) throw new Error("投稿文が空です。");
  if (!payload.imageDataUrl) throw new Error("画像データがありません。");
  if (!Number.isFinite(scheduledAtMs)) throw new Error("予約日時が正しくありません。");
  if (scheduledAtMs <= Date.now() + 30000) throw new Error("X予約投稿は30秒以上先の日時を指定してください。今すぐ投稿する場合は「今すぐXに投稿」を使ってください。");

  const job = {
    id: randomToken(12),
    reservationId: String(payload.reservationId || ""),
    character,
    title: String(payload.title || ""),
    scheduledAt: new Date(scheduledAtMs).toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
    token,
    refreshToken,
    clientId: String((stored && stored.clientId) || payload.clientId || ""),
    clientSecret: String((stored && stored.clientSecret) || payload.clientSecret || ""),
    text,
    imageDataUrl: String(payload.imageDataUrl || ""),
    filename: String(payload.filename || ""),
    madeWithAi: !!payload.madeWithAi,
    imageByteSize: payload.imageByteSize || null,
    compressed: !!payload.compressed
  };
  if (!stored.token && job.token) {
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
  }

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
  const authorizeHost = payload.authorizeHost === "x.com" ? "x.com" : "twitter.com";
  oauthSessions.set(state, {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    character: String(payload.character || ""),
    expectedUsername: String(payload.expectedUsername || ""),
    codeVerifier,
    createdAt: Date.now()
  });
  const authorizeUrl = new URL(`https://${authorizeHost}/i/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (payload.forceLogin === true) {
    authorizeUrl.searchParams.set("force_login", "true");
  }
  log("OAUTH_START", { character: payload.character || "", scopes, redirectUri, authorizeHost });
  sendJson(res, 200, { ok: true, authorizeUrl: authorizeUrl.toString(), state, redirectUri, scopes, authorizeHost });
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
    const user = await xUserForToken(token.access_token);
    assertExpectedXUsername(session.character, session.expectedUsername, user);
    const updated = rememberOAuthResult(state, {
      ok: true,
      ready: true,
      character: session.character,
      token,
      user,
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
  const character = String(payload.character || "").trim();
  const stored = storedOAuthResult(character) || {};
  const clientId = String(payload.clientId || stored.clientId || "").trim();
  const clientSecret = String(payload.clientSecret || stored.clientSecret || "").trim();
  const refreshToken = String(stored.token?.refresh_token || payload.refreshToken || "").trim();
  if (!clientId) throw new Error("X OAuth Client IDを入力してください。");
  if (!refreshToken) throw new Error("Refresh Tokenが保存されていません。もう一度Xログインで取得してください。");
  const token = await oauthTokenRequest({
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  }, clientId, clientSecret);
  const user = await xUserForToken(token.access_token);
  const updated = rememberOAuthResult("", {
    ok: true,
    ready: true,
    character,
    token,
    user,
    clientId,
    clientSecret,
    obtainedAt: new Date().toISOString()
  });
  const gitPush = updated ? await syncScheduleQueueToGitHub("oauth refresh token sync") : { ok: true, skipped: true, reason: "no_pending_schedule_token_updates" };
  log("OAUTH_TOKEN_REFRESHED", { hasRefreshToken: !!token.refresh_token });
  sendJson(res, 200, { ok: true, token, user, gitPush });
}

async function handleOAuthStore(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || "{}");
  const character = String(payload.character || "").trim();
  if (!character) throw new Error("Character is empty.");
  const stored = storedOAuthResult(character) || {};
  const accessToken = validateToken(payload.accessToken || payload.token || payload.access_token);
  const storedToken = stored.token || {};
  const token = {
    access_token: accessToken,
    refresh_token: String(payload.refreshToken || payload.refresh_token || storedToken.refresh_token || ""),
    expires_in: payload.expiresIn || payload.expires_in || storedToken.expires_in || null,
    expires_at: payload.expiresAt || payload.expires_at || storedToken.expires_at || stored.expiresAt || null,
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
  if (/403\s*Forbidden|<title>\s*403\s*Forbidden\s*<\/title>|XSERVER Inc\./i.test(text)) {
    return "WordPressサーバーから403 Forbiddenが返っています。XSERVERのWAF・国外IPアクセス制限・REST API制限などでオンライン投稿サーバーからのWordPress REST APIアクセスがブロックされている可能性があります。投稿は作成されていません。";
  }
  if (/rest_cannot_create|rest_cannot_edit|401|Unauthorized/i.test(text)) {
    return "WordPressの認証に失敗しました。ユーザー名とApplication Passwordを確認してください。";
  }
  if (/(Invalid parameter\(s\):\s*meta|swell_meta_|ssp_meta_|og_image|opengraph|not registered)/i.test(text)) {
    return "SWELL/OGPメタ設定の一部をWordPress REST APIが受け付けませんでした。投稿本体・認証とは別の警告です。";
  }
  if (/rest_invalid_param/i.test(text)) {
    return `WordPress REST APIが一部のパラメータを受け付けませんでした: ${text}`;
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

function clientStateAllowedKey(key) {
  const value = String(key || "");
  return /^umbrellaManga(ImageSet|ImagePatterns|SelectedImagePattern)_/.test(value)
    || /^umbrellaMangaSubCharacterSelection_/.test(value)
    || /^umbrellaMangaSnsTextSettings_/.test(value)
    || /^umbrellaMangaCustomCharacterPrompt_/.test(value)
    || /^umbrellaMangaXExpectedUsernameByCharacter_/.test(value)
    || /^umbrellaMangaScheduled(Date|Time)ByCharacter$/.test(value)
    || /^umbrellaManga(ImageDownloadName|ImageDownloadFolder)ByCharacter$/.test(value)
    || /^umbrellaManga(IdeaStock|Reservations|SeedIdeaStockImportedIds|ActiveIdeaId|ActiveCharacter|CurrentAiProvider|LastScheduledTime)$/.test(value)
    || /^aiModel_(openai|gemini|claude)$/.test(value)
    || /^customModel_(openai|gemini|claude)$/.test(value)
    || /^apiKey_(openai|gemini|claude)$/.test(value)
    || /^umbrellaMangaWp(SettingsByCharacter|SelectedCharacter)$/.test(value)
    || /^umbrellaMangaXOAuth(ClientId|ClientSecret)(ByCharacter_.+)?$/.test(value);
}

function privateClientStateKey(key) {
  const value = String(key || "");
  return /^apiKey_(openai|gemini|claude)$/.test(value)
    || /^umbrellaMangaWpSettingsByCharacter$/.test(value)
    || /^umbrellaMangaXOAuth(ClientId|ClientSecret)(ByCharacter_.+)?$/.test(value);
}

function clientStateSyncKey() {
  return envValue("CLIENT_STATE_SYNC_KEY", "CLIENT_SYNC_KEY", "UMBRELLA_CLIENT_SYNC_KEY");
}

function ensureClientStateAccess(req, key) {
  if (!privateClientStateKey(key)) return;
  const expected = clientStateSyncKey();
  if (!expected) {
    const error = new Error("秘密情報のクラウド同期にはRailway VariablesのCLIENT_STATE_SYNC_KEYが必要です。");
    error.status = 403;
    throw error;
  }
  const received = String(req.headers["x-umbrella-sync-key"] || "").trim();
  if (received !== expected) {
    const error = new Error("クラウド同期キーが違うか未入力です。");
    error.status = 403;
    throw error;
  }
}

function readClientState() {
  const state = readJsonFile(CLIENT_STATE_PATH, {});
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function writeClientState(state) {
  writeJsonFile(CLIENT_STATE_PATH, state && typeof state === "object" ? state : {});
}

function clientStateValue(entry) {
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")
    ? entry.value
    : entry;
}

async function handleGetClientState(req, res, requestUrl) {
  const key = String(requestUrl.searchParams.get("key") || "").trim();
  if (!clientStateAllowedKey(key)) throw new Error("この設定キーはオンライン保存できません。");
  ensureClientStateAccess(req, key);
  const state = readClientState();
  const has = Object.prototype.hasOwnProperty.call(state, key);
  sendJson(res, 200, { ok: true, key, has, value: has ? clientStateValue(state[key]) : null });
}

async function handleSaveClientState(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const key = String(payload.key || "").trim();
  if (!clientStateAllowedKey(key)) throw new Error("この設定キーはオンライン保存できません。");
  ensureClientStateAccess(req, key);
  const state = readClientState();
  if (payload.delete === true) {
    delete state[key];
  } else {
    state[key] = {
      value: payload.value ?? null,
      updatedAt: new Date().toISOString()
    };
  }
  writeClientState(state);
  sendJson(res, 200, { ok: true, key, deleted: payload.delete === true });
}

function publicRuntimeImage(image) {
  return {
    id: image.id || "",
    character: image.character || "",
    name: image.name || "",
    localPath: image.localPath || "",
    category: image.category || "オンライン保存画像",
    dataUrl: image.dataUrl || "",
    createdAt: image.createdAt || "",
    source: image.source || "railway"
  };
}

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function readSeedRuntimeImages() {
  const payload = readJsonFile(SEED_RUNTIME_IMAGES_PATH, { generatedAt: "", images: [] });
  const images = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload.images) ? payload.images : []);
  const dir = path.resolve(SEED_RUNTIME_IMAGES_DIR);
  return images
    .filter((item) => item && typeof item === "object" && item.file)
    .map((item) => {
      const filePath = path.resolve(dir, String(item.file || ""));
      if (!pathIsInside(dir, filePath) || !fs.existsSync(filePath)) return null;
      const name = String(item.name || path.basename(filePath));
      const mimeType = mediaTypeFromImageName(name || filePath);
      return {
        id: String(item.id || `seed_${path.basename(filePath, path.extname(filePath))}`),
        character: String(item.character || "").trim(),
        name,
        category: String(item.category || "オンライン初期画像").trim() || "オンライン初期画像",
        dataUrl: `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`,
        createdAt: item.createdAt || payload.generatedAt || "",
        source: "seed"
      };
    })
    .filter(Boolean);
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
    localPath: String(payload.localPath || payload.path || payload.name || "").trim(),
    category: String(payload.category || "オンライン保存画像").trim() || "オンライン保存画像",
    dataUrl,
    byteSize: media.buffer.length,
    createdAt: new Date().toISOString()
  };
}

async function handleListRuntimeImages(req, res, requestUrl) {
  const character = String(requestUrl.searchParams.get("character") || "").trim();
  const images = [...readSeedRuntimeImages(), ...readRuntimeImages()]
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

async function handleUpdateRuntimeImage(req, res) {
  const payload = JSON.parse(await readBody(req) || "{}");
  const id = String(payload.id || "").trim();
  const character = String(payload.character || "").trim();
  if (!id) throw new Error("画像IDがありません。");
  const images = readRuntimeImages();
  const idx = images.findIndex((img) => img.id === id && (!character || img.character === character));
  if (idx < 0) throw new Error("画像が見つかりません。");
  if (payload.category !== undefined) images[idx].category = String(payload.category).trim();
  writeRuntimeImages(images);
  sendJson(res, 200, { ok: true, image: publicRuntimeImage(images[idx]) });
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

  const model = String(payload.model || "gpt-image-1.5").trim();
  const outputFormat = String(payload.output_format || "png").trim() || "png";
  if (!files.length) {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: String(payload.size || "1024x1536"),
        quality: String(payload.quality || "auto"),
        output_format: outputFormat
      })
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
      const message = json.error?.message || json.message || json.detail || json.raw || `OpenAI image generation error: ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.body = json;
      error.requestId = requestId;
      throw error;
    }
    const first = json.data && json.data[0];
    if (!first) throw new Error("OpenAI image generation returned no image.");
    const dataUrl = first.b64_json
      ? `data:image/${outputFormat};base64,${first.b64_json}`
      : first.url || "";
    if (!dataUrl) throw new Error("OpenAI image generation returned no image data.");
    return { imageDataUrl: dataUrl, requestId, usedReferences: [] };
  }

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

function normalizeWordPressCategoryPayload(category) {
  if (typeof category === "string") {
    const parts = category.split("|").map((part) => part.trim());
    return { name: parts[0] || "", slug: parts[1] || "" };
  }
  return {
    name: String(category?.name || "").trim(),
    slug: String(category?.slug || "").trim()
  };
}

function wordpressCategoriesFromPayload(payload = {}) {
  const source = Array.isArray(payload.categories) && payload.categories.length
    ? payload.categories
    : [{ name: payload.categoryName || "4コマ漫画", slug: payload.categorySlug || "4-panel-comic" }];
  const seen = new Set();
  return source
    .map(normalizeWordPressCategoryPayload)
    .filter((category) => category.name)
    .filter((category) => {
      const key = `${category.name}::${category.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function ensureWordPressCategory(siteUrl, username, appPassword, name, slug = "") {
  const safeName = String(name || "").trim();
  const safeSlug = String(slug || "").trim();
  if (!safeName) throw new Error("WordPress category name is empty.");
  if (safeSlug) {
    const foundBySlug = await wordpressJson(siteUrl, username, appPassword, "/categories", {
      params: { slug: safeSlug, per_page: 100 }
    });
    if (Array.isArray(foundBySlug) && foundBySlug[0] && foundBySlug[0].id) return foundBySlug[0].id;
  }
  const foundByName = await wordpressJson(siteUrl, username, appPassword, "/categories", {
    params: { search: safeName, per_page: 100 }
  });
  const exact = Array.isArray(foundByName)
    ? foundByName.find((item) => String(item.name || "").trim().toLowerCase() === safeName.toLowerCase())
    : null;
  if (exact && exact.id) return exact.id;
  const body = { name: safeName };
  if (safeSlug) body.slug = safeSlug;
  const created = await wordpressJson(siteUrl, username, appPassword, "/categories", {
    method: "POST",
    body
  });
  if (!created.id) throw new Error("WordPressカテゴリーIDを取得できませんでした。");
  return created.id;
}

async function ensureWordPressCategories(siteUrl, username, appPassword, categories, preferredCategories = null) {
  const source = Array.isArray(preferredCategories) && preferredCategories.length ? preferredCategories : categories;
  const list = Array.isArray(source) && source.length
    ? source
    : [{ name: "4コマ漫画", slug: "4-panel-comic" }];
  const ids = [];
  for (const category of list) {
    const id = await ensureWordPressCategory(siteUrl, username, appPassword, category.name, category.slug);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) throw new Error("WordPress category IDs could not be resolved.");
  return ids;
}

function wordpressImageBlock(media, altText) {
  const id = Number(media.id);
  const src = escapeHtml(media.source_url || media.guid?.rendered || "");
  const alt = escapeHtml(altText || "");
  return `<!-- wp:image {"id":${id},"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt="${alt}" class="wp-image-${id}"/></figure>
<!-- /wp:image -->`;
}

function wordpressParagraphBlocks(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const html = escapeHtml(block).replace(/\r?\n/g, "<br>");
      return `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;
    })
    .join("\n\n");
}

function wordpressPostContent(media, altText = "", bodyText = "") {
  return [wordpressImageBlock(media, altText), wordpressParagraphBlocks(bodyText)]
    .filter(Boolean)
    .join("\n\n");
}

function wordpressMetaPayload(featuredMediaId, ogImageUrl, swell = {}, excerpt = "") {
  const description = String(swell.description || excerpt || "").trim();
  const payload = {
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
  if (description) {
    Object.assign(payload, {
      ssp_meta_description: description,
      ssp_meta_og_description: description,
      "_yoast_wpseo_metadesc": description,
      rank_math_description: description,
      aioseo_description: description,
      aioseo_og_description: description,
      og_description: description,
      twitter_description: description
    });
  }
  return payload;
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

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function wordpressExcerptValue(post) {
  const excerpt = post && post.excerpt;
  if (!excerpt) return "";
  if (typeof excerpt === "string") return stripHtml(excerpt);
  return stripHtml(excerpt.raw || excerpt.rendered || "");
}

async function readWordPressExcerpt(siteUrl, username, appPassword, postId) {
  const post = await wordpressJson(siteUrl, username, appPassword, `/posts/${postId}`, {
    params: { context: "edit" }
  });
  return wordpressExcerptValue(post);
}

async function updateWordPressExcerptXmlRpc(siteUrl, username, appPassword, postId, excerpt) {
  await wordpressXmlRpc(siteUrl, "wp.editPost", [
    1,
    String(username || "").trim(),
    normalizeApplicationPassword(appPassword),
    Number(postId),
    { post_excerpt: String(excerpt || "") }
  ]);
}

async function applyWordPressExcerpt(siteUrl, username, appPassword, postId, excerpt) {
  const wanted = String(excerpt || "").trim();
  if (!wanted) return { method: "skipped", excerpt: "" };
  let restError = null;
  try {
    await wordpressJson(siteUrl, username, appPassword, `/posts/${postId}`, {
      method: "POST",
      body: { excerpt: wanted }
    });
    const current = await readWordPressExcerpt(siteUrl, username, appPassword, postId);
    if (current === wanted) return { method: "rest", excerpt: current };
  } catch (error) {
    restError = error;
    log("WP_EXCERPT_REST_WARNING", { postId, message: error.message });
  }

  try {
    await updateWordPressExcerptXmlRpc(siteUrl, username, appPassword, postId, wanted);
    const current = await readWordPressExcerpt(siteUrl, username, appPassword, postId).catch(() => wanted);
    if (!current || current === wanted) return { method: "xmlrpc", excerpt: current || wanted };
    return { method: "xmlrpc-unverified", excerpt: current };
  } catch (error) {
    const combined = restError ? `${restError.message} / XML-RPC: ${error.message}` : error.message;
    const excerptError = new Error(combined);
    excerptError.restError = restError;
    excerptError.xmlRpcError = error;
    throw excerptError;
  }
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
  let user;
  try {
    user = await wordpressJson(siteUrl, username, appPassword, "/users/me", {
      params: { context: "edit" }
    });
  } catch (error) {
    if (!/context|rest_invalid_param|rest_forbidden_context/i.test(`${error.message || ""} ${error.status || ""} ${JSON.stringify(error.body || {})}`)) throw error;
    user = await wordpressJson(siteUrl, username, appPassword, "/users/me");
  }
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
  const bodyText = String(payload.bodyText || payload.postText || "").trim();
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

  const categoryIds = await ensureWordPressCategories(
    siteUrl,
    username,
    appPassword,
    payload.categoryName || "4コマ漫画",
    wordpressCategoriesFromPayload(payload)
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
    content: wordpressPostContent(mangaMedia, payload.altText || title, bodyText),
    excerpt,
    slug,
    status,
    categories: categoryIds,
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

  try {
    const excerptResult = await applyWordPressExcerpt(siteUrl, username, appPassword, post.id, excerpt);
    log("WP_EXCERPT_APPLIED", { postId: post.id, method: excerptResult.method });
  } catch (error) {
    warnings.push("WordPressの抜粋文を自動反映できませんでした。投稿本文とは別の警告です。");
    log("WP_EXCERPT_WARNING", { postId: post.id, message: error.message });
  }

  const metaPayload = wordpressMetaPayload(featuredMedia.id, payload.ogImageUrl || featuredImageUrl, payload.swell || {}, excerpt);
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
      excerpt,
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

  if (req.method === "GET" && requestUrl.pathname.startsWith("/assets/")) {
    sendStaticAsset(res, requestUrl.pathname.replace(/^\/assets\//, ""));
    return;
  }

  if (req.method === "GET" && ["/", "/tool", "/tool/"].includes(requestUrl.pathname)) {
    sendToolHtml(res);
    return;
  }

  if (req.method === "GET" && ["/vault", "/vault/"].includes(requestUrl.pathname)) {
    sendVaultBrowserHtml(res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/vault-list") {
    try {
      listVaultFolder(req, res, requestUrl);
    } catch (error) {
      rememberError(error, { route: "/vault-list" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Vault list error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/vault-file") {
    try {
      sendVaultFile(req, res, requestUrl);
    } catch (error) {
      rememberError(error, { route: "/vault-file" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Vault file error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/vault-create-folder") {
    try {
      ensureVaultAccess(req, requestUrl);
      const payload = JSON.parse(await readBody(req) || "{}");
      const folder = createVaultFolder(payload);
      sendJson(res, 200, { ok: true, folder });
    } catch (error) {
      rememberError(error, { route: "/vault-create-folder" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Vault folder create error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/vault-ensure-folder") {
    try {
      ensureVaultAccess(req, requestUrl);
      const payload = JSON.parse(await readBody(req) || "{}");
      const folder = ensureVaultFolder(payload);
      sendJson(res, 200, { ok: true, folder });
    } catch (error) {
      rememberError(error, { route: "/vault-ensure-folder" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Vault folder ensure error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/vault-upload-file") {
    try {
      ensureVaultAccess(req, requestUrl);
      const payload = JSON.parse(await readBody(req) || "{}");
      const file = uploadVaultFile(payload);
      sendJson(res, 200, { ok: true, file });
    } catch (error) {
      rememberError(error, { route: "/vault-upload-file" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Vault file upload error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/vault-delete") {
    try {
      ensureVaultAccess(req, requestUrl);
      const payload = JSON.parse(await readBody(req) || "{}");
      const deleted = deleteVaultEntry(payload);
      sendJson(res, 200, { ok: true, deleted });
    } catch (error) {
      rememberError(error, { route: "/vault-delete" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Vault delete error." });
    }
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
      dataDir: DATA_DIR,
      persistence: schedulePersistenceStatus()
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

  if (req.method === "POST" && requestUrl.pathname === "/runtime-images/update") {
    try {
      await handleUpdateRuntimeImage(req, res);
    } catch (error) {
      rememberError(error, { route: "/runtime-images/update" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Runtime image update error." });
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
    if (!result && !character && oauthLatestResults.size === 1) {
      result = Array.from(oauthLatestResults.values())[0];
    }
    if (!result && !character) result = oauthLatestResults.get("__latest__");
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

  if (req.method === "GET" && requestUrl.pathname === "/sync-key-status") {
    sendJson(res, 200, { ok: true, configured: !!clientStateSyncKey() });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/maintenance-status") {
    sendJson(res, 200, {
      ok: true,
      cleanup: readJsonFile(MANGA_IMAGE_CLEANUP_REPORT_PATH, null),
      retentionDays: Number(process.env.MANGA_IMAGE_RETENTION_DAYS || 14)
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/client-state") {
    try {
      await handleGetClientState(req, res, requestUrl);
    } catch (error) {
      rememberError(error, { route: "/client-state" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Client state read error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/client-state") {
    try {
      await handleSaveClientState(req, res);
    } catch (error) {
      rememberError(error, { route: "/client-state" });
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Client state save error." });
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

  if (req.method === "POST" && requestUrl.pathname === "/post-schedule-now") {
    try {
      await handlePostScheduleNow(req, res);
    } catch (error) {
      rememberError(error, { route: "/post-schedule-now" });
      sendJson(res, error.status || 500, {
        ok: false,
        error: error.message || "X予約の今すぐ投稿でエラーが起きました。",
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
      const tokenJob = {
        character: String(payload.character || ""),
        token: String(payload.token || ""),
        refreshToken: String(payload.refreshToken || ""),
        clientId: String(payload.clientId || ""),
        clientSecret: String(payload.clientSecret || "")
      };
      const token = await refreshTokenForScheduledJob(tokenJob);
      const text = String(payload.text || "").trim();

      if (!text) throw new Error("投稿文が空です。");
      if (!payload.imageDataUrl) throw new Error("画像データがありません。");

      log("POST_START", {
        character: payload.character || "",
        title: payload.title || "",
        textLength: text.length,
        imageByteSize: payload.imageByteSize || null,
        compressed: !!payload.compressed,
        madeWithAi: !!payload.madeWithAi,
        tokenRefreshed: token !== String(payload.token || "")
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

restoreScheduleQueueFromPersistentStore("server startup")
  .then((restore) => log("SCHEDULE_PERSISTENCE_STARTUP", restore))
  .catch((error) => rememberError(error, { route: "startup persistence restore" }))
  .finally(() => server.listen(PORT, HOST, () => {
  const displayUrl = PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
  log(`Umbrella Parade manga online server running at ${displayUrl}`);
  log("PERSISTENCE_STATUS", schedulePersistenceStatus());
  console.log("このウィンドウを閉じると投稿サーバーも停止します。");

  // GitHub Actions (.github/workflows) が存在する場合はローカルスケジューラーを無効化
  // → GitHub Actions 側だけが投稿を担当し、二重投稿を防ぐ
  const hasGitHubActions = !FORCE_LOCAL_SCHEDULER && isGitHubActionsSchedulerMode();
  if (hasGitHubActions) {
    log("ローカルスケジューラー無効（GitHub Actions モード）二重投稿防止のため、予約投稿はGitHub Actionsが担当します。");
    // GitHubから最新のスケジュールを取得してローカルを同期
    pullScheduleQueueFromGitHub("server startup");
  } else {
    setInterval(tickScheduleQueue, 30000);
    setTimeout(tickScheduleQueue, 2000);
    log("ローカルスケジューラー有効（スタンドアロンモード）");
  }
}));
