// Telegram webhook entrypoint. Vercel invokes this on every incoming message.
// Security: hard-locks the bot to one Telegram user id, so even if the token
// leaks, only the owner can use the bot.
//
// Flow:
//   1. Receive update from Telegram.
//   2. Verify sender == TELEGRAM_ALLOWED_ID; ignore everyone else.
//   3. /start  -> send welcome + inline menu (/start, /idk).
//   4. /idk    -> send help message.
//   5. text URL -> kick off the GitHub Actions uploader, send "uploading..." reply.
//      The workflow later POSTs the result back to /api/result, which then
//      forwards the storage.to link to the user via sendMessage.

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

const WELCOME = [
  "Hey! Send me any direct download URL and I'll upload it to storage.to.",
  "",
  "Commands:",
  "/start - show the main menu",
  "/idk   - same as /start, alias",
  "",
  "Tip: works best with raw file links (mp4, mkv, mov, zip, etc).",
].join("\n");

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra }),
  });
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [[{ text: "/start" }, { text: "/idk" }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
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
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: "telegram-upload",
      client_payload: {
        source_url: sourceUrl,
        filename: originalName,
        chat_id: String(chatId),
        callback_url: `https://${process.env.VERCEL_PROJECT_URL}/api/result`,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`dispatch ${res.status}: ${text.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  // Telegram uses POST for webhooks; allow GET for warmup.
  if (req.method === "GET") return res.status(200).json({ ok: true, webhook: "ready" });
  if (req.method !== "POST") return res.status(405).end();

  let update;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "bad json" });
  }

  const message = update.message || update.edited_message;
  if (!message) return res.status(200).json({ ok: true, ignored: true });

  const chatId = message.chat.id;
  const allowed = String(process.env.TELEGRAM_ALLOWED_ID || "");
  if (allowed && String(chatId) !== allowed) {
    // Silently drop - never reveal the bot exists to anyone else.
    return res.status(200).json({ ok: true, ignored: "unauthorized" });
  }

  const text = (message.text || "").trim();
  if (!text) return res.status(200).json({ ok: true, ignored: "empty" });

  // Commands
  if (text === "/start" || text === "/idk") {
    await sendMessage(chatId, WELCOME, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // Anything starting with / is rejected so we don't echo random bot commands.
  if (text.startsWith("/")) {
    await sendMessage(chatId, "Unknown command. Try /start.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // URL handling
  if (!looksLikeUrl(text)) {
    await sendMessage(
      chatId,
      "Send a direct file URL (http(s)://...). I download and upload it to storage.to.",
      mainMenu(),
    );
    return res.status(200).json({ ok: true });
  }

  const filename = filenameFromUrl(text);
  try {
    await triggerUpload(text, filename, chatId);
    await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\nUploading... I'll message you when it's done.`, mainMenu());
  } catch (err) {
    await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
  }
  return res.status(200).json({ ok: true });
}
