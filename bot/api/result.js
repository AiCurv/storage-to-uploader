// Called by GitHub Actions workflow when upload finishes.
// Body: { chat_id, service, url, raw_url, filename, size_bytes, human_size, expires_at, error, parts }
//
// v8.3: Sends ONE consolidated message with inline buttons:
//   - Single file (<10GB): filename + size + buttons [📂 Open] [▶️ Stream] [📋 Copy]
//   - Multi-part (≥10GB): filename + total size + part count + M3U file attached
//                         + buttons [📋 Copy M3U] [▶️ Stream All] [📂 Download All]
//                         + list of parts with their PixelDrain + GCore URLs
//
// Stream button lazily constructs a Gcore CDN URL on click (handled in webhook.js).
// v8.3: M3U uses Gcore CDN URLs (https://{GCORE_CDN_CNAME}/api/file/{id}) for ALL
// parts — the CDN origin is permanently pixeldrain.com, so each part streams
// through the GCore edge with caching + IP rate limit bypass. All parts can be
// streamed concurrently (no origin repointing conflict).

import { buildGcoreStreamUrl, extractPixeldrainId } from "./_gcore.js";

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

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

async function sendDocument(chatId, filename, fileContent, caption = "") {
  // Telegram sendDocument requires multipart/form-data
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  formData.append("disable_web_page_preview", "true");
  const blob = new Blob([fileContent], { type: "audio/x-mpegurl" });
  formData.append("document", blob, filename);
  const res = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("[result:sendDocument] failed:", res.status, text.slice(0, 500));
  }
  return res.json();
}

