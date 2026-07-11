// One-time bot bootstrap: registers the Telegram webhook with Vercel
// and sets up the bot command menu.
// Hit GET /api/start?secret=... after each deploy.
export default async function handler(req, res) {
  const expected = process.env.SETUP_SECRET || "changeme";
  if (req.query.secret !== expected) {
    return res.status(403).json({ error: "forbidden" });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const vercelUrl = process.env.VERCEL_PROJECT_URL;
  if (!token || !vercelUrl) {
    return res.status(500).json({ error: "missing env" });
  }

  const results = {};

  // 1. Set webhook
  const webhookUrl = `https://${vercelUrl}/api/webhook`;
  const wh = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "channel_post", "my_chat_member"],
    }),
  });
  results.webhook = { url: webhookUrl, telegram: await wh.json() };

  // 2. Set bot commands menu
  const commands = [
    { command: "upload", description: "Upload & convert video to MP4" },
    { command: "raw", description: "Upload without conversion" },
    { command: "info", description: "Get video info without uploading" },
    { command: "rename", description: "Set custom filename for next upload" },
    { command: "subson", description: "Enable subtitle extraction" },
    { command: "subsoff", description: "Disable subtitle extraction" },
    { command: "status", description: "Check current settings" },
    { command: "channelid", description: "Get channel ID for auto-posting" },
    { command: "ping", description: "Check bot latency" },
    { command: "about", description: "About this bot" },
    { command: "help", description: "Detailed help & info" },
  ];
  const cmdRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  results.commands = await cmdRes.json();

  // 3. Set bot description (shown in profile)
  await fetch(`https://api.telegram.org/bot${token}/setMyDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description:
        "🎬 StreamToBuffer Bot v2.0 — Send me any video link and I'll convert it to streamable MP4, extract subtitles, and upload to storage.to!\n\n" +
        "✨ Features:\n" +
        "• MKV/AVI/MOV/WebM → MP4 conversion\n" +
        "• Subtitle extraction (SRT/ASS/VTT)\n" +
        "• Streaming CDN link + HTML page\n" +
        "• Auto-post to your channel\n" +
        "• Supports files up to 5GB+\n\n" +
        "Just send a URL to get started!",
    }),
  });

  // 4. Set short description (shown in chat list)
  await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      short_description: "Video → MP4 converter & uploader with streaming links",
    }),
  });

  // 5. Set menu button (opens command list)
  await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      menu_button: { type: "commands" },
    }),
  });

  return res.status(200).json({ ok: true, ...results });
}
