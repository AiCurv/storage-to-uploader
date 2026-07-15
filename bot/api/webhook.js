// Telegram webhook entrypoint. Vercel invokes this on every incoming message.
//
// v8.3 architecture (per user spec 2026-07-15):
//   - ONLY PixelDrain as upload service (file.kiwi + storage.to removed)
//   - ONLY Gcore CDN as streaming layer (no /stream command — consolidated into post-upload buttons)
//   - Single consolidated message on upload completion (no cascade of intermediate messages)
//   - Inline buttons for: Open / Stream / Copy URL  (single file)
//                         Copy M3U / Stream All / Download All  (multi-part)
//   - /pixeldrain <url> and plain-URL messages both dispatch silently after a single
//     "📥 Download link added to queue. Processing..." message
//   - Stream button lazily constructs a Gcore CDN URL on click (answers callback
//     query in <1s, then sends the stream URL as a new message)
//   - Multi-part M3U uses Gcore CDN URLs (https://{GCORE_CDN_CNAME}/api/file/{id})
//     for ALL parts. The CDN resource's origin is PERMANENTLY set to pixeldrain.com
//     so every /api/file/{id} request routes through GCore edge with caching +
//     IP rate limit bypass. No origin repointing needed per request.
//   - Previous v8.2 assumption ("GCore can only point at one origin at a time →
//     M3U must use PixelDrain raw URLs") was WRONG. The user explicitly verified
//     GCore supports path-based routing for multiple parts via a single resource.
//
// Commands:
//   /start              - Welcome message + main menu
//   /pixeldrain <url>   - Upload to PixelDrain (auto-splits >10GB)
//   /rename <name>      - Set custom filename for next upload
//   /status             - Current settings
//   /ping               - Bot latency check
//   /help               - Detailed help message
//   /about              - About the bot
//
// Any direct URL sent as text triggers upload to PixelDrain (no picker).
// Forwarded files (documents, videos, audio, photos) are also uploaded.

import { provisionInstantStream, repointToPixeldrain, buildGcoreStreamUrl, extractPixeldrainId } from "./_gcore.js";

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

// v8.4: /start reply now includes INLINE BUTTONS for all secondary actions.
// Per user spec: "only start one global command should auto-execute, others
// should come on my inline". So /start is the single global command, and it
// opens an inline button menu. No other command appears in the slash-menu
// autocomplete. Users can still type /pixeldrain, /rename etc. manually if
// they know them, but the primary UX is: /start → tap a button.
const WELCOME = [
  "📦 <b>StreamToBuffer Bot</b>",
  "",
  "Tap a button below, or just send me any download link.",
  "",
  "📦 <b>Upload</b> — Send a link, then tap [Upload] to start",
  "▶️ <b>Stream</b> — Gcore CDN streaming (button appears after upload)",
  "✏️ <b>Rename</b> — Set custom filename for next upload",
  "",
  "💡 Works with ANY direct download link (R2 / S3 / presigned / pixeldrain / etc.)",
  "📎 You can also forward files directly to me!",
].join("\n");

// Inline keyboard for the /start main menu.
// callback_data must be ≤ 64 bytes.
function startMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "menu:status" },
        { text: "📖 Help", callback_data: "menu:help" },
      ],
      [
        { text: "ℹ️ About", callback_data: "menu:about" },
        { text: "🏓 Ping", callback_data: "menu:ping" },
      ],
      [
        { text: "✏️ Rename next upload", callback_data: "menu:rename" },
      ],
    ],
  };
}

// Inline keyboard for confirming an upload OR instant stream. Sent as a reply
// to the user's URL message, so the callback handler can read the URL from
// callback_query.message.reply_to_message.text.
// v8.5: 3 options — [🚀 GCore Stream] [📦 Upload to PixelDrain] [❌ Cancel]
function confirmUploadKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🚀 GCore Stream", callback_data: "gcore_stream:yes" },
        { text: "📦 Upload to PixelDrain", callback_data: "confirm_upload:yes" },
      ],
      [
        { text: "❌ Cancel", callback_data: "confirm_upload:no" },
      ],
    ],
  };
}

const HELP_MSG = [
  "📖 <b>StreamToBuffer Help</b>",
  "",
  "<b>How to use:</b>",
  "• Send any direct download link as a message",
  "• Or use <code>/pixeldrain &lt;url&gt;</code>",
  "• I'll download it via GitHub Actions, upload to PixelDrain, and reply with one message containing:",
  "  - Direct download link",
  "  - Stream button (Gcore CDN — instant, no download)",
  "  - Copy button",
  "",
  "<b>File size handling:</b>",
  "• &lt; 10 GB → single PixelDrain file",
  "• ≥ 10 GB → auto-split into chunks, each uploaded separately, M3U playlist attached",
  "",
  "<b>Supported sources:</b>",
  "• Any direct download link (mp4, mkv, zip, etc.)",
  "• Pixeldrain links (auto-converted to API link for download)",
  "• R2 / S3 / CloudFront presigned URLs (while still valid)",
  "• Any URL that serves file bytes directly",
  "",
  "<b>Forwarded files:</b>",
  "• Forward a file to me and I'll upload it to PixelDrain",
  "• Note: Telegram Bot API has a 20MB download limit for getFile",
  "",
  "<b>Commands:</b>",
  "/pixeldrain <url> — Upload to PixelDrain (auto-splits >10GB)",
  "/rename <name> — Override filename for next upload",
  "/status — Current settings",
  "/ping — Check bot responsiveness",
  "/about — About this bot",
  "/help — This help message",
].join("\n");

