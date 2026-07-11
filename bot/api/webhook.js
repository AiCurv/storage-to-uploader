// Telegram webhook entrypoint. Vercel invokes this on every incoming message.
//
// Commands:
//   /start          - Welcome message + main menu
//   /upload <url>   - Upload a file URL to storage.to (converts video to MP4)
//   /raw <url>      - Upload without MP4 conversion (raw passthrough)
//   /subson         - Enable subtitle extraction (default: ON)
//   /subsoff        - Disable subtitle extraction
//   /status         - Check your recent uploads & current settings
//   /info <url>     - Get video info without uploading (probe the URL)
//   /rename <name>  - Set custom filename for next upload
//   /channelid      - Get channel ID for auto-posting
//   /help           - Detailed help message
//   /ping           - Bot latency check
//   /about          - About the bot
//
// Any direct URL sent as text auto-triggers upload with conversion.
//
// Security: hard-locks the bot to one Telegram user id.

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";
const BOT_USERNAME = "Streamtobufferbot";

const WELCOME = [
  "🎬 <b>StreamToBuffer Bot</b> v2.0",
  "",
  "Send me any download link and I'll:",
  "  1️⃣ Download the file (up to 5GB+)",
  "  2️⃣ Convert video to streamable MP4",
  "  3️⃣ Extract subtitles (if any)",
  "  4️⃣ Generate thumbnail",
  "  5️⃣ Upload to storage.to",
  "  6️⃣ Post to your channel",
  "  7️⃣ Send you streaming + HTML links",
  "",
  "📝 <b>Commands:</b>",
  "/upload &lt;url&gt; — Upload & convert to MP4",
  "/raw &lt;url&gt; — Upload without conversion",
  "/info &lt;url&gt; — Probe video info without uploading",
  "/rename &lt;name&gt; — Set custom filename for next upload",
  "/subson — Enable subtitle extraction",
  "/subsoff — Disable subtitle extraction",
  "/status — Current settings",
  "/channelid — Get channel ID",
  "/ping — Latency check",
  "/about — About this bot",
  "/help — Detailed help",
  "",
  "💡 Works with ANY direct download link, pixeldrain, and more!",
].join("\n");

const HELP_MSG = [
  "📖 <b>StreamToBuffer Help</b>",
  "",
  "<b>How it works:</b>",
  "You send a download URL → I download it via GitHub Actions → FFmpeg converts video to streamable MP4 → subtitles are extracted → thumbnail generated → everything uploads to storage.to → you get streaming CDN link + HTML page + subtitle links → posted to channel.",
  "",
  "<b>Supported sources:</b>",
  "• Pixeldrain (/u/, /d/, /api/file/ links all work)",
  "• Direct download links (mp4, mkv, avi, etc.)",
  "• Any URL that serves file bytes directly",
  "• Raw video links from any host",
  "",
  "<b>Video conversion:</b>",
  "• Auto-converts MKV/AVI/MOV/WebM/etc → MP4",
  "• Uses H.264 + AAC for universal compatibility",
  "• Adds faststart for instant streaming",
  "• Already-MP4 files: just ensures faststart",
  "• Use /raw to skip conversion entirely",
  "",
  "<b>Subtitles:</b>",
  "• Auto-extracts SRT/ASS/VTT from video files",
  "• Each subtitle uploaded as separate file to storage.to",
  "• Toggle with /subson and /subsoff",
  "",
  "<b>Links you get:</b>",
  "• 🔗 HTML page (with player + QR code)",
  "• ▶️ Streaming CDN link (play directly in browser/VLC)",
  "• 📝 Subtitle links (if found)",
  "",
  "<b>Channel auto-post:</b>",
  "Every upload is automatically posted to your configured channel with the MP4 video file.",
  "",
  "<b>Advanced:</b>",
  "• /info <url> — Get video details without uploading",
  "• /rename <name> — Override filename for next upload",
  "• /ping — Check bot responsiveness",
  "• Files up to 5GB+ supported (GitHub Actions disk)",
  "• Telegram channel upload up to 2GB (bot as admin)",
].join("\n");

const ABOUT_MSG = [
  "🤖 <b>StreamToBuffer Bot</b> v2.0",
  "",
  "Built for converting any video format to streamable MP4 and sharing via storage.to",
  "",
  "🔧 <b>Tech Stack:</b>",
  "• GitHub Actions (download + FFmpeg)",
  "• storage.to (file hosting + CDN streaming)",
  "• Vercel (bot webhook handler)",
  "• FFmpeg (video conversion + subtitle extraction)",
  "",
  "⚡ <b>Features:</b>",
  "• Disk-based pipeline (handles 5GB+ files)",
  "• Auto MKV/AVI/MOV → MP4 conversion",
  "• Faststart for instant streaming",
  "• Subtitle extraction (SRT/ASS/VTT)",
  "• Thumbnail generation",
  "• Channel auto-post with video upload",
  "• Streaming CDN link extraction",
].join("\n");

// Per-user settings (in-memory, resets on redeploy — good enough for single-user bot)
const userSettings = {};

