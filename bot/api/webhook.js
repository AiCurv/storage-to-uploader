// Telegram webhook entrypoint. Vercel invokes this on every incoming message.
//
// Commands:
//   /start        - Welcome message + main menu
//   /upload <url> - Upload a file URL to storage.to (converts video to MP4)
//   /status       - Check your recent uploads
//   /help         - Detailed help message
//   /raw <url>    - Upload without MP4 conversion (raw passthrough)
//   /subson       - Enable subtitle extraction (default: ON)
//   /subsoff      - Disable subtitle extraction
//
// Any direct URL sent as text auto-triggers upload with conversion.
//
// Security: hard-locks the bot to one Telegram user id.

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";

const WELCOME = [
  "🎬 <b>StreamToBuffer Bot</b>",
  "",
  "Send me any download link and I'll:",
  "  1️⃣ Download the file",
  "  2️⃣ Convert video to streamable MP4",
  "  3️⃣ Extract subtitles (if any)",
  "  4️⃣ Upload to storage.to",
  "  5️⃣ Post to the channel",
  "  6️⃣ Send you the links",
  "",
  "📝 <b>Commands:</b>",
  "/upload &lt;url&gt; — Upload & convert to MP4",
  "/raw &lt;url&gt; — Upload without conversion",
  "/subson — Enable subtitle extraction",
  "/subsoff — Disable subtitle extraction",
  "/status — Recent upload status",
  "/channelid — Get channel ID for auto-posting",
  "/help — Detailed help",
  "",
  "💡 Works with pixeldrain, direct links, and most file hosts!",
].join("\n");

const HELP_MSG = [
  "📖 <b>StreamToBuffer Help</b>",
  "",
  "<b>How it works:</b>",
  "You send a download URL → I download it via GitHub Actions → FFmpeg converts video to streamable MP4 → subtitles are extracted → everything uploads to storage.to → you get MP4 + subtitle links → posted to channel.",
  "",
  "<b>Supported sources:</b>",
  "• Pixeldrain (/u/, /d/, /api/file/ links all work)",
  "• Direct download links (mp4, mkv, avi, etc.)",
  "• Any URL that serves file bytes",
  "",
  "<b>Video conversion:</b>",
  "• Auto-converts MKV/AVI/MOV/WebM/etc → MP4",
  "• Uses H.264 + AAC for universal compatibility",
  "• Adds faststart for instant streaming",
  "• Already-MP4 files: just ensures faststart",
  "",
  "<b>Subtitles:</b>",
  "• Auto-extracts SRT/ASS/VTT from video files",
  "• Each subtitle uploaded as separate file",
  "• Toggle with /subson and /subsoff",
  "",
  "<b>Links you get:</b>",
  "• 🔗 HTML page (with player + QR code)",
  "• 📦 Raw direct link (streamable MP4)",
  "• 📝 Subtitle links (if found)",
  "",
  "<b>Channel auto-post:</b>",
  "Every upload is automatically posted to @AiCurv channel.",
].join("\n");

// Per-user settings (in-memory, resets on redeploy — good enough for single-user bot)
const userSettings = {};