const ABOUT_MSG = [
  "🤖 <b>StreamToBuffer Bot</b>",
  "",
  "Uploads any file URL to PixelDrain via GitHub Actions, with on-demand Gcore CDN streaming.",
  "",
  "🔧 <b>Tech Stack:</b>",
  "• PixelDrain (file hosting, persistent, max 10GB/file, auto-splits larger)",
  "• Gcore CDN (instant streaming — slice engine, Range support, 200+ PoPs)",
  "• GitHub Actions (download + upload + ffmpeg stream-copy split)",
  "• Vercel (bot webhook handler + Gcore API orchestrator)",
  "",
  "⚡ <b>Features:</b>",
  "• Direct download passthrough — no conversion",
  "• Auto-splitting for pixeldrain (files >10GB split with ffmpeg stream-copy)",
  "• On-demand Gcore CDN stream (button-powered, no separate command)",
  "• Multi-part M3U playlist for split files",
  "• Works with any direct download link",
  "• Forwarded Telegram files supported",
].join("\n");

// Per-user settings (in-memory, resets on redeploy)
const userSettings = {};

function getUserSettings(chatId) {
  const key = String(chatId);
  if (!userSettings[key]) {
    userSettings[key] = {
      nextFilename: null,
    };
  }
  return userSettings[key];
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

async function answerCallbackQuery(callbackQueryId, text = "", opts = {}) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      ...opts,
    }),
  });
}

