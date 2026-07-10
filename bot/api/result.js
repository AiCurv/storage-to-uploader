// Called by the GitHub Actions workflow when an upload finishes.
// Body: { chat_id, url, raw_url, filename, size_bytes, ok, error }
// We forward the result to the user via sendMessage.
//
// Security: this endpoint also locks to TELEGRAM_ALLOWED_ID - the chat_id
// in the body must match. Combined with the shared secret in the header
// (VERIFY_TOKEN), this stops anyone who can hit the URL from spoofing
// "upload complete" messages to the user.

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
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

  // Shared-secret check. Header name "x-verify" matches what the workflow sends.
  const expected = process.env.BOT_VERIFY_TOKEN || "";
  if (!expected) return res.status(500).json({ ok: false, error: "verify not configured" });
  const got = req.headers["x-verify"] || req.headers["X-Verify"];
  if (got !== expected) return res.status(401).json({ ok: false, error: "bad verify token" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const chatId = String(body.chat_id || "");
  const allowed = String(process.env.TELEGRAM_ALLOWED_ID || "");
  if (!chatId || (allowed && chatId !== allowed)) {
    return res.status(403).json({ ok: false, error: "unauthorized chat" });
  }

  if (body.error || !body.url) {
    await sendMessage(chatId, `❌ Upload failed: <code>${body.error || "unknown error"}</code>`);
    return res.status(200).json({ ok: true });
  }

  const size = humanSize(body.size_bytes);
  const msg = [
    `✅ Done — ${body.filename} (${size})`,
    ``,
    `🔗 <a href="${body.url}">HTML link</a>`,
    `📦 <a href="${body.raw_url}">Raw link</a>`,
  ].join("\n");
  await sendMessage(chatId, msg);
  return res.status(200).json({ ok: true });
}
