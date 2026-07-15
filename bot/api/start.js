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
  // v8.4 FIX (per user): "only start one global command should auto-execute,
  //   others should come on my inline" — so ONLY /start is registered globally.
  //   All other functionality (upload, rename, status, help, about, ping) is
  //   exposed as INLINE BUTTONS in the /start reply. Users can still type
  //   /pixeldrain, /rename etc. manually if they know them, but they will NOT
  //   appear in the slash-menu autocomplete.
  //
  // Why: when 6 commands are global, tapping any of them from the "/" menu
  // fires the command immediately (auto-executes). The user wants a single
  // entry point (/start) that opens an inline button menu, so nothing happens
  // without an explicit button tap.
  const commands = [
    { command: "start", description: "Open main menu" },
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
        "📦 StreamToBuffer Bot — Tap /start to open the menu, then send any link and tap Upload to send it to PixelDrain (auto-splits >10GB) with Stream + Download buttons!\n\n" +
        "✨ Features:\n" +
        "• /start → inline button menu (Upload / Status / Help / About / Rename)\n" +
        "• Send any URL → [Upload] [Cancel] inline buttons (no auto-execute)\n" +
        "• Stream button — instant Gcore CDN stream (no download, no upload)\n" +
        "• Forwarded Telegram files supported\n\n" +
        "Tap /start to begin!",
    }),
  });

  // 4. Set short description (shown in chat list)
  await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      short_description: "📦 PixelDrain uploader + ▶️ Gcore CDN stream (tap /start)",
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
