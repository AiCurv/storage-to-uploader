// Telegram webhook entrypoint. Vercel invokes this on every incoming message.
//
// Commands:
//   /start              - Welcome message + main menu
//   /upload <url>       - Upload a file URL (auto-asks which service)
//   /raw <url>          - Same as /upload (kept for compatibility)
//   /storage <url>      - Upload directly to storage.to (skip service picker)
//   /pixeldrain <url>   - Upload directly to pixeldrain (skip service picker)
//   /stream <url>       - Instant CDN Stream via Gcore (no download, returns streamable URL)
//   /service            - Show / change default service
//   /status             - Current settings (shows default service)
//   /rename <name>      - Set custom filename for next upload
//   /help               - Detailed help message
//   /ping               - Bot latency check
//   /about              - About the bot
//
// Any direct URL sent as text triggers the service picker (inline keyboard).
// Forwarded files (documents, videos, audio, photos) will be detected and prompted.

import { provisionStreamableUrl } from "./_gcore.js";

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

const SERVICES = {
  storageto:  { label: "📦 Storage.to", short: "storage.to",    emoji: "📦" },
  pixeldrain: { label: "🎬 PixelDrain", short: "pixeldrain",    emoji: "🎬" },
};

const WELCOME = [
  "📦 <b>StreamToBuffer Bot</b>",
  "",
  "Send me any download link and I'll either:",
  "  📦 <b>Upload</b> it to storage.to / pixeldrain (via GitHub Actions), or",
  "  🚀 <b>Stream</b> it instantly via Gcore CDN (no download, no upload — instant streamable URL)",
  "",
  "📝 <b>Commands:</b>",
  "/upload &lt;url&gt; — Upload link (asks which service)",
  "/storage &lt;url&gt; — Upload directly to storage.to",
  "/pixeldrain &lt;url&gt; — Upload directly to pixeldrain",
  "/stream &lt;url&gt; — 🚀 Instant CDN stream (Gcore)",
  "/service — Show / change default service",
  "/rename &lt;name&gt; — Set custom filename",
  "/status — Current settings",
  "/ping — Latency check",
  "/help — Detailed help",
  "",
  "💡 Works with ANY direct download link!",
  "📎 You can also forward files directly to me!",
].join("\n");

const HELP_MSG = [
  "📖 <b>StreamToBuffer Help</b>",
  "",
  "<b>Two ways to use a link:</b>",
  "",
  "🚀 <b>Instant CDN Stream</b> (NEW — recommended for video):",
  "• <b>/stream &lt;url&gt;</b> — returns an instant streamable URL via Gcore CDN",
  "• No download/upload — Gcore edge pulls from origin on-the-fly",
  "• Supports Range/seek (slice engine enabled)",
  "• Streams 12GB+ MKV/MP4 in VLC, Stremio, TV players",
  "• Works with pixeldrain, storage.to, any direct download link",
  "",
  "📦 <b>Upload services</b> (download + re-host):",
  "• <b>storage.to</b> — anonymous, files expire after some time, max 25GB",
  "• <b>pixeldrain</b> — requires account API key, files don't expire, max depends on plan",
  "",
  "<b>Supported sources:</b>",
  "• Any direct download link (mp4, mkv, zip, etc.)",
  "• Pixeldrain links (auto-converted to API link for download)",
  "• hub.whistle.lat, hub.latent.click links",
  "• Any URL that serves file bytes directly",
  "",
  "<b>Forwarded files:</b>",
  "• Forward a file to me and I'll ask if you want a download link",
  "• Supports documents, videos, audio, photos",
  "• Note: Telegram Bot API has a 20MB download limit for getFile",
  "",
  "<b>Commands:</b>",
  "/stream <url> — 🚀 Instant CDN stream (Gcore)",
  "/upload <url> — Upload a link (asks which service)",
  "/storage <url> — Upload directly to storage.to",
  "/pixeldrain <url> — Upload directly to pixeldrain",
  "/service — Show / change default service",
  "/raw <url> — Same as /upload",
  "/rename <name> — Override filename for next upload",
  "/status — Current settings",
  "/ping — Check bot responsiveness",
  "/about — About this bot",
].join("\n");

const ABOUT_MSG = [
  "🤖 <b>StreamToBuffer Bot</b>",
  "",
  "Two modes: instant CDN streaming via Gcore, or download+re-host via GitHub Actions.",
  "",
  "🔧 <b>Tech Stack:</b>",
  "• Gcore CDN (instant streaming — slice engine, Range support, 200+ PoPs)",
  "• GitHub Actions (download + upload for storage.to / pixeldrain)",
  "• storage.to (file hosting, up to 25GB, anonymous)",
  "• pixeldrain (file hosting, persistent, account-based)",
  "• Vercel (bot webhook handler + Gcore API orchestrator)",
  "",
  "⚡ <b>Features:</b>",
  "• 🚀 Instant CDN stream — no download, no upload, no storage used",
  "• Direct download passthrough — no conversion",
  "• Choose service per upload (inline keyboard)",
  "• Files up to 25GB supported (storage.to)",
  "• Works with any direct download link",
  "• Forwarded Telegram files supported",
].join("\n");

