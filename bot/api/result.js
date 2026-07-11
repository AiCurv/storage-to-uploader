// Called by the GitHub Actions workflow when an upload finishes.
// Body: { chat_id, url, raw_url, filename, size_bytes, human_size, subtitles, ok, error }
// We forward the result to the user via sendMessage and post to channel.

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";

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

function buildResultMessage(body) {
  const size = body.human_size || humanSize(body.size_bytes);
  const lines = [
    `✅ <b>Upload Complete!</b>`,
    ``,
    `🎬 <b>${body.filename}</b> (${size})`,
    ``,
    `🔗 <a href="${body.url}">Stream / Download Page</a>`,
    `📦 <a href="${body.raw_url}">Direct MP4 Link</a>`,
  ];

  // Add subtitle links if present
  const subs = body.subtitles || [];
  if (subs.length > 0) {
    lines.push("");
    lines.push(`📝 <b>Subtitles (${subs.length}):</b>`);
    for (const sub of subs) {
      const subLabel = sub.filename || "subtitle";
      lines.push(`  • <a href="${sub.url}">${subLabel}</a>`);
    }
  }

  // Expiry notice
  if (body.expires_at) {
    lines.push("");
    lines.push(`⏰ Links expire: ${body.expires_at}`);
  }

  return lines.join("\n");
}

function buildChannelMessage(body) {
  const size = body.human_size || humanSize(body.size_bytes);
  const lines = [
    `🎬 <b>${body.filename}</b> (${size})`,
    ``,
    `🔗 <a href="${body.url}">Stream</a> | <a href="${body.raw_url}">Download</a>`,
  ];

  const subs = body.subtitles || [];
  if (subs.length > 0) {
    lines.push("");
    lines.push(`📝 Subtitles:`);
    for (const sub of subs) {
      lines.push(`  • <a href="${sub.url}">${sub.filename || "subtitle"}</a>`);
    }
  }

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

  // Error case
  if (body.error || !body.url) {
    await sendMessage(chatId, `❌ <b>Upload failed:</b> <code>${body.error || "unknown error"}</code>`);
    return res.status(200).json({ ok: true });
  }

  // Send result to user
  const userMsg = buildResultMessage(body);
  await sendMessage(chatId, userMsg);

  // Post to channel if configured
  if (CHANNEL_ID) {
    try {
      const channelMsg = buildChannelMessage(body);
      await sendMessage(CHANNEL_ID, channelMsg);
    } catch (err) {
      console.error("[result] channel post failed:", err.message);
    }
  }

  return res.status(200).json({ ok: true });
}
