// One-time bot bootstrap: registers the Telegram webhook with Vercel.
// Hit GET /api/start?secret=... after each deploy so the bot receives updates.
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
  const webhookUrl = `https://${vercelUrl}/api/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"] }),
  });
  const data = await r.json();
  return res.status(200).json({ ok: true, webhook: webhookUrl, telegram: data });
}