function getUserSettings(chatId) {
  const key = String(chatId);
  if (!userSettings[key]) {
    userSettings[key] = { extractSubs: true };
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

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🎬 Upload link" }, { text: "/status" }],
        [{ text: "/subson" }, { text: "/subsoff" }],
        [{ text: "/help" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

// Convert known "share page" URLs into direct download URLs.
function normalizeSourceUrl(text) {
  let url;
  try { url = new URL(text.trim()); } catch { return null; }
  const host = url.host.toLowerCase();
  const path = url.pathname;

  if (host === "pixeldrain.com" || host.endsWith(".pixeldrain.com")) {
    // /u/<id> and /d/<id> are HTML viewers → rewrite to /api/file/<id>
    const m1 = path.match(/^\/u\/([A-Za-z0-9]+)/);
    if (m1) return `https://pixeldrain.com/api/file/${m1[1]}`;
    const m2 = path.match(/^\/d\/([A-Za-z0-9]+)/);
    if (m2) return `https://pixeldrain.com/api/file/${m2[1]}`;
  }

  return null; // no rewrite needed
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

async function triggerUpload(sourceUrl, originalName, chatId, options = {}) {
  const repo = process.env.GITHUB_REPO || "AiCurv/storage-to-uploader";
  const [owner, name] = repo.split("/");
  const settings = getUserSettings(chatId);

  const payload = {
    event_type: "telegram-upload",
    client_payload: {
      source_url: sourceUrl,
      filename: originalName,
      chat_id: String(chatId),
      convert_to_mp4: options.rawMode ? "0" : "1",
      extract_subs: settings.extractSubs ? "1" : "0",
    },
  };

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
}

function extractUrlFromText(text) {
  // Find URLs in text (could be mixed with other text)
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
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

  const message = update.message || update.edited_message;
  if (!message) {
    // Handle my_chat_member updates (bot added to channel/group)
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      if (chat.type === "channel" || chat.type === "supergroup") {
        // Auto-detect channel ID and notify user
        const channelInfo = `📢 Bot added to <b>${chat.title || "channel"}</b>\nChannel ID: <code>${chat.id}</code>\n\nAdd this as TELEGRAM_CHANNEL_ID secret in GitHub to enable auto-posting!`;
        // Try to notify the allowed user
        const allowedId = String(process.env.TELEGRAM_ALLOWED_ID || "");
        if (allowedId) {
          await sendMessage(allowedId, channelInfo);
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
  if (!text) return res.status(200).json({ ok: true, ignored: "empty" });

  // ─── Command: /start ───
  if (text === "/start" || text === "/start@Streamtobufferbot") {
    await sendMessage(chatId, WELCOME, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /help ───
  if (text === "/help" || text === "/help@Streamtobufferbot" || text === "/idk") {
    await sendMessage(chatId, HELP_MSG, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /subson ───
  if (text === "/subson" || text === "/subson@Streamtobufferbot") {
    const settings = getUserSettings(chatId);
    settings.extractSubs = true;
    await sendMessage(chatId, "✅ Subtitle extraction <b>enabled</b>. Subtitles will be extracted from video files and uploaded.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /subsoff ───
  if (text === "/subsoff" || text === "/subsoff@Streamtobufferbot") {
    const settings = getUserSettings(chatId);
    settings.extractSubs = false;
    await sendMessage(chatId, "❌ Subtitle extraction <b>disabled</b>. No subtitles will be extracted.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /status ───
  if (text === "/status" || text === "/status@Streamtobufferbot") {
    const settings = getUserSettings(chatId);
    const subsStatus = settings.extractSubs ? "✅ ON" : "❌ OFF";
    const channelStatus = CHANNEL_ID ? `✅ Auto-posting to channel` : "❌ No channel configured";
    await sendMessage(chatId, 
      `📊 <b>Current Settings</b>\n\n` +
      `Subtitle extraction: ${subsStatus}\n` +
      `MP4 conversion: ✅ ON (default)\n` +
      `Channel: ${channelStatus}\n\n` +
      `💡 Send a URL to upload!`,
      mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /channelid ───
  if (text === "/channelid" || text === "/channelid@Streamtobufferbot") {
    // If used in a channel, shows the channel ID
    const chatType = message.chat.type;
    if (chatType === "channel" || chatType === "supergroup") {
      await sendMessage(chatId, `📢 This ${chatType}'s ID: <code>${chatId}</code>\n\nSet this as TELEGRAM_CHANNEL_ID in GitHub secrets to enable auto-posting!`);
    } else {
      await sendMessage(chatId, `📋 Your chat ID: <code>${chatId}</code>\n\nUse this command in a channel to get the channel ID. Or add the bot to your channel and it will auto-detect the ID.`);
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /upload <url> ───
  if (text.startsWith("/upload ") || text.startsWith("/upload@Streamtobufferbot ")) {
    const urlPart = text.replace(/^\/upload(@\w+)?\s+/, "").trim();
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Please provide a valid URL after /upload\nExample: <code>/upload https://example.com/video.mkv</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);
    try {
      await triggerUpload(sourceUrl, filename, chatId);
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Converting to MP4 & uploading...\nI'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /raw <url> ───
  if (text.startsWith("/raw ") || text.startsWith("/raw@Streamtobufferbot ")) {
    const urlPart = text.replace(/^\/raw(@\w+)?\s+/, "").trim();
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Please provide a valid URL after /raw\nExample: <code>/raw https://example.com/file.zip</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);
    try {
      await triggerUpload(sourceUrl, filename, chatId, { rawMode: true });
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code> (raw mode - no conversion)\n🔄 Uploading...\nI'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Menu button: "🎬 Upload link" ───
  if (text === "🎬 Upload link") {
    await sendMessage(chatId, "📎 Paste your download link below, or use:\n<code>/upload URL</code> — convert to MP4\n<code>/raw URL</code> — no conversion", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Unknown commands ───
  if (text.startsWith("/")) {
    await sendMessage(chatId, "❓ Unknown command. Try /help for available commands.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Auto-detect URL in message ───
  const detectedUrl = extractUrlFromText(text);
  if (detectedUrl) {
    const sourceUrl = normalizeSourceUrl(detectedUrl) || detectedUrl;
    const filename = filenameFromUrl(sourceUrl);
    try {
      await triggerUpload(sourceUrl, filename, chatId);
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Converting to MP4 & uploading...\nI'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Non-URL text ───
  await sendMessage(chatId, "📎 Send a direct file URL (http(s)://...) and I'll download, convert, and upload it to storage.to.\n\nType /help for more info.", mainMenu());
  return res.status(200).json({ ok: true });
}