// Per-user settings (in-memory, resets on redeploy)
const userSettings = {};

// Pending uploads: shortId → { url, filename, chatId, ts }
// Used to bridge long URLs through Telegram's 64-byte callback_data limit
const pendingUploads = new Map();

function getUserSettings(chatId) {
  const key = String(chatId);
  if (!userSettings[key]) {
    userSettings[key] = {
      nextFilename: null,
      defaultService: "storageto", // default
    };
  }
  return userSettings[key];
}

function makePendingId() {
  return [...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("");
}

function createPendingUpload(url, filename, chatId) {
  // Cleanup old pendings (>10 min)
  const now = Date.now();
  for (const [id, p] of pendingUploads) {
    if (now - p.ts > 10 * 60 * 1000) pendingUploads.delete(id);
  }
  const id = makePendingId();
  pendingUploads.set(id, { url, filename, chatId, ts: now });
  return id;
}

function takePendingUpload(id) {
  const p = pendingUploads.get(id);
  if (!p) return null;
  pendingUploads.delete(id);
  return p;
}

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    }),
  });
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🚀 Stream" }, { text: "🔗 Upload link" }, { text: "🔄 Service" }],
        [{ text: "/status" }, { text: "/help" }, { text: "/ping" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

// Convert known "share page" URLs into direct download URLs (for SOURCE side)
function normalizeSourceUrl(text) {
  let url;
  try { url = new URL(text.trim()); } catch { return null; }
  const host = url.host.toLowerCase();
  const path = url.pathname;

  if (host === "pixeldrain.com" || host.endsWith(".pixeldrain.com")) {
    const m1 = path.match(/^\/u\/([A-Za-z0-9]+)/);
    if (m1) return `https://pixeldrain.com/api/file/${m1[1]}`;
    const m2 = path.match(/^\/d\/([A-Za-z0-9]+)/);
    if (m2) return `https://pixeldrain.com/api/file/${m2[1]}`;
  }

  return null; // null means no rewrite needed
}

function looksLikeUrl(text) {
  return /^https?:\/\/\S+$/i.test(text);
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "file.bin";
    return decodeURIComponent(last).slice(0, 200);
  } catch {
    return "file.bin";
  }
}

function isValidService(s) {
  return s === "storageto" || s === "pixeldrain";
}

async function triggerUpload(sourceUrl, originalName, chatId, service) {
  const repo = process.env.GITHUB_REPO || "AiCurv/storage-to-uploader";
  const [owner, name] = repo.split("/");
  const settings = getUserSettings(chatId);

  const finalName = settings.nextFilename || originalName;
  settings.nextFilename = null;

  const finalService = isValidService(service) ? service : settings.defaultService || "storageto";

  const payload = {
    event_type: "telegram-upload",
    client_payload: {
      source_url: sourceUrl,
      filename: finalName,
      chat_id: String(chatId),
      service: finalService,
    },
  };

  logDispatch("triggerUpload", payload);

  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`dispatch ${res.status}: ${text.slice(0, 200)}`);
  }
  return { finalService, finalName };
}

// Lightweight logger for visibility in Vercel logs
function logDispatch(stage, data) {
  try {
    const cp = data.client_payload || {};
    console.log(`[webhook:${stage}] chat_id=${cp.chat_id} service=${cp.service} filename=${cp.filename} url_len=${(cp.source_url || "").length}`);
  } catch {}
}

// ─── Instant CDN Stream (Gcore) ──────────────────────────────────────────────