function getUserSettings(chatId) {
  const key = String(chatId);
  if (!userSettings[key]) {
    userSettings[key] = {
      extractSubs: true,
      nextFilename: null,  // Custom filename override for next upload
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

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🎬 Upload link" }, { text: "/status" }],
        [{ text: "/subson" }, { text: "/subsoff" }],
        [{ text: "/help" }, { text: "/ping" }],
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

  // For any other URL, pass through as-is (universal link support)
  // The upload.mjs resolveSource will handle browser UA and other patterns
  return null; // null means no rewrite needed, use original URL
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

  // Use custom filename if set
  const finalName = settings.nextFilename || originalName;
  settings.nextFilename = null; // Clear after use

  const payload = {
    event_type: "telegram-upload",
    client_payload: {
      source_url: sourceUrl,
      filename: finalName,
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
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
}

// Handle bot username suffix in commands
function stripBotSuffix(text) {
  return text.replace(/@\w+/g, "");
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
        const channelInfo = `📢 Bot added to <b>${chat.title || "channel"}</b>\nChannel ID: <code>${chat.id}</code>\n\nAdd this as TELEGRAM_CHANNEL_ID secret in GitHub to enable auto-posting!`;
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

  const cleanText = stripBotSuffix(text);

  // ─── Command: /start ───
  if (cleanText === "/start") {
    await sendMessage(chatId, WELCOME, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /help ───
  if (cleanText === "/help" || cleanText === "/idk") {
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
    const ts = Date.now();
    await sendMessage(chatId, `🏓 Pong! Bot is alive.\nServer time: ${new Date().toISOString()}`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /subson ───
  if (cleanText === "/subson") {
    const settings = getUserSettings(chatId);
    settings.extractSubs = true;
    await sendMessage(chatId, "✅ Subtitle extraction <b>enabled</b>. Subtitles will be extracted from video files and uploaded separately.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /subsoff ───
  if (cleanText === "/subsoff") {
    const settings = getUserSettings(chatId);
    settings.extractSubs = false;
    await sendMessage(chatId, "❌ Subtitle extraction <b>disabled</b>. No subtitles will be extracted.", mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /status ───
  if (cleanText === "/status") {
    const settings = getUserSettings(chatId);
    const subsStatus = settings.extractSubs ? "✅ ON" : "❌ OFF";
    const channelStatus = CHANNEL_ID ? `✅ ${CHANNEL_ID}` : "❌ Not configured";
    const nextName = settings.nextFilename ? `✏️ ${settings.nextFilename}` : "➖ Default (from URL)";
    await sendMessage(chatId,
      `📊 <b>Current Settings</b>\n\n` +
      `Subtitle extraction: ${subsStatus}\n` +
      `MP4 conversion: ✅ ON (default)\n` +
      `Channel: ${channelStatus}\n` +
      `Next filename: ${nextName}\n\n` +
      `💡 Send a URL to upload!`,
      mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /channelid ───
  if (cleanText === "/channelid") {
    const chatType = message.chat.type;
    if (chatType === "channel" || chatType === "supergroup") {
      await sendMessage(chatId, `📢 This ${chatType}'s ID: <code>${chatId}</code>\n\nSet this as TELEGRAM_CHANNEL_ID in GitHub secrets to enable auto-posting!`);
    } else {
      await sendMessage(chatId, `📋 Your chat ID: <code>${chatId}</code>\n\nUse this command in a channel to get the channel ID. Or add the bot to your channel and it will auto-detect the ID.`);
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /rename <name> ───
  if (cleanText.startsWith("/rename ")) {
    const customName = cleanText.replace(/^\/rename\s+/, "").trim();
    if (!customName) {
      await sendMessage(chatId, "❌ Please provide a filename after /rename\nExample: <code>/rename my_video.mp4</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const settings = getUserSettings(chatId);
    settings.nextFilename = customName;
    await sendMessage(chatId, `✏️ Next upload will be named: <code>${customName}</code>\n\nSend your URL now! (Filename resets after one use)`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /info <url> ───
  if (cleanText.startsWith("/info ")) {
    const urlPart = cleanText.replace(/^\/info\s+/, "").trim();
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Please provide a valid URL after /info\nExample: <code>/info https://example.com/video.mkv</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    // We can't actually probe the URL from Vercel (serverless), but we can show what we know
    const filename = filenameFromUrl(urlPart);
    const ext = filename.split('.').pop().toLowerCase();
    const isVid = ['mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts'].includes(ext);
    await sendMessage(chatId,
      `ℹ️ <b>URL Info</b>\n\n` +
      `Filename: <code>${filename}</code>\n` +
      `Extension: <code>.${ext}</code>\n` +
      `Type: ${isVid ? '🎬 Video (will convert to MP4)' : '📄 File (will upload as-is)'}\n` +
      `Source: <code>${urlPart.slice(0, 80)}${urlPart.length > 80 ? '...' : ''}</code>\n\n` +
      `💡 Use /upload to process this URL!`,
      mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /upload <url> ───
  if (cleanText.startsWith("/upload ")) {
    const urlPart = cleanText.replace(/^\/upload\s+/, "").trim();
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Please provide a valid URL after /upload\nExample: <code>/upload https://example.com/video.mkv</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);
    try {
      await triggerUpload(sourceUrl, filename, chatId);
      const settings = getUserSettings(chatId);
      const nameNote = settings.nextFilename ? `` : ``;
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Downloading → Converting to MP4 → Uploading...\n⏳ This takes a few minutes for large files. I'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /raw <url> ───
  if (cleanText.startsWith("/raw ")) {
    const urlPart = cleanText.replace(/^\/raw\s+/, "").trim();
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
    await sendMessage(chatId, "📎 Paste your download link below, or use:\n<code>/upload URL</code> — convert to MP4\n<code>/raw URL</code> — no conversion\n<code>/rename name.mp4</code> — custom filename\n<code>/info URL</code> — probe video info", mainMenu());
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
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Downloading → Converting to MP4 → Uploading...\n⏳ This takes a few minutes for large files. I'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Non-URL text ───
  await sendMessage(chatId, "📎 Send a direct file URL (http(s)://...) and I'll download, convert, and upload it to storage.to.\n\nType /help for more info.", mainMenu());
  return res.status(200).json({ ok: true });
}
