// Telegram webhook entrypoint. Vercel invokes this on every incoming message.
//
// Commands:
//   /start          - Welcome message + main menu
//   /upload <url>   - Upload a file URL to storage.to
//   /raw <url>      - Same as /upload (kept for compatibility)
//   /status         - Current settings
//   /rename <name>  - Set custom filename for next upload
//   /help           - Detailed help message
//   /ping           - Bot latency check
//   /about          - About the bot
//
// Any direct URL sent as text auto-triggers upload.
// Forwarded files (documents, videos, audio, photos) will be detected and prompted.

const TELEGRAM_API = "https://api.telegram.org/bot" + (process.env.TELEGRAM_BOT_TOKEN || "");

const WELCOME = [
  "📦 <b>StreamToBuffer Bot</b>",
  "",
  "Send me any download link and I'll:",
  "  1️⃣ Download the file",
  "  2️⃣ Upload to storage.to",
  "  3️⃣ Send you the download link",
  "",
  "📝 <b>Commands:</b>",
  "/upload &lt;url&gt; — Upload link to storage.to",
  "/rename &lt;name&gt; — Set custom filename",
  "/status — Current settings",
  "/ping — Latency check",
  "/help — Detailed help",
  "",
  "💡 Works with ANY direct download link!",
  "📎 You can also forward files directly to me!",
].join("\n");

const HELP_MSG = [
  "📖 <b>StreamToBuffer Help</b>",
  "",
  "<b>How it works:</b>",
  "You send a download URL → I download it via GitHub Actions → Upload to storage.to → Send you the link.",
  "",
  "<b>Supported sources:</b>",
  "• Any direct download link (mp4, mkv, zip, etc.)",
  "• Pixeldrain links (auto-converted to API link)",
  "• hub.whistle.lat, hub.latent.click links",
  "• Any URL that serves file bytes directly",
  "",
  "<b>Forwarded files:</b>",
  "• Forward a file to me and I'll ask if you want a download link",
  "• Supports documents, videos, audio, photos",
  "",
  "<b>Commands:</b>",
  "/upload <url> — Upload a link",
  "/raw <url> — Same as /upload",
  "/rename <name> — Override filename for next upload",
  "/status — Current settings",
  "/ping — Check bot responsiveness",
  "/about — About this bot",
].join("\n");

