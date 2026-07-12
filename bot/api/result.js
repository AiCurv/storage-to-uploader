// Called by GitHub Actions workflow when upload finishes.
// Body: { chat_id, url, raw_url, filename, size_bytes, human_size, expires_at, error }
// We send the storage.to link to the user. That's it. No file upload to Telegram.

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

function humanSize(n) {
  if (!n) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
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

  // Send the storage.to link to user
  const size = body.human_size || humanSize(body.size_bytes);
  const msg = [
    `✅ <b>Upload Complete!</b>`,
    ``,
    `📦 <b>${body.filename}</b> (${size})`,
    ``,
    `🔗 <a href="${body.url}">Download Link</a>`,
    ``,
    body.expires_at ? `⏰ Expires: ${body.expires_at}` : "",
  ].filter(Boolean).join("\n");

  await sendMessage(chatId, msg);

  return res.status(200).json({ ok: true });
}