async function handleStreamRequest(chatId, sourceUrl, opts = {}) {
  const { skipInitialMessage = false } = opts;
  if (!looksLikeUrl(sourceUrl)) {
    await sendMessage(chatId, "❌ Provide a valid URL.\nExample: <code>/stream https://pixeldrain.com/api/file/abc</code>", mainMenu());
    return;
  }
  // Normalize PixelDrain /u/<id> and /d/<id> to /api/file/<id> so the origin serves raw bytes.
  // NOTE: /l/<id> (file LIST) is NOT normalized — _gcore.js analyzeSourceUrl() will catch it
  // and return kind="pixeldrain_list" with a friendly explanation.
  const normalized = normalizeSourceUrl(sourceUrl) || sourceUrl;
  if (!skipInitialMessage) {
    await sendMessage(chatId,
      "🚀 <b>Instant CDN Stream</b>\n" +
      "⏳ Provisioning Gcore edge route... (2-5s)",
      mainMenu());
  }
  try {
    const r = await provisionStreamableUrl(normalized);

    // ── Branch on result kind ──
    if (r.kind === "self_loop") {
      // User fed the bot's OWN CDN URL back to /stream → would create infinite origin loop
      await sendMessage(chatId,
        "⚠️ <b>That URL is already a Gcore CDN stream URL</b>\n\n" +
        `The link you sent lives on <code>${r.cname}</code> — that's <b>my own CDN edge</b>. ` +
        "Feeding it back through /stream would make the CDN fetch from itself in an infinite loop.\n\n" +
        "<b>Just open the URL directly</b> in VLC / Stremio / your TV — it's already accelerated.\n\n" +
        "If the URL doesn't work, the most likely cause is:\n" +
        "• A newer /stream call repointed the CDN at a different origin (each /stream invalidates the previous one)\n" +
        "• The original source URL has expired (presigned URLs die after ~8 hours)\n\n" +
        "💡 <b>Fix:</b> send the ORIGINAL source link (pixeldrain / direct download) to /stream again.",
        mainMenu());
      return;
    }

    if (r.kind === "expired") {
      // Presigned URL (R2 / S3 / Azure / GCS) already expired
      await sendMessage(chatId,
        "⏰ <b>Source URL has expired</b>\n\n" +
        `The link you sent is a presigned URL (R2/S3/Azure/GCS) that expired at <code>${r.expiredAt}</code>.\n\n` +
        "Gcore CDN can't fetch a fresh copy from an expired origin URL — the origin returns 403 Forbidden.\n\n" +
        "<b>Fix:</b> get a fresh presigned URL from wherever you got this one, then send it to /stream again.\n\n" +
        "💡 Tip: presigned URLs typically live 1-8 hours. /stream them as soon as you get them.",
        mainMenu());
      return;
    }

    if (r.kind === "pixeldrain_list") {
      // Pixeldrain /l/<id> returns HTML, not raw bytes
      await sendMessage(chatId,
        "📋 <b>That's a Pixeldrain file list, not a single file</b>\n\n" +
        `Pixeldrain list <code>${r.listId}</code> is an HTML gallery page — Gcore CDN can't stream HTML as video.\n\n` +
        "<b>How to stream from a list:</b>\n" +
        `1. Open <a href="https://pixeldrain.com/l/${r.listId}">https://pixeldrain.com/l/${r.listId}</a> in your browser\n` +
        "2. Click the file you want\n" +
        "3. Copy the URL from the address bar (it'll look like <code>pixeldrain.com/u/XXXXXX</code>)\n" +
        "4. Send that URL to /stream — I'll give you back a streamable CDN link",
        mainMenu());
      return;
    }

    if (r.kind === "passthrough") {
      // URL is already on a fast CDN (R2/S3/CloudFront/Akamai/Bunny/etc.) — no GCore benefit
      const lines = [
        "✅ <b>Already on a fast CDN — no acceleration needed</b>",
        "",
        `🔗 <a href="${escapeHtml(r.originalUrl)}">${escapeHtml(r.originalUrl)}</a>`,
        "",
        `📡 Source host: <code>${r.host}</code>`,
        "",
        "This URL is already served from a major CDN (Cloudflare R2 / AWS S3+CloudFront / Akamai / Bunny / Fastly / etc.).",
        "Running it through Gcore would add an extra hop with no speed benefit — and could break if the source URL is a presigned URL that expires.",
        "",
        "<b>Just open the URL directly</b> in VLC / Stremio / your TV — it's already fast.",
      ];
      if (r.presignedExpiresAt) {
        const expiryDate = new Date(r.presignedExpiresAt);
        const hoursLeft = Math.max(0, (expiryDate.getTime() - Date.now()) / 3600000);
        lines.push("");
        lines.push(`⏰ <b>Source URL expires in ~${hoursLeft.toFixed(1)} hours</b> (at ${expiryDate.toISOString()})`);
        lines.push("After that, this URL returns 403 Forbidden — get a fresh presigned URL from your source.");
      } else {
        lines.push("");
        lines.push("💡 If the URL doesn't work, the cause is usually:");
        lines.push("• It's a presigned URL that's expired (check for <code>X-Amz-Date</code> in the URL)");
        lines.push("• The origin requires auth/cookies that the CDN can't forward");
        lines.push("• Your player doesn't follow redirects");
      }
      await sendMessage(chatId, lines.join("\n"), mainMenu());
      return;
    }

    // ── Default: kind === "stream" — normal Gcore CDN stream ──
    const lines = [
      "🚀 <b>Stream ready!</b>",
      "",
      `🔗 <a href="${r.streamUrl}">${r.streamUrl}</a>`,
      "",
      `📡 Origin: <code>${r.originHost}</code>`,
      `🌐 Gcore edge: <code>${r.cname}</code>`,
      `🔒 SSL: Let's Encrypt (auto-renewed)`,
      `🆔 Resource: <code>${r.resourceId}</code> · cache purged`,
      r.groupCreated ? `✨ Origin group created (<code>${r.groupId}</code>)` : `♻️ Reused origin group (<code>${r.groupId}</code>)`,
    ];
    if (r.presignedExpiresAt) {
      // Warn the user the source URL is a presigned URL that will expire
      const expiryDate = new Date(r.presignedExpiresAt);
      const hoursLeft = Math.max(0, (expiryDate.getTime() - Date.now()) / 3600000);
      lines.push("");
      lines.push(`⏰ <b>Source URL expires in ~${hoursLeft.toFixed(1)} hours</b> (at ${expiryDate.toISOString()})`);
      lines.push("After that, Gcore CDN can't fetch fresh bytes — re-run /stream with a new presigned URL.");
    }
    lines.push("");
    lines.push("<b>How to use:</b>");
    lines.push("• Paste the URL into VLC / Stremio / your TV's media player");
    lines.push("• Seek works (slice engine enabled)");
    lines.push("• Gcore pulls from origin on-the-fly — no download, no upload");
    lines.push("• First byte may take ~2-5s (cache warm-up), then full speed");
    lines.push("");
    lines.push("⚠️ <b>Important:</b> each new /stream call repoints this CDN resource at the latest origin.");
    lines.push("This URL works until you /stream a different link, or until the source URL expires.");
    await sendMessage(chatId, lines.join("\n"), mainMenu());
  } catch (err) {
    console.error("[stream] error:", err.message, err.body || "");
    const msg = err.message || "unknown error";
    let hint = "";
    if (msg.includes("GCORE_")) {
      hint = "\n\n💡 Tip: ask the bot admin to set GCORE_API_TOKEN, GCORE_CDN_RESOURCE_ID, GCORE_CDN_CNAME in Vercel env.";
    } else if (msg.includes("CDN service is stopped") || msg.includes("permission")) {
      hint = "\n\n💡 Tip: Gcore CDN service must be activated in the portal first (https://portal.gcore.com/cdn/resources/list).";
    }
    await sendMessage(chatId, `❌ <b>Stream failed:</b>\n<code>${escapeHtml(msg).slice(0, 400)}</code>${hint}`, mainMenu());
  }
}