const ABOUT_MSG = [
  "🤖 <b>StreamToBuffer Bot</b>",
  "",
  "Downloads any file link and uploads to storage.to for sharing.",
  "",
  "🔧 <b>Tech Stack:</b>",
  "• GitHub Actions (download + upload)",
  "• storage.to (file hosting, up to 25GB)",
  "• Vercel (bot webhook handler)",
  "",
  "⚡ <b>Features:</b>",
  "• Direct download passthrough — no conversion",
  "• Files up to 25GB supported",
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

async function answerCallbackQuery(callbackQueryId, text = "") {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🔗 Upload link" }, { text: "/status" }],
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

function stripBotSuffix(text) {
  return text.replace(/@\w+/g, "");
}

// ─── Extract file info from a Telegram message ───────────────

function extractFileInfo(message) {
  // Priority: document > video > audio > animation > voice > photo
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
    // photo is an array of sizes, pick the largest
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
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i > 0 ? 1 : 0)} ${u[i]}`;
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

  // Handle callback queries (inline keyboard button presses)
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || "";
    const chatId = String(cb.message?.chat?.id || cb.from?.id || "");

    if (data.startsWith("upload_file:")) {
      // User confirmed they want to upload a forwarded file
      const [, fileSourceUrl, fileName] = data.split(":", 3);
      const decodedUrl = decodeURIComponent(fileSourceUrl);
      const decodedName = decodeURIComponent(fileName || "file");

      await answerCallbackQuery(cb.id, "Starting upload...");
      try {
        await triggerUpload(decodedUrl, decodedName, chatId);
        await sendMessage(chatId, `⏬ Uploading <b>${decodedName}</b> to storage.to...\n⏳ I'll message you when done!`, mainMenu());
      } catch (err) {
        await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
      }
    } else if (data === "cancel_upload") {
      await answerCallbackQuery(cb.id, "Cancelled");
      await sendMessage(chatId, "❌ Upload cancelled.", mainMenu());
    }

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
  const fileInfo = extractFileInfo(message);
  if (fileInfo && !text.startsWith("/")) {
    // A file was forwarded/shared — prompt user
    const tgFileUrl = `tgfile:${fileInfo.file_id}:${fileInfo.file_name}`;
    const encodedUrl = encodeURIComponent(tgFileUrl);
    const encodedName = encodeURIComponent(fileInfo.file_name);
    const sizeStr = formatFileSize(fileInfo.file_size);

    await sendMessage(chatId,
      `📎 <b>File detected!</b>\n\n` +
      `Name: <code>${fileInfo.file_name}</code>\n` +
      `Size: ${sizeStr}\n` +
      `Type: ${fileInfo.type}\n\n` +
      `Do you want a storage.to download link for this file?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Yes, upload it", callback_data: `upload_file:${encodedUrl}:${encodedName}` },
              { text: "❌ Cancel", callback_data: "cancel_upload" },
            ],
          ],
        },
      }
    );
    return res.status(200).json({ ok: true });
  }

  if (!text) return res.status(200).json({ ok: true, ignored: "empty" });

  const cleanText = stripBotSuffix(text);

  // ─── Command: /start ───
  if (cleanText === "/start") {
    await sendMessage(chatId, WELCOME, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /help ───
  if (cleanText === "/help") {
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
    await sendMessage(chatId, `🏓 Pong! Bot is alive.\nServer time: ${new Date().toISOString()}`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /status ───
  if (cleanText === "/status") {
    const settings = getUserSettings(chatId);
    const nextName = settings.nextFilename ? `✏️ ${settings.nextFilename}` : "➖ Default (from URL)";
    await sendMessage(chatId,
      `📊 <b>Current Settings</b>\n\n` +
      `Next filename: ${nextName}\n\n` +
      `💡 Send a URL to upload!`,
      mainMenu());
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
    await sendMessage(chatId, `✏️ Next upload will be named: <code>${customName}</code>`, mainMenu());
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /upload <url> ───
  if (cleanText.startsWith("/upload ")) {
    const urlPart = cleanText.replace(/^\/upload\s+/, "").trim();
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Provide a valid URL after /upload\nExample: <code>/upload https://example.com/file.mkv</code>", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);
    try {
      await triggerUpload(sourceUrl, filename, chatId);
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Downloading → Uploading to storage.to...\n⏳ I'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Command: /raw <url> ─── (same as /upload now)
  if (cleanText.startsWith("/raw ")) {
    const urlPart = cleanText.replace(/^\/raw\s+/, "").trim();
    if (!looksLikeUrl(urlPart)) {
      await sendMessage(chatId, "❌ Provide a valid URL after /raw", mainMenu());
      return res.status(200).json({ ok: true });
    }
    const sourceUrl = normalizeSourceUrl(urlPart) || urlPart;
    const filename = filenameFromUrl(sourceUrl);
    try {
      await triggerUpload(sourceUrl, filename, chatId);
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Uploading...\n⏳ I'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Menu button: "🔗 Upload link" ───
  if (text === "🔗 Upload link") {
    await sendMessage(chatId, "📎 Paste your download link below, or use:\n<code>/upload URL</code> — upload to storage.to\n<code>/rename name.mp4</code> — custom filename", mainMenu());
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
      await sendMessage(chatId, `⏬ Queued <code>${filename}</code>\n🔄 Downloading → Uploading to storage.to...\n⏳ I'll message you when done!`, mainMenu());
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to queue: ${err.message}`, mainMenu());
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Non-URL text ───
  await sendMessage(chatId, "📎 Send a download URL and I'll upload it to storage.to.\n\nType /help for more info.", mainMenu());
  return res.status(200).json({ ok: true });
}
