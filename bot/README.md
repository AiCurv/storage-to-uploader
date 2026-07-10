# Streamtobuffer Bot (Vercel)

Telegram bot that turns any download link into a storage.to share link.

Flow:
1. User sends a URL (or `/start`, `/idk`) to `@Streamtobufferbot`.
2. Vercel webhook calls `repository_dispatch` on GitHub, kicking off `.github/workflows/upload.yml`.
3. The workflow downloads the file, uploads it to storage.to, then POSTs back to a Vercel API route with the result.
4. Vercel sends the storage.to link back to the user as a Telegram message.

## Required env (set on Vercel project + GitHub repo)

- `TELEGRAM_BOT_TOKEN` – same as GitHub secret.
- `TELEGRAM_ALLOWED_ID` – locks the bot to one Telegram user id.
- `STORAGE_TO_VISITOR_TOKEN` – shared with GitHub so the visitor identity matches.
- `VERCEL_PROJECT_URL` – e.g. `streamtobuffer.vercel.app`. Used by `/api/start` to set the webhook.
- `GITHUB_TOKEN` – fine-grained PAT with `contents: write` on `AiCurv/storage-to-uploader`, used to call `repository_dispatch`.
- `GITHUB_REPO` – `AiCurv/storage-to-uploader`.
- `SETUP_SECRET` – random string. Hit `GET /api/start?secret=...` after each deploy.

## Setup

1. `vercel link` (links this dir to a Vercel project).
2. `vercel env add TELEGRAM_BOT_TOKEN` (and all the others) for production + preview.
3. `vercel deploy --prod`.
4. Hit `https://<project>.vercel.app/api/start?secret=$SETUP_SECRET` once.
5. DM the bot a URL.
