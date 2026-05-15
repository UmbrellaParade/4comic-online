// x-scheduler-runner.js
// GitHub Actions 用 X予約投稿ランナー
// 30分ごとに自動実行され、時刻が来た予約投稿をXに投稿します

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const SCHEDULE_PATH = path.join(DATA_DIR, "x-scheduled-posts.json");
const LOG_FILE = path.join(DATA_DIR, "x-scheduler-runner.log");
const FILE_RETRY_ATTEMPTS = Number(process.env.FILE_RETRY_ATTEMPTS || 10);
const FILE_RETRY_DELAY_MS = Number(process.env.FILE_RETRY_DELAY_MS || 180);

// ─── ログ ────────────────────────────────────────────────────────────────────

function log(tag, data = null) {
  const line = `[${new Date().toISOString()}] ${tag}${data ? " " + JSON.stringify(data) : ""}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch {}
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableFileError(error) {
  const code = error && error.code;
  const message = String((error && error.message) || "");
  return ["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(code)
    || /unknown error|resource busy|being used by another process|temporarily unavailable/i.test(message);
}

function withFileRetry(action, label, filePath) {
  let lastError = null;
  for (let attempt = 1; attempt <= FILE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return action();
    } catch (error) {
      lastError = error;
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
  throw lastError;
}

// ─── スケジューJSONの読み書き ───────────────────────────────────────────────

function readScheduleQueue() {
  try {
    if (!fs.existsSync(SCHEDULE_PATH)) return [];
    const raw = fs.readFileSync(SCHEDULE_PATH, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (e) {
    log("ERROR_READ_QUEUE", { message: e.message });
    return [];
  }
}

function writeScheduleQueue(queue) {
  const payload = JSON.stringify(Array.isArray(queue) ? queue : [], null, 2);
  withFileRetry(() => {
    fs.writeFileSync(SCHEDULE_PATH, payload, "utf8");
  }, "writeScheduleQueue", SCHEDULE_PATH);
}

// ─── ユーティリティ ──────────────────────────────────────────────────────────

function normalizeToken(raw) {
  return String(raw || "").trim().replace(/^Bearer\s+/i, "").replace(/[\r\n\t ]+/g, "");
}

function validateToken(raw) {
  const token = normalizeToken(raw);
  if (!token) throw new Error("X Access Tokenが空です。OAuthトークンを再取得してください。");
  return token;
}

function friendlyXErrorMessage(message) {
  const text = String(message || "");
  if (/Application-Only is forbidden/i.test(text)) {
    return "App-only Bearer Tokenが使われています。OAuth 2.0 User Contextのaccess_tokenが必要です。";
  }
  if (/CreditsDepleted/i.test(text) || /does not have any credits/i.test(text)) {
    return "X APIのクレジット残高がありません。Developer Portalで確認してください。";
  }
  return text;
}

function dataUrlToXMedia(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error("画像データがbase64形式ではありません。");
  return { mediaType: match[1], media: match[2] };
}

// ─── OAuth トークンリフレッシュ ──────────────────────────────────────────────

async function oauthTokenRequest(params, clientId, clientSecret) {
  const body = new URLSearchParams(params);
  if (!clientSecret) body.set("client_id", clientId);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }

  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!response.ok) {
    const message = json.error_description || json.detail || json.title || json.error || `OAuth error: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return json;
}

// トークンをリフレッシュしてアクセストークンを返す
// 戻り値: string (そのまま使える) or { access_token, refresh_token } (更新あり)
async function refreshTokenForJob(job) {
  const refreshToken = String(job.refreshToken || "").trim();
  const clientId = String(job.clientId || "").trim();
  const clientSecret = String(job.clientSecret || "").trim();

  // リフレッシュトークンがなければそのままアクセストークンを使う
  if (!refreshToken || !clientId) {
    return validateToken(job.token);
  }

  log("TOKEN_REFRESH_START", { character: job.character, id: job.id });
  const result = await oauthTokenRequest(
    { refresh_token: refreshToken, grant_type: "refresh_token" },
    clientId,
    clientSecret
  );

  return {
    access_token: validateToken(result.access_token),
    refresh_token: result.refresh_token || refreshToken
  };
}

