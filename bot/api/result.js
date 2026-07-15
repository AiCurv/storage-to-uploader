// Called by GitHub Actions workflow when upload finishes.
// Body: { chat_id, service, url, raw_url, filename, size_bytes, human_size, expires_at, error, parts }
// We send the resulting link to the user. That's it. No file upload to Telegram.
//
// v8.0: storage.to removed. Supports pixeldrain (single or multi-part) and file.kiwi.
// If `parts` is present (array), the upload was split into multiple files (pixeldrain >10GB).

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

const SERVICE_LABELS = {
  pixeldrain: "🎬 pixeldrain",
  filekiwi:   "🥝 file.kiwi",
};

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

  // Error case
  if (body.error || (!body.url && !body.parts)) {
    await sendMessage(chatId, `❌ <b>Upload failed:</b>\n<code>${escapeHtml(body.error || "unknown error").slice(0, 500)}</code>`);
    return res.status(200).json({ ok: true });
  }

  const service = body.service || "pixeldrain";
  const serviceLabel = SERVICE_LABELS[service] || service;
  const size = body.human_size || humanSize(body.size_bytes);

  // ── Multi-part upload (pixeldrain >10GB auto-split) ──
  if (body.parts && Array.isArray(body.parts) && body.parts.length > 1) {
    const lines = [
      `✅ <b>Upload Complete!</b> (${body.parts.length} parts)`,
      ``,
      `📦 <b>${escapeHtml(body.filename || "file")}</b> (${size} total)`,
      `📤 Service: ${serviceLabel} (auto-split — each part ≤10GB)`,
      ``,
      `<b>Download links:</b>`,
    ];
    for (let i = 0; i < body.parts.length; i++) {
      const p = body.parts[i];
      lines.push(`Part ${i + 1}/${body.parts.length}: <a href="${p.url}">${escapeHtml(p.filename || `part_${i + 1}`)}</a> (${p.human_size || humanSize(p.size)})`);
    }
    lines.push(``);
    lines.push(`⚠️ <b>To merge:</b> download all parts, then run:`);
    lines.push(`<code>cat "${escapeHtml(body.parts[0].filename)}" "${escapeHtml(body.parts[1].filename)}" ... > merged.mkv</code>`);
    lines.push(``);
    lines.push(`♾️ Pixeldrain files do not expire`);
    await sendMessage(chatId, lines.join("\n"));
    return res.status(200).json({ ok: true });
  }

  // ── Single file upload (normal case) ──
  const msgLines = [
    `✅ <b>Upload Complete!</b>`,
    ``,
    `📦 <b>${escapeHtml(body.filename || "file")}</b> (${size})`,
    `📤 Service: ${serviceLabel}`,
    ``,
    `🔗 <a href="${body.url}">Download Link</a>`,
  ];

  if (body.raw_url && body.raw_url !== body.url) {
    msgLines.push(`⬇️ <a href="${body.raw_url}">Direct download (raw)</a>`);
  }

  if (body.expires_at) {
    msgLines.push(`⏰ Expires: ${escapeHtml(body.expires_at)}`);
  } else if (service === "pixeldrain") {
    msgLines.push(`♾️ Pixeldrain files do not expire`);
  } else if (service === "filekiwi") {
    msgLines.push(`🔒 file.kiwi: E2E encrypted — open link in browser to download`);
  }

  await sendMessage(chatId, msgLines.filter(Boolean).join("\n"));

  return res.status(200).json({ ok: true });
}