// Minimal HTML-escape for user-supplied strings shown in Telegram HTML messages.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function extractUrlFromText(text) {
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
}

function stripBotSuffix(text) {
  return text.replace(/@\w+/g, "");
}

// ─── Extract file info from a Telegram message ───────────────

function extractFileInfo(message) {
  // Priority: document > video > audio > animation > voice > photo
  if (message.document) {
    return {
      file_id: message.document.file_id,
      file_name: message.document.file_name || "document",
      file_size: message.document.file_size || 0,
      mime_type: message.document.mime_type || "application/octet-stream",
      type: "document",
    };
  }
  if (message.video) {
    return {
      file_id: message.video.file_id,
      file_name: message.video.file_name || `video_${message.video.file_id.slice(0,8)}.mp4`,
      file_size: message.video.file_size || 0,
      mime_type: message.video.mime_type || "video/mp4",
      type: "video",
    };
  }
  if (message.audio) {
    return {
      file_id: message.audio.file_id,
      file_name: message.audio.file_name || `audio_${message.audio.file_id.slice(0,8)}.mp3`,
      file_size: message.audio.file_size || 0,
      mime_type: message.audio.mime_type || "audio/mpeg",
      type: "audio",
    };
  }
  if (message.animation) {
    return {
      file_id: message.animation.file_id,
      file_name: message.animation.file_name || `animation.mp4`,
      file_size: message.animation.file_size || 0,
      mime_type: message.animation.mime_type || "video/mp4",
      type: "animation",
    };
  }
  if (message.voice) {
    return {
      file_id: message.voice.file_id,
      file_name: `voice_${message.voice.file_id.slice(0,8)}.ogg`,
      file_size: message.voice.file_size || 0,
      mime_type: message.voice.mime_type || "audio/ogg",
      type: "voice",
    };
  }
  if (message.photo) {
    // photo is an array of sizes, pick the largest
    const photos = message.photo;
    const largest = photos[photos.length - 1];
    return {
      file_id: largest.file_id,
      file_name: `photo_${largest.file_id.slice(0,8)}.jpg`,
      file_size: largest.file_size || 0,
      mime_type: "image/jpeg",
      type: "photo",
    };
  }
  return null;
}