// v8.4: Removed persistent keyboard (mainMenu). Per user spec, the only
// global command is /start; everything else is inline buttons. A persistent
// keyboard would re-introduce the "tap a button → auto-execute" behavior the
// user explicitly rejected.
function mainMenu() {
  return {};
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

async function triggerUpload(sourceUrl, originalName, chatId) {
  const repo = process.env.GITHUB_REPO || "AiCurv/storage-to-uploader";
  const [owner, name] = repo.split("/");
  const settings = getUserSettings(chatId);

  const finalName = settings.nextFilename || originalName;
  settings.nextFilename = null;

  const payload = {
    event_type: "telegram-upload",
    client_payload: {
      source_url: sourceUrl,
      filename: finalName,
      chat_id: String(chatId),
      service: "pixeldrain", // v8.2: only service
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
  return { finalName };
}

function logDispatch(stage, data) {
  try {
    const cp = data.client_payload || {};
    console.log(`[webhook:${stage}] chat_id=${cp.chat_id} service=${cp.service} filename=${cp.filename} url_len=${(cp.source_url || "").length}`);
  } catch {}
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
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i > 0 ? 1 : 0)} ${u[i]}`;
}

// ─── On-demand Gcore stream URL construction (button-powered) ────
//
// v8.5: Two stream paths:
//   1. INSTANT stream (user taps [🚀 GCore Stream] on a pasted URL):
//      - For non-pixeldrain URLs: repoint CDN origin to the URL's host, return
//        https://cdn.streambot.freeddns.org{path}?{query}
//      - For pixeldrain URLs: no repointing, return /parts/{id}
//   2. POST-UPLOAD stream (user taps [▶️ Stream] on an upload-complete message):
//      - File is already on pixeldrain, origin is already pixeldrain.com
//      - Just return /parts/{id}

async function provisionAndSendStreamUrl(chatId, sourceUrl, label, callbackQueryId) {
  try {
    const r = await provisionInstantStream(sourceUrl);
    if (r.kind === "stream") {
      const repointNote = r.repointed
        ? `\n\n🔧 <b>CDN repointed to ${escapeHtml(r.host)}</b> — edge cache warming up (2-5s)`
        : "";
      const lines = [
        `▶️ <b>Gcore Stream Ready</b>${label ? ` — ${escapeHtml(label)}` : ""}`,
        "",
        `🔗 <a href="${r.streamUrl}">${r.streamUrl}</a>`,
        "",
        "📱 <b>How to use:</b>",
        "• Paste into VLC / Stremio / TV media player",
        "• Pause / resume / seek all work",
        "• First byte may take ~2-5s (cache warm-up)",
      ];
      if (r.repointed) {
        lines.push("");
        lines.push(`✅ <b>Instant stream</b> — no download, no upload`);
        lines.push(`🌐 Source: <code>${escapeHtml(r.host)}</code>`);
      }
      lines.push("");
      lines.push("✅ <b>Multi-part friendly:</b> each part has its own URL on the CDN edge.");
      await sendMessage(chatId, lines.join("\n"), mainMenu());
      return;
    }
    if (r.kind === "self_loop") {
      await sendMessage(chatId,
        `⚠️ <b>Already a Gcore CDN URL</b>\n\nThis link is already on my CDN edge. Just open it directly.`,
        mainMenu());
      return;
    }
    if (r.kind === "pixeldrain_list") {
      await sendMessage(chatId,
        `📋 <b>PixelDrain list — not a single file</b>\n\nOpen the list, click a file, copy its /u/<id> URL and try again.\n\nFallback:\n${sourceUrl}`,
        mainMenu());
      return;
    }
    await sendMessage(chatId,
      `⚠️ Could not provision Gcore stream. Direct link:\n${sourceUrl}`,
      mainMenu());
  } catch (err) {
    console.error("[stream] error:", err.message, err.body || "");
    await sendMessage(chatId,
      `⚠️ <b>Gcore stream failed</b> — showing direct link as fallback:\n\n` +
      `<code>${escapeHtml(sourceUrl)}</code>\n\n` +
      `<code>${escapeHtml(err.message || "unknown error").slice(0, 200)}</code>`,
      mainMenu());
  }
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

    // ── Button: Copy direct URL (single file) ──
    // Format: copy:<pixeldrain_id>
    // v8.5: Includes BOTH PixelDrain AND GCore URLs
    if (data.startsWith("copy:")) {
      const pixeldrainId = data.slice(5);
      const directUrl = `https://pixeldrain.com/u/${pixeldrainId}`;
      const rawUrl = `https://pixeldrain.com/api/file/${pixeldrainId}`;
      const gcoreUrl = buildGcoreStreamUrl(pixeldrainId);
      await answerCallbackQuery(cb.id, "📋 URLs ready below 👇");
      await sendMessage(chatId,
        `📋 <b>Copy these URLs:</b>\n\n` +
        `🌐 <b>PixelDrain view:</b>\n<code>${directUrl}</code>\n\n` +
        `⬇️ <b>PixelDrain raw:</b>\n<code>${rawUrl}</code>\n\n` +
        `🚀 <b>GCore stream:</b>\n<code>${gcoreUrl}</code>\n\n` +
        `<i>Long-press any URL → Copy</i>`,
        mainMenu());
      return res.status(200).json({ ok: true });
    }

    // ── Button: Open in browser (single file) ──
    // Format: open:<pixeldrain_id>
    if (data.startsWith("open:")) {
      const pixeldrainId = data.slice(5);
      const directUrl = `https://pixeldrain.com/u/${pixeldrainId}`;
      await answerCallbackQuery(cb.id, "📂 Opening...");
      await sendMessage(chatId,
        `📂 <b>Open in browser:</b>\n\n<a href="${directUrl}">${directUrl}</a>`,
        mainMenu());
      return res.status(200).json({ ok: true });
    }

    // ── Button: Stream single file via Gcore ──
    // Format: stream:<pixeldrain_id>
    if (data.startsWith("stream:")) {
      const pixeldrainId = data.slice(7);
      const rawUrl = `https://pixeldrain.com/api/file/${pixeldrainId}`;
      // CRITICAL: answer callback query IMMEDIATELY to clear the button spinner
      await answerCallbackQuery(cb.id, "⏳ Provisioning Gcore stream...");
      // Send a "provisioning" message so the user has visual feedback
      await sendMessage(chatId,
        "▶️ <b>Gcore Stream</b>\n⏳ Provisioning CDN edge route... (2-5s)",
        mainMenu());
      // Fire-and-forget: do NOT await — return HTTP 200 to Telegram immediately.
      // Vercel keeps the function alive (maxDuration=60s) while the background
      // promise resolves. Final stream URL is delivered as a new message.
      provisionAndSendStreamUrl(chatId, rawUrl, "", cb.id)
        .catch(err => {
          console.error("[stream callback bg] error:", err.message);
          sendMessage(chatId, `❌ <b>Stream failed:</b>\n<code>${escapeHtml(err.message || "").slice(0, 200)}</code>`, mainMenu())
            .catch(() => {});
        });
      return res.status(200).json({ ok: true });
    }

    // ── Button: Stream a specific part (multi-part) via Gcore ──
    // Format: stream_part:<partIndex>:<pixeldrain_id>
    if (data.startsWith("stream_part:")) {
      const parts = data.split(":");
      const partIndex = parts[1];
      const pixeldrainId = parts[2];
      const rawUrl = `https://pixeldrain.com/api/file/${pixeldrainId}`;
      await answerCallbackQuery(cb.id, `⏳ Provisioning Part ${partIndex}...`);
      await sendMessage(chatId,
        `▶️ <b>Gcore Stream — Part ${partIndex}</b>\n⏳ Provisioning CDN edge route... (2-5s)`,
        mainMenu());
      provisionAndSendStreamUrl(chatId, rawUrl, `Part ${partIndex}`, cb.id)
        .catch(err => {
          console.error("[stream_part callback bg] error:", err.message);
          sendMessage(chatId, `❌ <b>Stream failed:</b>\n<code>${escapeHtml(err.message || "").slice(0, 200)}</code>`, mainMenu())
            .catch(() => {});
        });
      return res.status(200).json({ ok: true });
    }

    // ── Button: Download All (multi-part) ──
    // Format: download_all:<num_parts>
    // We recover the pixeldrain IDs from the original upload-complete message text
    // (not from callback_data, which would overflow the 64-byte limit for >5 parts).
    if (data.startsWith("download_all:")) {
      const numParts = parseInt(data.split(":")[1], 10);
      const msgText = cb.message?.text || cb.message?.caption || "";
      const ids = extractPixeldrainIdsFromMessage(msgText, numParts);
      if (ids.length === 0) {
        await answerCallbackQuery(cb.id, "⚠️ Could not recover parts");
        await sendMessage(chatId,
          `⚠️ Could not recover part URLs. Please scroll up to the original upload-complete message for the links.`,
          mainMenu());
        return res.status(200).json({ ok: true });
      }
      await answerCallbackQuery(cb.id, `📋 ${ids.length} URLs ready below 👇`);
      const lines = [`📋 <b>Download All — ${ids.length} parts</b>`, ``];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        lines.push(`<b>Part ${i + 1}/${ids.length}:</b>`);
        lines.push(`🌐 <code>https://pixeldrain.com/u/${id}</code>`);
        lines.push(`⬇️ <code>https://pixeldrain.com/api/file/${id}</code>`);
        lines.push(``);
      }
      lines.push(`<i>Long-press any URL → Copy</i>`);
      await sendMessage(chatId, lines.join("\n"), mainMenu());
      return res.status(200).json({ ok: true });
    }

    // ── Button: Stream All (multi-part) ──
    // Format: stream_all:<num_parts>
    // v8.3: Since the CDN origin is PERMANENTLY pixeldrain.com and each part has
    // its own /api/file/{id} URL on the CDN edge, we can stream ALL parts
    // concurrently — no repointing conflict. Send all stream URLs in one message.
    if (data.startsWith("stream_all:")) {
      const numParts = parseInt(data.split(":")[1], 10);
      await answerCallbackQuery(cb.id, "▶️ Stream URLs ready below 👇");
      const msgText = cb.message?.text || cb.message?.caption || "";
      const ids = extractPixeldrainIdsFromMessage(msgText, numParts);
      if (ids.length === 0) {
        await sendMessage(chatId,
          `⚠️ <b>Could not recover part IDs</b>\n\nThe original message with parts list is needed to stream. Please scroll up and tap a part's individual link.`,
          mainMenu());
        return res.status(200).json({ ok: true });
      }
      // Build a single message with all GCore stream URLs
      const lines = [`▶️ <b>Gcore Stream URLs — ${ids.length} parts</b>`, ``];
      for (let i = 0; i < ids.length; i++) {
        const streamUrl = buildGcoreStreamUrl(ids[i]);
        lines.push(`<b>Part ${i + 1}/${ids.length}:</b>`);
        lines.push(`<a href="${streamUrl}">${streamUrl}</a>`);
        lines.push(``);
      }
      lines.push(`📱 <b>How to use:</b>`);
      lines.push(`• Paste each URL into VLC / Stremio / TV media player`);
      lines.push(`• Each part streams independently — play them in order`);
      lines.push(`• First byte may take ~2-5s (cache warm-up)`);
      lines.push(``);
      lines.push(`<i>Long-press any URL → Copy</i>`);
      await sendMessage(chatId, lines.join("\n"), mainMenu());
      return res.status(200).json({ ok: true });
    }

    // ── Button: Copy M3U (multi-part) ──
    // Format: copy_m3u:<num_parts>
    // Recover part IDs from the original message and rebuild the M3U inline.
    if (data.startsWith("copy_m3u:")) {
      const numParts = parseInt(data.split(":")[1], 10);
      const msgText = cb.message?.text || cb.message?.caption || "";
      const ids = extractPixeldrainIdsFromMessage(msgText, numParts);
      if (ids.length === 0) {
        await answerCallbackQuery(cb.id, "⚠️ Could not recover parts");
        await sendMessage(chatId,
          `⚠️ Could not rebuild M3U. The .m3u file was attached to the original upload-complete message — please download it from there.`,
          mainMenu());
        return res.status(200).json({ ok: true });
      }
      await answerCallbackQuery(cb.id, "📋 M3U ready below 👇");
      const m3u = buildM3U(ids, msgText);
      // Telegram messages cap at 4096 chars. For many parts, the M3U may not fit.
      // Send as a code block if short, otherwise send just the playlist URLs.
      if (m3u.length < 3500) {
        await sendMessage(chatId,
          `📋 <b>M3U Playlist (${ids.length} parts):</b>\n\n<code>${escapeHtml(m3u)}</code>\n\n<i>Long-press → Copy. Paste into a .m3u file, or send to VLC.</i>`,
          mainMenu());
      } else {
        // Too long — send URLs only (GCore CDN URLs for streaming)
        const lines = [`📋 <b>M3U URLs (M3U too long for chat — use attached .m3u file):</b>`, ``];
        for (let i = 0; i < ids.length; i++) {
          lines.push(`Part ${i + 1}: <code>${buildGcoreStreamUrl(ids[i])}</code>`);
        }
        await sendMessage(chatId, lines.join("\n"), mainMenu());
      }
      return res.status(200).json({ ok: true });
    }

    // ── Button: Instant GCore Stream (no upload) ──
    // v8.5: User taps [🚀 GCore Stream] on the confirm message.
    // We read the URL from the replied-to message, repoint the CDN origin to
    // the URL's host (if non-pixeldrain), and return the GCore stream URL.
    // Format: gcore_stream:yes
    if (data.startsWith("gcore_stream:")) {
      const choice = data.split(":")[1];
      if (choice !== "yes") {
        await answerCallbackQuery(cb.id, "❌ Cancelled");
        try {
          await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: cb.message?.message_id,
              text: "❌ <b>Cancelled.</b>",
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          });
        } catch {}
        return res.status(200).json({ ok: true });
      }

      // Extract URL from the replied-to message
      const originalText = cb.message?.reply_to_message?.text || "";
      const sourceUrl = extractUrlFromText(originalText);
      if (!sourceUrl) {
        await answerCallbackQuery(cb.id, "⚠️ Could not find URL");
        await sendMessage(chatId,
          "⚠️ <b>Could not recover the URL.</b>\n\nPlease send the download link again.",
          mainMenu());
        return res.status(200).json({ ok: true });
      }

      // Acknowledge immediately (<1s deadline)
      await answerCallbackQuery(cb.id, "⏳ Provisioning GCore stream...");

      // Edit the confirm message to show "provisioning" state
      try {
        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: cb.message?.message_id,
            text: `🚀 <b>GCore Stream provisioning...</b>\n\n🔗 <code>${escapeHtml(sourceUrl).slice(0, 200)}</code>\n⏳ Repointing CDN edge (2-5s)...`,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
      } catch {}

      // Fire-and-forget: provision the stream URL and send it as a new message
      provisionAndSendStreamUrl(chatId, sourceUrl, "", cb.id)
        .catch(err => {
          console.error("[gcore_stream callback bg] error:", err.message);
          sendMessage(chatId,
            `❌ <b>GCore stream failed:</b>\n<code>${escapeHtml(err.message || "").slice(0, 300)}</code>`,
            mainMenu()).catch(() => {});
        });
      return res.status(200).json({ ok: true });
    }

    // ── Button: Confirm upload of a forwarded Telegram file ──
    // v8.4: For forwarded files (no URL in user message), we stored the
    // tgfile: URL in an HTML comment in the confirm message text. On tap,
    // we parse it back out of cb.message.text.
    // Format: confirm_tgfile:yes  or  confirm_tgfile:no
    if (data.startsWith("confirm_tgfile:")) {
      const choice = data.split(":")[1];

      if (choice !== "yes") {
        await answerCallbackQuery(cb.id, "❌ Cancelled");
        try {
          await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: cb.message?.message_id,
              text: "❌ <b>Upload cancelled.</b>",
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          });
        } catch {}
        return res.status(200).json({ ok: true });
      }

      // Extract tgfile: URL from the HTML comment in the confirm message
      const msgText = cb.message?.text || cb.message?.caption || "";
      const tgMatch = msgText.match(/<!-- tgfile_url: (.+?) -->/);
      if (!tgMatch) {
        await answerCallbackQuery(cb.id, "⚠️ Could not recover file");
        await sendMessage(chatId,
          "⚠️ <b>Could not recover the file reference.</b>\n\nPlease forward the file again.",
          mainMenu());
        return res.status(200).json({ ok: true });
      }

      const tgFileUrl = tgMatch[1].trim();
      // Recover the filename from the tgfile: URL (format: tgfile:<id>:<name>)
      const nameMatch = tgFileUrl.match(/^tgfile:[^:]+:(.+)$/);
      const filename = nameMatch ? nameMatch[1] : "forwarded_file";

      await answerCallbackQuery(cb.id, "⏳ Starting upload...");

      // Edit the confirm message to show "processing"
      try {
        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: cb.message?.message_id,
            text: `📥 <b>File added to queue</b>\n📦 <code>${escapeHtml(filename)}</code>\n🔄 Processing...`,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
      } catch {}

      (async () => {
        try {
          await triggerUpload(tgFileUrl, filename, chatId);
        } catch (err) {
          await sendMessage(chatId,
            `❌ Failed to queue: <code>${escapeHtml(err.message).slice(0, 300)}</code>`,
            mainMenu());
        }
      })();
      return res.status(200).json({ ok: true });
    }

    // ── Button: Confirm upload (from URL message reply) ──
    // v8.4: When user sends a URL, bot replies with [Upload][Cancel] as a reply
    // to the user's message. When user taps [Upload], we read the original URL
    // from callback_query.message.reply_to_message.text and dispatch.
    // Format: confirm_upload:yes  or  confirm_upload:no
    if (data.startsWith("confirm_upload:")) {
      const choice = data.split(":")[1]; // "yes" or "no"

      // Cancel path — just acknowledge and edit the message
      if (choice !== "yes") {
        await answerCallbackQuery(cb.id, "❌ Cancelled");
        // Edit the original confirm message to show it was cancelled
        try {
          await fetch(`${TELEGRAM_API}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: cb.message?.message_id,
              text: "❌ <b>Upload cancelled.</b>",
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          });
        } catch {}
        return res.status(200).json({ ok: true });
      }

      // Confirm path — extract URL from the replied-to message
      const originalText = cb.message?.reply_to_message?.text || "";
      const sourceUrl = extractUrlFromText(originalText);
      if (!sourceUrl) {
        await answerCallbackQuery(cb.id, "⚠️ Could not find URL");
        await sendMessage(chatId,
          "⚠️ <b>Could not recover the URL.</b>\n\nPlease send the download link again.",
          mainMenu());
        return res.status(200).json({ ok: true });
      }

      // Acknowledge the callback immediately (<1s deadline)
      await answerCallbackQuery(cb.id, "⏳ Starting upload...");

      // Edit the confirm message to show "processing" state
      const filename = filenameFromUrl(normalizeSourceUrl(sourceUrl) || sourceUrl);
      try {
        await fetch(`${TELEGRAM_API}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: cb.message?.message_id,
            text: `📥 <b>Download link added to queue</b>\n📦 <code>${escapeHtml(filename)}</code>\n🔄 Processing...`,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
      } catch {}

      // v8.5: Repoint CDN back to pixeldrain.com so the post-upload GCore
      // stream link in the result message works. This is needed because the
      // user may have previously used [🚀 GCore Stream] which repointed the
      // origin to some other host. We repoint BEFORE dispatching so by the
      // time the upload finishes, the CDN is ready to serve from pixeldrain.
      try {
        await repointToPixeldrain();
      } catch (err) {
        console.error("[confirm_upload] repointToPixeldrain failed (non-fatal):", err.message);
        // Non-fatal — the upload still proceeds; the GCore link in result
        // may not work immediately but will work once origin is repointed.
      }

      // Dispatch to GitHub Actions (fire-and-forget)
      (async () => {
        try {
          await triggerUpload(sourceUrl, filename, chatId);
        } catch (err) {
          await sendMessage(chatId,
            `❌ Failed to queue: <code>${escapeHtml(err.message).slice(0, 300)}</code>`,
            mainMenu());
        }
      })();
      return res.status(200).json({ ok: true });
    }

    // ── Button: Main menu items (from /start) ──
    // v8.4: /start shows inline buttons [Status][Help][About][Ping][Rename].
    // These callbacks render the same content as the old /status, /help etc.
    // commands, but triggered by a button tap instead of a typed command.
    if (data.startsWith("menu:")) {
      const action = data.slice(5);
      if (action === "status") {
        const settings = getUserSettings(chatId);
        const nextName = settings.nextFilename
          ? `✏️ ${escapeHtml(settings.nextFilename)}`
          : "➖ Default (from URL)";
        await answerCallbackQuery(cb.id, "📊 Status");
        await sendMessage(chatId,
          `📊 <b>Current Settings</b>\n\n` +
          `Service: 🎬 PixelDrain (only option)\n` +
          `Next filename: ${nextName}\n\n` +
          `💡 Send a URL to upload!`,
          { reply_markup: startMenuKeyboard() });
        return res.status(200).json({ ok: true });
      }
      if (action === "help") {
        await answerCallbackQuery(cb.id, "📖 Help");
        await sendMessage(chatId, HELP_MSG, { reply_markup: startMenuKeyboard() });
        return res.status(200).json({ ok: true });
      }
      if (action === "about") {
        await answerCallbackQuery(cb.id, "ℹ️ About");
        await sendMessage(chatId, ABOUT_MSG, { reply_markup: startMenuKeyboard() });
        return res.status(200).json({ ok: true });
      }
      if (action === "ping") {
        await answerCallbackQuery(cb.id, "🏓 Pong!");
        await sendMessage(chatId,
          `🏓 Pong! Bot is alive.\nServer time: ${new Date().toISOString()}`,
          { reply_markup: startMenuKeyboard() });
        return res.status(200).json({ ok: true });
      }
      if (action === "rename") {
        await answerCallbackQuery(cb.id, "✏️ Rename");
        await sendMessage(chatId,
          `✏️ <b>Set custom filename</b>\n\n` +
          `Reply to this message with the filename you want for your next upload.\n\n` +
          `Example: <code>my_video.mp4</code>\n\n` +
          `Or type: <code>/rename my_video.mp4</code>`,
          { reply_markup: startMenuKeyboard() });
        return res.status(200).json({ ok: true });
      }
    }

    // Unknown callback
    await answerCallbackQuery(cb.id, "");
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
  // v8.4: Forwarded files also get [Upload][Cancel] buttons instead of
  // auto-dispatching. The file_id is encoded in a tgfile: URL which is stored
  // in the replied-to message text (the bot's confirm message echoes it).
  // Actually, since the user's original message doesn't contain a URL, we
  // store the tgfile: URL in the bot's confirm message text itself and
  // recover it from cb.message.text (not reply_to_message) on tap.
  const fileInfo = extractFileInfo(message);
  if (fileInfo && !text.startsWith("/")) {
    const tgFileUrl = `tgfile:${fileInfo.file_id}:${fileInfo.file_name}`;
    const sizeStr = formatFileSize(fileInfo.file_size);

    // For forwarded files, we can't use reply_to_message to recover the URL
    // (there is no URL in the user's message). Instead, we encode a short
    // reference in callback_data. tgfile: URLs are too long for callback_data
    // (64-byte limit), so we use a special prefix "confirm_tgfile" and store
    // the file_id in the confirm message text. On tap, we parse the tgfile:
    // URL from cb.message.text.
    const confirmText =
      `📎 <b>File received</b>\n\n` +
      `Name: <code>${escapeHtml(fileInfo.file_name)}</code>\n` +
      `Size: ${sizeStr}\n\n` +
      `📦 <b>Confirm upload to PixelDrain?</b>\n\n` +
      `<!-- tgfile_url: ${escapeHtml(tgFileUrl)} -->`;

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: confirmText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_to_message_id: message.message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: "📦 Upload to PixelDrain", callback_data: "confirm_tgfile:yes" },
            { text: "❌ Cancel", callback_data: "confirm_tgfile:no" },
          ]],
        },
      }),
    });
    return res.status(200).json({ ok: true });
  }

  if (!text) return res.status(200).json({ ok: true, ignored: "empty" });

  const cleanText = stripBotSuffix(text);

  // ─── Command: /start ───
  // v8.4: /start is the ONLY global command. It opens an inline button menu.
  if (cleanText === "/start") {
    await sendMessage(chatId, WELCOME, { reply_markup: startMenuKeyboard() });
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /help ───
  // v8.4: still works if typed manually, but NOT in slash-menu autocomplete.
  if (cleanText === "/help") {
    await sendMessage(chatId, HELP_MSG, { reply_markup: startMenuKeyboard() });
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /about ───
  if (cleanText === "/about") {
    await sendMessage(chatId, ABOUT_MSG, { reply_markup: startMenuKeyboard() });
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /ping ───
  if (cleanText === "/ping") {
    await sendMessage(chatId,
      `🏓 Pong! Bot is alive.\nServer time: ${new Date().toISOString()}`,
      { reply_markup: startMenuKeyboard() });
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /status ───
  if (cleanText === "/status") {
    const settings = getUserSettings(chatId);
    const nextName = settings.nextFilename ? `✏️ ${escapeHtml(settings.nextFilename)}` : "➖ Default (from URL)";
    await sendMessage(chatId,
      `📊 <b>Current Settings</b>\n\n` +
      `Service: 🎬 PixelDrain (only option)\n` +
      `Next filename: ${nextName}\n\n` +
      `💡 Send a URL to upload!`,
      { reply_markup: startMenuKeyboard() });
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
    await sendMessage(chatId, `✏️ Next upload will be named: <code>${escapeHtml(customName)}</code>`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Helper: show [Upload][Cancel] inline buttons for a URL ───
  // v8.4 FIX: This replaces the old handleUrlUpload() which auto-dispatched
  // to GitHub Actions immediately. Per user spec, NOTHING should auto-execute
  // — the user must tap [Upload] first. The bot replies to the user's URL
  // message with a confirm keyboard, and the confirm_upload callback handler
  // reads the URL back from callback_query.message.reply_to_message.text.
  async function showUploadConfirmation(urlPart) {
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId,
        "❌ Provide a valid URL.\nExample: <code>https://example.com/file.mkv</code>",
        { reply_markup: startMenuKeyboard() });
      return;
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);

    // Reply TO the user's message so we can recover the URL on button tap
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          `📦 <b>What do you want to do?</b>\n\n` +
          `🔗 <code>${escapeHtml(sourceUrl).slice(0, 300)}</code>\n` +
          `📝 Filename: <code>${escapeHtml(filename)}</code>\n\n` +
          `🚀 <b>GCore Stream</b> — instant CDN stream (no download, no upload)\n` +
          `📦 <b>Upload to PixelDrain</b> — download + upload (auto-splits &gt;10GB)`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_to_message_id: message.message_id,
        reply_markup: confirmUploadKeyboard(),
      }),
    });
  }

  // ─── Command: /pixeldrain <url> ───
  // v8.4: NO LONGER auto-dispatches. Shows [Upload][Cancel] buttons instead.
  if (cleanText.startsWith("/pixeldrain ")) {
    const urlPart = cleanText.replace(/^\/pixeldrain\s+/, "").trim();
    await showUploadConfirmation(urlPart);
    return res.status(200).json({ ok: true });
  }

  // ─── Legacy commands: /upload, /raw, /filekiwi, /stream, /service ───
  // v8.4: still no auto-execute. If they contain a URL, show confirm buttons.
  if (cleanText.startsWith("/upload ") || cleanText.startsWith("/raw ") || cleanText.startsWith("/filekiwi ") || cleanText.startsWith("/stream ") || cleanText.startsWith("/service")) {
    const urlMatch = cleanText.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      await showUploadConfirmation(urlMatch[0]);
    } else {
      await sendMessage(chatId,
        `💡 <b>Command simplified</b>\n\n` +
        `Just send the URL directly, or use <code>/pixeldrain &lt;url&gt;</code>.\n\n` +
        `All uploads go to PixelDrain (auto-splits &gt;10GB). Stream buttons appear in the result message.`,
        { reply_markup: startMenuKeyboard() });
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Menu button: "🔗 Upload link" (legacy persistent keyboard — removed in v8.4) ───
  // Kept for backwards compat if a user still has the old keyboard cached.
  if (text === "🔗 Upload link") {
    await sendMessage(
      chatId,
      "📎 <b>Send me a download link</b>\n\n" +
      "Just paste any direct download URL and I'll show you [Upload] [Cancel] buttons.\n" +
      "Files &gt; 10GB are auto-split with an M3U playlist.\n\n" +
      "<b>Example:</b>\n" +
      "<code>https://example.com/file.mkv</code>\n\n" +
      "<code>/rename name.mp4</code> — custom filename",
      { reply_markup: startMenuKeyboard() }
    );
    return res.status(200).json({ ok: true });
  }

  // ─── Unknown commands ───
  if (text.startsWith("/")) {
    await sendMessage(chatId,
      "❓ Unknown command. Tap /start for the menu.",
      { reply_markup: startMenuKeyboard() });
    return res.status(200).json({ ok: true });
  }

  // ─── Auto-detect URL in message → show [Upload][Cancel] buttons (v8.4: NO auto-dispatch) ───
  const detectedUrl = extractUrlFromText(text);
  if (detectedUrl) {
    await showUploadConfirmation(detectedUrl);
    return res.status(200).json({ ok: true });
  }

  // ─── Non-URL text ───
  await sendMessage(chatId,
    "📎 Send a download URL and I'll show you [Upload] [Cancel] buttons.\n\nTap /start for the menu.",
    { reply_markup: startMenuKeyboard() });
  return res.status(200).json({ ok: true });
}

