// Called by GitHub Actions workflow when upload finishes.
// Body: { chat_id, service, url, raw_url, filename, size_bytes, human_size, expires_at, error, parts }
//
// v8.2: Sends ONE consolidated message with inline buttons:
//   - Single file (<10GB): filename + size + buttons [📂 Open] [▶️ Stream] [📋 Copy]
//   - Multi-part (≥10GB): filename + total size + part count + M3U file attached
//                         + buttons [📋 Copy M3U] [▶️ Stream All] [📂 Download All]
//                         + list of parts with their PixelDrain URLs
//
// Stream button lazily provisions a Gcore CDN URL on click (handled in webhook.js).
// M3U uses PixelDrain raw URLs (not Gcore) because the single-CDN-resource
// architecture means Gcore can only point at one origin at a time.

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
 */
function extractPixeldrainId(url) {
  if (!url) return null;
  const m = url.match(/\/(?:u|api\/file|d)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Build the M3U playlist content for multi-part uploads.
 * Uses pixeldrain raw URLs (they support Range and stream in VLC).
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
    lines.push(`#EXTINF:-1,${partName}`);
    lines.push(p.raw_url || p.url || "");
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

    // Build inline keyboard buttons
    // callback_data limit: 64 bytes
    // - copy_m3u:<count>             — 15 bytes max  ✅
    // - stream_all:<count>           — 15 bytes max  ✅
    // - download_all:<count>         — 15 bytes max  ✅  (we recover IDs from message text on click)
    //
    // NOTE: We DON'T put pixeldrain IDs in callback_data for download_all because
    // 8+ parts would overflow the 64-byte limit. Instead, the click handler in
    // webhook.js parses the /u/<id> patterns from the original message text.
    const inlineKeyboard = [
      [
        { text: "📋 Copy M3U", callback_data: `copy_m3u:${partCount}` },
        { text: "▶️ Stream All", callback_data: `stream_all:${partCount}` },
      ],
      [
        { text: "📂 Download All", callback_data: `download_all:${partCount}` },
      ],
    ];

    // Build the parts list text
    const partsLines = [``, `<b>Parts:</b>`];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const pSize = p.human_size || humanSize(p.size);
      const pName = escapeHtml(p.filename || `part_${i + 1}`);
      const pUrl = escapeHtml(p.url || "");
      partsLines.push(`${i + 1}. ${pName} (${pSize}) → <a href="${pUrl}">/u/${extractPixeldrainId(p.url) || "?"}</a>`);
    }

    const messageText = [
      `📦 <b>Upload Complete (Multi-Part)</b>`,
      ``,
      `File: <b>${escapeHtml(filename)}</b>`,
      `Total Size: ${size}`,
      `Parts: ${partCount}`,
      ``,
      `🎬 <b>M3U playlist attached below</b> — open in VLC to play all parts sequentially`,
      ``,
      ...partsLines,
      ``,
      `♾️ Pixeldrain files do not expire`,
      ``,
      `<i>Tap a button to copy M3U / stream a part / download all URLs.</i>`,
    ].join("\n");

    // Send the message with inline buttons
    await sendMessage(chatId, messageText, {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    // Send the M3U file as a separate document (so user can save + open in VLC)
    const m3uFilename = (filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)) + ".m3u";
    const m3uContent = buildM3UContent(filename, parts);
    try {
      await sendDocument(chatId, m3uFilename, m3uContent, `📋 M3U Playlist — ${partCount} parts`);
    } catch (err) {
      console.error("[result:sendDocument] M3U attach failed:", err.message);
      // Non-fatal — the inline Copy M3U button still works
    }

    return res.status(200).json({ ok: true });
  }

  // ── Single file upload (normal case, <10GB) ──
  const pixeldrainId = extractPixeldrainId(body.url);
  const directUrl = body.url || (pixeldrainId ? `https://pixeldrain.com/u/${pixeldrainId}` : "");
  const rawUrl = body.raw_url || (pixeldrainId ? `https://pixeldrain.com/api/file/${pixeldrainId}` : "");

  // callback_data format:
  //   open:<id>      — 14 bytes max
  //   stream:<id>    — 16 bytes max
  //   copy:<id>      — 14 bytes max
  const inlineKeyboard = [];
  if (pixeldrainId) {
    inlineKeyboard.push([
      { text: "📂 Open", callback_data: `open:${pixeldrainId}` },
      { text: "▶️ Stream", callback_data: `stream:${pixeldrainId}` },
      { text: "📋 Copy", callback_data: `copy:${pixeldrainId}` },
    ]);
  }

  const msgLines = [
    `📦 <b>Upload Complete</b>`,
    ``,
    `File: <b>${escapeHtml(filename)}</b>`,
    `Size: ${size}`,
    ``,
    `🔗 <b>Direct Download:</b>`,
    `<a href="${escapeHtml(directUrl)}">${escapeHtml(directUrl)}</a>`,
  ];

  if (rawUrl && rawUrl !== directUrl) {
    msgLines.push(``, `⬇️ <b>Raw (VLC / downloaders):</b>`, `<code>${escapeHtml(rawUrl)}</code>`);
  }

  msgLines.push(``, `♾️ Pixeldrain files do not expire`);

  await sendMessage(chatId, msgLines.join("\n"), {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });

  return res.status(200).json({ ok: true });
}