function formatFileSize(bytes) {
  if (!bytes) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i > 0 ? 1 : 0)} ${u[i]}`;
}

// ─── Service picker keyboard ───────────────────────────────────
// Returns inline keyboard with all options. Uses pending-id so callback_data stays short.
function servicePickerKeyboard(pendingId, currentService) {
  const storagetoLabel  = currentService === "storageto"  ? "✅ 📦 Storage.to" : "📦 Storage.to";
  const pixeldrainLabel = currentService === "pixeldrain" ? "✅ 🎬 PixelDrain" : "🎬 PixelDrain";
  return {
    inline_keyboard: [
      [
        { text: "🚀 Stream (instant CDN)", callback_data: `pick_stream:${pendingId}` },
      ],
      [
        { text: storagetoLabel,  callback_data: `pick_svc:${pendingId}:storageto` },
        { text: pixeldrainLabel, callback_data: `pick_svc:${pendingId}:pixeldrain` },
      ],
      [
        { text: "❌ Cancel", callback_data: `cancel_pending:${pendingId}` },
      ],
    ],
  };
}

// Picker for /service command (no pending upload, just setting default)
function defaultServicePickerKeyboard(currentService) {
  const storagetoLabel  = currentService === "storageto"  ? "✅ 📦 Storage.to" : "📦 Storage.to";
  const pixeldrainLabel = currentService === "pixeldrain" ? "✅ 🎬 PixelDrain" : "🎬 PixelDrain";
  return {
    inline_keyboard: [
      [
        { text: storagetoLabel,  callback_data: `set_def:storageto` },
        { text: pixeldrainLabel, callback_data: `set_def:pixeldrain` },
      ],
    ],
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, webhook: "ready" });
  if (req.method !== "POST") return res.status(405).end();

  let update;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "bad json" });
  }

  // ─── Handle callback queries (inline keyboard button presses) ───
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || "";
    const chatId = String(cb.message?.chat?.id || cb.from?.id || "");

    // Stream button picked — instant Gcore CDN stream, no download
    if (data.startsWith("pick_stream:")) {
      const [, pendingId] = data.split(":");
      const pending = takePendingUpload(pendingId);
      if (!pending) {
        await answerCallbackQuery(cb.id, "⚠️ Session expired. Please send the URL again.");
        return res.status(200).json({ ok: true });
      }
      // IMPORTANT: Telegram callback queries must be answered quickly (the user sees a spinner
      // on the button). We answer the callback immediately, send a "provisioning" message so
      // the user has visual feedback, then return HTTP 200 to Telegram right away.
      // handleStreamRequest runs in the background — Vercel keeps the function alive as long as
      // there are pending promises (maxDuration=60s). Final stream URL is delivered as a
      // separate Telegram message when Gcore provisioning completes (~2-3s).
      await answerCallbackQuery(cb.id, "🚀 Provisioning Gcore stream...");
      await sendMessage(
        chatId,
        "🚀 <b>Instant CDN Stream</b>\n" +
        "⏳ Provisioning Gcore edge route... (5-10s)",
        mainMenu()
      );
      // Fire-and-forget: do NOT await — return HTTP 200 to Telegram immediately.
      handleStreamRequest(chatId, pending.url, { skipInitialMessage: true })
        .catch(err => {
          console.error("[stream callback bg] error:", err.message, err.body || "");
          sendMessage(chatId, `❌ <b>Stream failed:</b>\n<code>${(err.message || "unknown error").slice(0, 400)}</code>`, mainMenu())
            .catch(() => {});
        });
      return res.status(200).json({ ok: true });
    }

    // Service picked for an upload (pending id present)
    if (data.startsWith("pick_svc:")) {
      const [, pendingId, service] = data.split(":");
      const pending = takePendingUpload(pendingId);
      if (!pending) {
        await answerCallbackQuery(cb.id, "⚠️ Session expired. Please send the URL again.");
        return res.status(200).json({ ok: true });
      }
      if (!isValidService(service)) {
        await answerCallbackQuery(cb.id, "Invalid service.");
        return res.status(200).json({ ok: true });
      }
      const svcInfo = SERVICES[service];
      // Same non-blocking pattern as pick_stream: answer callback + send "queued" message,
      // then return HTTP 200 immediately. triggerUpload runs in the background.
      await answerCallbackQuery(cb.id, `Uploading to ${svcInfo.short}...`);
      await sendMessage(
        chatId,
        `⏬ <b>Uploading to ${svcInfo.label}</b>\n` +
        `🔄 Queuing dispatch to GitHub Actions...\n` +
        `⏳ I'll message you when done!`,
        mainMenu()
      );
      // Fire-and-forget: do NOT await — return HTTP 200 to Telegram immediately.
      (async () => {
        try {
          const { finalName } = await triggerUpload(pending.url, pending.filename, chatId, service);
          await sendMessage(
            chatId,
            `📦 <b>Upload dispatched</b>\n` +
            `<code>${finalName}</code>\n` +
            `🔄 Downloading → Uploading...\n` +
            `⏳ I'll message you when done!`,
            mainMenu()
          );
        } catch (err) {
          await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
        }
      })();
      return res.status(200).json({ ok: true });
    }

    // Cancel pending upload
    if (data.startsWith("cancel_pending:")) {
      const [, pendingId] = data.split(":");
      pendingUploads.delete(pendingId);
      await answerCallbackQuery(cb.id, "Cancelled");
      await sendMessage(chatId, "❌ Upload cancelled.", mainMenu());
      return res.status(200).json({ ok: true });
    }

    // Set default service (from /service command)
    if (data.startsWith("set_def:")) {
      const [, service] = data.split(":");
      if (!isValidService(service)) {
        await answerCallbackQuery(cb.id, "Invalid service.");
        return res.status(200).json({ ok: true });
      }
      const settings = getUserSettings(chatId);
      settings.defaultService = service;
      const svcInfo = SERVICES[service];
      await answerCallbackQuery(cb.id, `Default service: ${svcInfo.short}`);
      await sendMessage(
        chatId,
        `✅ <b>Default service set to ${svcInfo.label}</b>\n\n` +
        `URLs you send will now upload to ${svcInfo.short} by default.\n` +
        `You can still override per-upload via the picker.`,
        mainMenu()
      );
      return res.status(200).json({ ok: true });
    }

    // Original forwarded-file confirmation flow
    if (data.startsWith("upload_file:")) {
      // User confirmed they want to upload a forwarded file
      // Format: upload_file:<service>:<encoded_tgfile_url>:<encoded_filename>
      // OR legacy: upload_file:<encoded_tgfile_url>:<encoded_filename>
      const parts = data.split(":");
      // parts[0] = "upload_file"
      let service, fileSourceUrl, fileName;
      if (parts.length >= 4 && (parts[1] === "storageto" || parts[1] === "pixeldrain")) {
        service = parts[1];
        fileSourceUrl = decodeURIComponent(parts[2]);
        fileName = decodeURIComponent(parts.slice(3).join(":"));
      } else {
        // Legacy: no service in callback, use default
        service = getUserSettings(chatId).defaultService || "storageto";
        fileSourceUrl = decodeURIComponent(parts[1]);
        fileName = decodeURIComponent(parts.slice(2).join(":"));
      }

      await answerCallbackQuery(cb.id, `Uploading to ${SERVICES[service].short}...`);
      await sendMessage(
        chatId,
        `⏬ <b>Uploading to ${SERVICES[service].label}</b>\n` +
        `🔄 Queuing dispatch to GitHub Actions...\n` +
        `⏳ I'll message you when done!`,
        mainMenu()
      );
      // Fire-and-forget: do NOT await — return HTTP 200 to Telegram immediately.
      (async () => {
        try {
          const { finalName } = await triggerUpload(fileSourceUrl, fileName, chatId, service);
          await sendMessage(
            chatId,
            `📦 <b>Upload dispatched</b>\n` +
            `<code>${finalName}</code>\n` +
            `🔄 Downloading → Uploading...\n` +
            `⏳ I'll message you when done!`,
            mainMenu()
          );
        } catch (err) {
          await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
        }
      })();
      return res.status(200).json({ ok: true });
    }

    // Forwarded-file: pick service first
    if (data.startsWith("pick_svc_file:")) {
      // Format: pick_svc_file:<service>:<encoded_tgfile_url>:<encoded_filename>
      const parts = data.split(":");
      const service = parts[1];
      const fileSourceUrl = decodeURIComponent(parts[2]);
      const fileName = decodeURIComponent(parts.slice(3).join(":"));
      if (!isValidService(service)) {
        await answerCallbackQuery(cb.id, "Invalid service.");
        return res.status(200).json({ ok: true });
      }
      await answerCallbackQuery(cb.id, `Uploading to ${SERVICES[service].short}...`);
      await sendMessage(
        chatId,
        `⏬ <b>Uploading to ${SERVICES[service].label}</b>\n` +
        `🔄 Queuing dispatch to GitHub Actions...\n` +
        `⏳ I'll message you when done!`,
        mainMenu()
      );
      // Fire-and-forget: do NOT await — return HTTP 200 to Telegram immediately.
      (async () => {
        try {
          const { finalName } = await triggerUpload(fileSourceUrl, fileName, chatId, service);
          await sendMessage(
            chatId,
            `📦 <b>Upload dispatched</b>\n` +
            `<code>${finalName}</code>\n` +
            `⏳ I'll message you when done!`,
            mainMenu()
          );
        } catch (err) {
          await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
        }
      })();
      return res.status(200).json({ ok: true });
    }

    if (data === "cancel_upload") {
      await answerCallbackQuery(cb.id, "Cancelled");
      await sendMessage(chatId, "❌ Upload cancelled.", mainMenu());
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  const message = update.message || update.edited_message;
  if (!message) {
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      if (chat.type === "channel" || chat.type === "supergroup") {
        const allowedId = String(process.env.TELEGRAM_ALLOWED_ID || "");
        if (allowedId) {
          await sendMessage(allowedId, `📢 Bot added to <b>${chat.title || "channel"}</b>\nChannel ID: <code>${chat.id}</code>`);
        }
      }
    }
    return res.status(200).json({ ok: true, ignored: "non-message" });
  }

  const chatId = message.chat.id;
  const allowed = String(process.env.TELEGRAM_ALLOWED_ID || "");
  if (allowed && String(chatId) !== allowed) {
    return res.status(200).json({ ok: true, ignored: "unauthorized" });
  }

  const text = (message.text || "").trim();

  // ─── Check for forwarded files FIRST ───
  const fileInfo = extractFileInfo(message);
  if (fileInfo && !text.startsWith("/")) {
    // A file was forwarded/shared — prompt user with BOTH service picker and confirm
    const tgFileUrl = `tgfile:${fileInfo.file_id}:${fileInfo.file_name}`;
    const encodedUrl = encodeURIComponent(tgFileUrl);
    const encodedName = encodeURIComponent(fileInfo.file_name);
    const sizeStr = formatFileSize(fileInfo.file_size);
    const settings = getUserSettings(chatId);
    const cur = settings.defaultService || "storageto";

    const storagetoLabel  = cur === "storageto"  ? "✅ 📦 Storage.to" : "📦 Storage.to";
    const pixeldrainLabel = cur === "pixeldrain" ? "✅ 🎬 PixelDrain" : "🎬 PixelDrain";

    await sendMessage(chatId,
      `📎 <b>File detected!</b>\n\n` +
      `Name: <code>${fileInfo.file_name}</code>\n` +
      `Size: ${sizeStr}\n` +
      `Type: ${fileInfo.type}\n\n` +
      `Pick a service to upload to:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: storagetoLabel,  callback_data: `pick_svc_file:storageto:${encodedUrl}:${encodedName}` },
              { text: pixeldrainLabel, callback_data: `pick_svc_file:pixeldrain:${encodedUrl}:${encodedName}` },
            ],
            [
              { text: "❌ Cancel", callback_data: "cancel_upload" },
            ],
          ],
        },
      }
    );
    return res.status(200).json({ ok: true });
  }

  if (!text) return res.status(200).json({ ok: true, ignored: "empty" });

  const cleanText = stripBotSuffix(text);

  // ─── Command: /start ───
  if (cleanText === "/start") {
    await sendMessage(chatId, WELCOME, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /help ───
  if (cleanText === "/help") {
    await sendMessage(chatId, HELP_MSG, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /about ───
  if (cleanText === "/about") {
    await sendMessage(chatId, ABOUT_MSG, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /ping ───
  if (cleanText === "/ping") {
    await sendMessage(chatId, `🏓 Pong! Bot is alive.\nServer time: ${new Date().toISOString()}`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /service (no args) — show current + picker ───
  if (cleanText === "/service" || cleanText === "/service" ) {
    const settings = getUserSettings(chatId);
    const cur = settings.defaultService || "storageto";
    await sendMessage(
      chatId,
      `🔄 <b>Default Service</b>\n\n` +
      `Current: ${SERVICES[cur].label}\n\n` +
      `Pick a new default:`,
      { reply_markup: defaultServicePickerKeyboard(cur) }
    );
    return res.status(200).json({ ok: true });
  }

  // Persistent keyboard button "🔄 Service"
  if (text === "🔄 Service") {
    const settings = getUserSettings(chatId);
    const cur = settings.defaultService || "storageto";
    await sendMessage(
      chatId,
      `🔄 <b>Default Service</b>\n\n` +
      `Current: ${SERVICES[cur].label}\n\n` +
      `Pick a new default:`,
      { reply_markup: defaultServicePickerKeyboard(cur) }
    );
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /service <name> ───
  const serviceMatch = cleanText.match(/^\/service\s+(\S+)/);
  if (serviceMatch) {
    const arg = serviceMatch[1].toLowerCase();
    let svc = null;
    if (arg === "storageto" || arg === "storage.to" || arg === "storage_to" || arg === "storage") svc = "storageto";
    if (arg === "pixeldrain" || arg === "pixel" || arg === "pd") svc = "pixeldrain";
    if (!svc) {
      await sendMessage(chatId, "❌ Unknown service. Use <code>/service storageto</code> or <code>/service pixeldrain</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const settings = getUserSettings(chatId);
    settings.defaultService = svc;
    await sendMessage(chatId, `✅ Default service set to <b>${SERVICES[svc].label}</b>`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /status ───
  if (cleanText === "/status") {
    const settings = getUserSettings(chatId);
    const nextName = settings.nextFilename ? `✏️ ${settings.nextFilename}` : "➖ Default (from URL)";
    const cur = settings.defaultService || "storageto";
    await sendMessage(chatId,
      `📊 <b>Current Settings</b>\n\n` +
      `Default service: ${SERVICES[cur].label}\n` +
      `Next filename: ${nextName}\n\n` +
      `💡 Send a URL to upload!`,
      mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /rename <name> ───
  if (cleanText.startsWith("/rename ")) {
    const customName = cleanText.replace(/^\/rename\s+/, "").trim();
    if (!customName) {
      await sendMessage(chatId, "❌ Provide a filename after /rename\nExample: <code>/rename my_video.mp4</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const settings = getUserSettings(chatId);
    settings.nextFilename = customName;
    await sendMessage(chatId, `✏️ Next upload will be named: <code>${customName}</code>`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Helper: kick off upload flow for a URL ───
  // If forceService is provided, skip the picker and upload directly to that service.
  async function handleUrlUpload(urlPart, forceService) {
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Provide a valid URL.\nExample: <code>/upload https://example.com/file.mkv</code>", mainMenu());
      return;
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);

    if (forceService && isValidService(forceService)) {
      try {
        const { finalName, finalService } = await triggerUpload(sourceUrl, filename, chatId, forceService);
        await sendMessage(
          chatId,
          `⏬ <b>Uploading to ${SERVICES[finalService].label}</b>\n` +
          `📦 <code>${finalName}</code>\n` +
          `🔄 Downloading → Uploading...\n` +
          `⏳ I'll message you when done!`,
          mainMenu()
        );
      } catch (err) {
        await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
      }
      return;
    }

    // Show service picker (pending-id based for short callback_data)
    const settings = getUserSettings(chatId);
    const cur = settings.defaultService || "storageto";
    const pendingId = createPendingUpload(sourceUrl, filename, chatId);
    await sendMessage(
      chatId,
      `🔗 <b>URL received</b>\n` +
      `📦 <code>${filename}</code>\n\n` +
      `Pick a service to upload to:`,
      { reply_markup: servicePickerKeyboard(pendingId, cur) }
    );
  }

  // ─── Command: /upload <url> ─── (shows picker)
  if (cleanText.startsWith("/upload ")) {
    const urlPart = cleanText.replace(/^\/upload\s+/, "").trim();
    await handleUrlUpload(urlPart, null);
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /storage <url> ─── (direct to storage.to, no picker)
  if (cleanText.startsWith("/storage ")) {
    const urlPart = cleanText.replace(/^\/storage\s+/, "").trim();
    await handleUrlUpload(urlPart, "storageto");
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /pixeldrain <url> ─── (direct to pixeldrain, no picker)
  if (cleanText.startsWith("/pixeldrain ")) {
    const urlPart = cleanText.replace(/^\/pixeldrain\s+/, "").trim();
    await handleUrlUpload(urlPart, "pixeldrain");
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /raw <url> ─── (kept for compatibility, same as /upload)
  if (cleanText.startsWith("/raw ")) {
    const urlPart = cleanText.replace(/^\/raw\s+/, "").trim();
    await handleUrlUpload(urlPart, null);
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /stream <url> ─── (instant Gcore CDN stream, no download)
  if (cleanText.startsWith("/stream ")) {
    const urlPart = cleanText.replace(/^\/stream\s+/, "").trim();
    await handleStreamRequest(chatId, urlPart);
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /stream (no args) ─── show help
  if (cleanText === "/stream") {
    await sendMessage(
      chatId,
      "🚀 <b>Instant CDN Stream</b>\n\n" +
      "Usage: <code>/stream &lt;url&gt;</code>\n\n" +
      "<b>What works:</b>\n" +
      "✅ Pixeldrain single file — <code>/stream https://pixeldrain.com/u/abc</code> (best — files never expire)\n" +
      "✅ Any direct download link (raw bytes + Range support)\n" +
      "⚠️ R2/S3/CloudFront/Akamai/etc. — already fast CDNs, I'll just return the original URL\n" +
      "⚠️ Presigned URLs (X-Amz-* params) — work, but die after 1-8 hours\n\n" +
      "<b>What doesn't work:</b>\n" +
      "❌ Pixeldrain file lists (<code>/l/&lt;id&gt;</code>) — they're HTML pages, not raw bytes\n" +
      "❌ The bot's own CDN URL fed back to /stream — would create an infinite loop\n" +
      "❌ Links requiring login / cookies / auth headers\n\n" +
      "I'll give you back a fast Gcore CDN URL you can stream in VLC / Stremio / TV.\n" +
      "No download, no upload — Gcore edge pulls from origin on-the-fly.",
      mainMenu()
    );
    return res.status(200).json({ ok: true });
  }

  // ─── Menu button: "🚀 Stream" ───
  if (text === "🚀 Stream") {
    await sendMessage(
      chatId,
      "🚀 <b>Instant CDN Stream</b>\n\n" +
      "Paste any video download link and I'll give you back a fast Gcore CDN URL you can stream in VLC / TV.\n\n" +
      "<b>Or use the command directly:</b>\n" +
      "<code>/stream https://pixeldrain.com/api/file/abc</code>\n\n" +
      "💡 No download, no upload — Gcore edge pulls from origin on-the-fly. Seek works.",
      mainMenu()
    );
    return res.status(200).json({ ok: true });
  }

  // ─── Menu button: "🔗 Upload link" ───
  if (text === "🔗 Upload link") {
    await sendMessage(
      chatId,
      "📎 Paste your download link below, or use:\n" +
      "<code>/stream URL</code> — 🚀 instant CDN stream (recommended for video)\n" +
      "<code>/upload URL</code> — pick service via inline button\n" +
      "<code>/storage URL</code> — upload to storage.to directly\n" +
      "<code>/pixeldrain URL</code> — upload to pixeldrain directly\n" +
      "<code>/rename name.mp4</code> — custom filename\n" +
      "<code>/service</code> — set default service",
      mainMenu()
    );
    return res.status(200).json({ ok: true });
  }

  // ─── Unknown commands ───
  if (text.startsWith("/")) {
    await sendMessage(chatId, "❓ Unknown command. Try /help for available commands.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Auto-detect URL in message → show service picker ───
  const detectedUrl = extractUrlFromText(text);
  if (detectedUrl) {
    await handleUrlUpload(detectedUrl, null);
    return res.status(200).json({ ok: true });
  }

  // ─── Non-URL text ───
  await sendMessage(chatId, "📎 Send a download URL and I'll ask which service to upload to.\n\nType /help for more info.", mainMenu());
  return res.status(200).json({ ok: true });
}