// ─── Helpers for multi-part button callbacks ──────────────────

/**
 * Extract pixeldrain IDs from the original upload-complete message text.
 * The message contains lines like:
 *   "1. filename.part1 → /u/ABC12345"
 * We parse the /u/<id> portion.
 *
 * @param {string} messageText - the original message text
 * @param {number} expectedCount - how many parts to expect
 * @returns {string[]} array of pixeldrain IDs
 */
function extractPixeldrainIdsFromMessage(messageText, expectedCount) {
  if (!messageText) return [];
  const ids = [];
  // Match /u/<id> patterns (8-char pixeldrain IDs)
  const matches = messageText.matchAll(/\/u\/([A-Za-z0-9]{6,})/g);
  for (const m of matches) {
    ids.push(m[1]);
    if (ids.length >= expectedCount) break;
  }
  return ids;
}

/**
 * Build an M3U playlist from pixeldrain IDs.
 * v8.3: Uses Gcore CDN URLs (https://{GCORE_CDN_CNAME}/api/file/{id}) for ALL parts.
 * The CDN resource's origin is permanently set to pixeldrain.com, so each
 * /api/file/{id} request routes through the GCore edge with caching +
 * IP rate limit bypass. All parts can be streamed concurrently.
 *
 * @param {string[]} ids - pixeldrain file IDs
 * @param {string} messageText - original message (for filename hints)
 * @returns {string} M3U playlist content
 */
function buildM3U(ids, messageText) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  // Try to extract part filenames from the message text
  const nameMatches = messageText ? [...messageText.matchAll(/(?:Part\s+\d+\/\d+|[01]\d)\.\s*([^→\n]+?)\s*→/g)] : [];
  for (let i = 0; i < ids.length; i++) {
    const partName = nameMatches[i] ? nameMatches[i][1].trim() : `Part ${i + 1}`;
    lines.push(`#EXTINF:-1,${partName}`);
    lines.push(buildGcoreStreamUrl(ids[i]));  // GCore CDN URL
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}