// 同じキャラクターの全pendingジョブのトークンを一括更新（リフレッシュトークンの使い回しを防ぐ）
function propagateRefreshedTokens(queue, character, accessToken, refreshToken) {
  let count = 0;
  for (const job of queue) {
    if (String(job.character || "") !== character) continue;
    if (!["pending", "posting"].includes(job.status)) continue;
    job.token = accessToken;
    if (refreshToken) job.refreshToken = refreshToken;
    count++;
  }
  return count;
}

// ─── X API 呼び出し ──────────────────────────────────────────────────────────

async function xApiJson(url, token, body = null, method = "POST") {
  token = validateToken(token);
  const options = {
    method,
    headers: { "Authorization": `Bearer ${token}` }
  };
  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!response.ok) {
    const errors = Array.isArray(json.errors)
      ? json.errors.map(e => e.detail || e.title || e.message).filter(Boolean).join(" / ")
      : "";
    const rawMsg = json.detail || json.title || json.error?.message || errors || json.raw || `X API error: ${response.status}`;
    const error = new Error(friendlyXErrorMessage(rawMsg));
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
  if (!mediaId) throw new Error("Xへの画像アップロード結果からmedia_idを取得できませんでした。");
  return mediaId;
}

async function createXPost(token, text, mediaId, madeWithAi) {
  const body = { text };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };
  if (madeWithAi) body.made_with_ai = true;

  const json = await xApiJson("https://api.x.com/2/tweets", token, body);
  const postId = json.data && json.data.id;
  if (!postId) throw new Error("X投稿結果からPost IDを取得できませんでした。");
  return {
    id: postId,
    text: json.data.text || text,
    url: `https://x.com/i/web/status/${postId}`
  };
}

// ─── メイン処理 ──────────────────────────────────────────────────────────────

async function main() {
  log("SCHEDULER_START", { node: process.version });

  const queue = readScheduleQueue();
  const now = Date.now();

  const dueJobs = queue.filter(job => {
    if (job.status !== "pending") return false;
    const dueAt = Date.parse(job.scheduledAt || "");
    return Number.isFinite(dueAt) && dueAt <= now;
  });

  log("QUEUE_STATUS", {
    total: queue.length,
    pending: queue.filter(j => j.status === "pending").length,
    due: dueJobs.length
  });

  if (dueJobs.length === 0) {
    log("SCHEDULER_END", { result: "due_jobs_none" });
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const job of dueJobs) {
    log("JOB_START", {
      id: job.id,
      character: job.character,
      title: job.title,
      scheduledAt: job.scheduledAt
    });

    // 投稿中にマーク
    job.status = "posting";
    job.startedAt = new Date().toISOString();
    writeScheduleQueue(queue);

    try {
      // トークン取得（必要に応じてリフレッシュ）
      const tokenResult = await refreshTokenForJob(job);
      let accessToken;

      if (typeof tokenResult === "string") {
        // リフレッシュ不要（そのまま使用）
        accessToken = tokenResult;
      } else {
        // リフレッシュ済み → 全pending jobに伝播
        accessToken = tokenResult.access_token;
        job.token = accessToken;
        job.refreshToken = tokenResult.refresh_token;
        const propagated = propagateRefreshedTokens(
          queue, job.character, accessToken, tokenResult.refresh_token
        );
        log("TOKEN_PROPAGATED", { character: job.character, count: propagated });
      }

      // 画像アップロード
      const mediaId = await uploadImageToX(accessToken, job.imageDataUrl);
      log("IMAGE_UPLOADED", { id: job.id, mediaId });

      // Xに投稿
      const post = await createXPost(accessToken, job.text, mediaId, !!job.madeWithAi);

      job.status = "done";
      job.postedAt = new Date().toISOString();
      job.post = post;
      job.mediaId = mediaId;
      job.error = "";
      successCount++;
      log("JOB_DONE", { id: job.id, postId: post.id, url: post.url });

    } catch (error) {
      job.status = "failed";
      job.failedAt = new Date().toISOString();
      job.error = error.message || String(error);
      job.errorBody = error.body || null;
      failCount++;
      log("JOB_FAILED", { id: job.id, character: job.character, error: job.error });
    }

    writeScheduleQueue(queue);
  }

  log("SCHEDULER_END", { processed: dueJobs.length, success: successCount, failed: failCount });

  // 失敗があったら終了コード1（GitHub Actionsでエラー表示される）
  if (failCount > 0 && successCount === 0) {
    process.exit(1);
  }
}

main().catch(error => {
  log("FATAL", { message: error.message, stack: error.stack });
  process.exit(1);
});
