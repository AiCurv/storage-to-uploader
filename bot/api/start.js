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
  // ⚠️ v7.7 FIX: previously `allowed_updates` was missing `callback_query`, which caused
  // ALL inline keyboard button taps to be silently filtered out by Telegram. The user
  // would see "loads forever" / "bot isn't responding" on every tap. Including
  // `callback_query` here is mandatory for the inline picker to work.
  const webhookUrl = `https://${vercelUrl}/api/webhook`;
  const wh = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "callback_query",
        "my_chat_member",
        "chat_member",
      ],
    }),
  });
  results.webhook = { url: webhookUrl, telegram: await wh.json() };

  // 2. Set bot commands menu
  const commands = [
    { command: "stream", description: "🚀 Instant CDN stream (Gcore)" },
    { command: "upload", description: "Upload link (asks which service)" },
    { command: "pixeldrain", description: "Upload to pixeldrain (auto-splits >10GB)" },
    { command: "filekiwi", description: "Upload to file.kiwi (up to 999 GiB)" },
    { command: "service", description: "Show / change default service" },
    { command: "raw", description: "Same as /upload" },
    { command: "rename", description: "Set custom filename for next upload" },
    { command: "status", description: "Check current settings" },
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
        "🎬 StreamToBuffer Bot — Send me any file link and I'll either 🚀 stream it via Gcore CDN, or 📦 upload it to pixeldrain / file.kiwi!\n\n" +
        "✨ Features:\n" +
        "• 🚀 /stream URL — instant CDN stream (no download, no upload)\n" +
        "• 📦 /upload URL — pick service via inline button\n" +
        "• pixeldrain: persistent, max 10GB/file (auto-splits larger)\n" +
        "• file.kiwi: anonymous, up to 999 GiB, 90h retention\n" +
        "• Forwarded Telegram files supported\n\n" +
        "Just send a URL to get started!",
    }),
  });

  // 4. Set short description (shown in chat list)
  await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      short_description: "🚀 Instant CDN stream + 📦 file uploader (Gcore / pixeldrain / file.kiwi)",
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