function humanSize(n) {
  if (!n) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Extract the pixeldrain file ID from a URL like:
 *   https://pixeldrain.com/u/ABC12345
 *   https://pixeldrain.com/api/file/ABC12345
 * (re-exported from _gcore.js for backwards compat with any internal callers)
 */
function extractPixeldrainIdLocal(url) {
  return extractPixeldrainId(url);
}

/**
 * Build the M3U playlist content for multi-part uploads.
 * v8.5: Uses Gcore CDN URLs (https://{GCORE_CDN_CNAME}/parts/{id}) for ALL parts.
 * The CDN resource has a rewrite rule: /parts/(.*) → /api/file/$1, so each
 * /parts/{id} request routes through the GCore edge with caching + IP rate
 * limit bypass. Origin is pixeldrain.com (repointed back in confirm_upload).
 */
function buildM3UContent(filename, parts) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const partName = p.filename || `Part ${i + 1}`;
    const pid = extractPixeldrainId(p.url) || extractPixeldrainId(p.raw_url);
    lines.push(`#EXTINF:-1,${partName}`);
    if (pid) {
      // GCore CDN URL via /parts/ rewrite — edge cached, IP rate limit bypass
      lines.push(buildGcoreStreamUrl(pid));
    } else {
      // Fallback: pixeldrain raw URL (shouldn't happen, but just in case)
      lines.push(p.raw_url || p.url || "");
    }
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Shared-secret check
  const expected = process.env.BOT_VERIFY_TOKEN || "";
  if (!expected) return res.status(500).json({ ok: false, error: "verify not configured" });
  const got = req.headers["x-verify"] || "";
  if (got !== expected) return res.status(401).json({ ok: false, error: "bad verify token" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const chatId = String(body.chat_id || "");
  const allowed = String(process.env.TELEGRAM_ALLOWED_ID || "");
  if (!chatId || (allowed && chatId !== allowed)) {
    return res.status(403).json({ ok: false, error: "unauthorized chat" });
  }

  // ── Cancellation callback (from telegram.yml Fix 7) ──
  if (body.status === "cancelled") {
    await sendMessage(chatId,
      `❌ <b>Upload cancelled</b>\n\n` +
      `Your upload was cancelled (either you clicked Cancel in GitHub Actions, or the workflow was interrupted).\n\n` +
      `No files were uploaded. Send the URL again to retry.`,
      {});
    return res.status(200).json({ ok: true });
  }

  // ── Error case ──
  if (body.error || (!body.url && !body.parts)) {
    await sendMessage(chatId,
      `❌ <b>Upload failed</b>\n\n<code>${escapeHtml(body.error || "unknown error").slice(0, 500)}</code>`,
      {});
    return res.status(200).json({ ok: true });
  }

  const filename = body.filename || "file";
  const size = body.human_size || humanSize(body.size_bytes);

  // ── Multi-part upload (pixeldrain >10GB auto-split) ──
  if (body.parts && Array.isArray(body.parts) && body.parts.length > 1) {
    const parts = body.parts;
    const partCount = parts.length;

    // v8.5: Build inline keyboard buttons
    const inlineKeyboard = [
      [
        { text: "📋 Copy M3U", callback_data: `copy_m3u:${partCount}` },
        { text: "▶️ Stream All", callback_data: `stream_all:${partCount}` },
      ],
      [
        { text: "📂 Download All", callback_data: `download_all:${partCount}` },
      ],
    ];

    // v8.5: Build the parts list text — show BOTH PixelDrain AND GCore links
    // for each part, so the user can verify all parts uploaded and has both
    // streaming + download options per part.
    const partsLines = [``, `<b>Parts (${partCount}):</b>`];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const pSize = p.human_size || humanSize(p.size);
      const pName = escapeHtml(p.filename || `part_${i + 1}`);
      const pid = extractPixeldrainId(p.url) || extractPixeldrainId(p.raw_url);
      const pUrl = escapeHtml(p.url || "");
      const gcoreUrl = pid ? buildGcoreStreamUrl(pid) : null;

      partsLines.push(`${i + 1}. <b>${pName}</b> (${pSize})`);
      partsLines.push(`   📦 <a href="${pUrl}">PixelDrain</a>`);
      if (gcoreUrl) {
        partsLines.push(`   🚀 <a href="${escapeHtml(gcoreUrl)}">GCore Stream</a>`);
      }
    }

    const messageText = [
      `📦 <b>Upload Complete (Multi-Part)</b>`,
      ``,
      `File: <b>${escapeHtml(filename)}</b>`,
      `Total Size: ${size}`,
      `Parts: ${partCount}`,
      ``,
      `🎬 <b>M3U playlist attached below</b> — open in VLC to play all parts sequentially (uses GCore CDN URLs)`,
      ``,
      ...partsLines,
      ``,
      `♾️ Pixeldrain files do not expire`,
      ``,
      `<i>Tap a button to copy M3U / stream all / download all URLs.</i>`,
    ].join("\n");

    // Send the message with inline buttons
    await sendMessage(chatId, messageText, {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    // Send the M3U file as a separate document (so user can save + open in VLC)
    const m3uFilename = (filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)) + ".m3u";
    const m3uContent = buildM3UContent(filename, parts);
    try {
      await sendDocument(chatId, m3uFilename, m3uContent, `📋 M3U Playlist — ${partCount} parts (GCore CDN)`);
    } catch (err) {
      console.error("[result:sendDocument] M3U attach failed:", err.message);
      // Non-fatal — the inline Copy M3U button still works
    }

    return res.status(200).json({ ok: true });
  }

  // ── Single file upload (normal case, <10GB) ──
  // v8.5: Show BOTH PixelDrain AND GCore links, with buttons for each.
  const pixeldrainId = extractPixeldrainId(body.url);
  const directUrl = body.url || (pixeldrainId ? `https://pixeldrain.com/u/${pixeldrainId}` : "");
  const rawUrl = body.raw_url || (pixeldrainId ? `https://pixeldrain.com/api/file/${pixeldrainId}` : "");
  const gcoreStreamUrl = pixeldrainId ? buildGcoreStreamUrl(pixeldrainId) : null;

  // callback_data format:
  //   open:<id>      — 14 bytes max
  //   stream:<id>    — 16 bytes max
  //   copy:<id>      — 14 bytes max
  const inlineKeyboard = [];
  if (pixeldrainId) {
    inlineKeyboard.push([
      { text: "📂 Open PixelDrain", callback_data: `open:${pixeldrainId}` },
      { text: "▶️ Stream GCore", callback_data: `stream:${pixeldrainId}` },
    ]);
    inlineKeyboard.push([
      { text: "📋 Copy All URLs", callback_data: `copy:${pixeldrainId}` },
    ]);
  }

  const msgLines = [
    `📦 <b>Upload Complete</b>`,
    ``,
    `File: <b>${escapeHtml(filename)}</b>`,
    `Size: ${size}`,
    ``,
    `📦 <b>PixelDrain Download:</b>`,
    `<a href="${escapeHtml(directUrl)}">${escapeHtml(directUrl)}</a>`,
  ];

  if (rawUrl && rawUrl !== directUrl) {
    msgLines.push(``, `⬇️ <b>PixelDrain Raw (VLC / downloaders):</b>`, `<code>${escapeHtml(rawUrl)}</code>`);
  }

  if (gcoreStreamUrl) {
    msgLines.push(``, `🚀 <b>GCore Stream (CDN edge):</b>`, `<a href="${escapeHtml(gcoreStreamUrl)}">${escapeHtml(gcoreStreamUrl)}</a>`);
  }

  msgLines.push(``, `♾️ Pixeldrain files do not expire`);

  await sendMessage(chatId, msgLines.join("\n"), {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });

  return res.status(200).json({ ok: true });
}
