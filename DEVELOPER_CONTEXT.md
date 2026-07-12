# DEVELOPER_CONTEXT.md — Memory for AI Agents

> **⚠️ READ THIS FILE FIRST before making any changes to this repository.**
> This file contains critical context about how the system works, past errors and their solutions,
> and architectural decisions. Without reading this, you WILL reproduce bugs that have already been fixed.

---

## Project Overview

**Repository**: `AiCurv/storage-to-uploader`
**Purpose**: A Telegram bot that downloads any file from a URL and uploads it to storage.to, then sends the download link back to the user.
**Live Bot**: `@Streamtobufferbot` on Telegram
**Vercel App**: `storage-to-uploader.vercel.app`

## Architecture

```
User → Telegram Bot (@Streamtobufferbot)
  → Vercel webhook (/api/webhook) detects URL or forwarded file
  → Triggers GitHub Actions via repository_dispatch
  → GitHub Actions runs upload.mjs:
     1. Downloads file from URL (curl)
     2. Uploads to storage.to (multipart for >50MB)
     3. Gets storage.to HTML link
  → GitHub Actions calls Vercel /api/result with the link
  → Vercel sends the storage.to link to user via Telegram
```

## Key Components

| File | Purpose |
|------|---------|
| `upload.mjs` | Main upload script — downloads file, uploads to storage.to, outputs JSON result |
| `bot/api/webhook.js` | Vercel serverless — handles Telegram messages, detects URLs and forwarded files |
| `bot/api/result.js` | Vercel serverless — receives upload result from GitHub Actions, sends link to user |
| `bot/api/start.js` | Vercel serverless — health check endpoint |
| `bot/vercel.json` | Vercel routing config |
| `.github/workflows/telegram.yml` | GitHub Actions workflow triggered by repository_dispatch from webhook |
| `.github/workflows/upload.yml` | GitHub Actions workflow triggered manually (workflow_dispatch) |

## API Details

### storage.to API
- **Base**: `https://storage.to/api`
- **No API key needed** for anonymous uploads
- **Max file size**: 25 GB per file
- **Upload flow**:
  1. `POST /api/upload/init` — `{ filename, content_type, size }` → returns `{ type: "single"|"multipart", upload_url, r2_key, ... }`
  2. For single (<50MB): `PUT upload_url` with file bytes
  3. For multipart: `POST /api/upload/parts` → returns `{ urls: { "1": "...", "2": "..." } }` (NOT `part_urls` array!)
  4. `POST /api/upload/complete-multipart` with `{ upload_id, parts: [{ partNumber, etag }] }`
  5. `POST /api/upload/confirm` — `{ filename, size, content_type, r2_key }` → returns `{ file: { url, raw_url, ... } }`
- **Key URLs**: `file.url` = HTML page, `file.raw_url` = direct download
- **Visitor token**: `X-Visitor-Token` header for tracking ownership
- **Docs**: https://storage.to/llms.txt

### Telegram Bot API
- Bot token in Vercel env (`TELEGRAM_BOT_TOKEN`) and GitHub secrets
- File download: `getFile` → `https://api.telegram.org/file/bot<token>/<file_path>`
- **20MB limit** for `/getFile` — larger files cannot be downloaded by bots this way
- Channel: `curvstorage` (-1003990524943) — currently NOT used for file uploads (just sends link text)

## CRITICAL Errors & Solutions (DO NOT REPEAT!)

### 1. ERR_FS_FILE_TOO_LARGE — Node.js readFileSync >2GB
**Error**: `RangeError [ERR_FS_FILE_TOO_LARGE]: File size (15802354518) is greater than 2 GiB`
**Cause**: `readFileSync(filePath, { start, end })` still allocates a buffer for the FULL file size, even with start/end range
**Fix**: Use `createReadStream(filePath, { start, end })` instead — streams only the needed bytes
**File**: upload.mjs line ~110 (multipart upload loop)

### 2. `more.part_urls is not iterable` — Wrong API response format
**Error**: `TypeError: more.part_urls is not iterable`
**Cause**: storage.to `/upload/parts` API returns `{ success: true, urls: { "51": "...", "52": "..." } }` — an OBJECT with part number keys, NOT an array called `part_urls`
**Fix**: Changed to `Object.entries(more.urls || {})` instead of iterating `more.part_urls`
**File**: upload.mjs line ~100

### 3. Torrent/magnet support ABANDONED
**Problem**: Aria2 torrent download in GitHub Actions took 13+ minutes and timed out
**Decision**: Removed ALL torrent/magnet/Aria2 logic. Direct download links ONLY.
**Files**: All workflow files, upload.mjs, webhook.js — no torrent references remain

### 4. FFmpeg conversion REMOVED
**Problem**: FFmpeg conversion of 12GB+ MKV files took 30+ minutes in GitHub Actions. Also, storage.to doesn't support streaming for large files anyway.
**Decision**: Removed ALL FFmpeg, subtitle extraction, thumbnail generation. Just raw passthrough upload.
**Files**: upload.mjs (stripped from 580 lines to ~270), workflows (removed FFmpeg install step)

### 5. Channel uploads sent HTML text instead of actual files
**Problem**: Bot was sending just a text message with links to the channel, not the actual file
**Context**: User wanted the actual file uploaded to the channel. BUT:
- Telegram Bot API has 20MB download limit via `/getFile`
- Uploading 15GB files to Telegram is impossible via bot API
- Even `sendVideo` with 2GB limit requires downloading the file first
**Decision**: Removed channel file upload entirely. Bot just sends the storage.to link. The user can download from storage.to directly.

### 6. Pixeldrain HTML vs raw file download
**Problem**: Pixeldrain `/u/<id>` and `/d/<id>` return HTML pages, not raw files
**Fix**: Rewrite to `/api/file/<id>` which serves raw bytes
**File**: upload.mjs `resolveSource()`, webhook.js `normalizeSourceUrl()`

### 7. BOT_VERIFY_TOKEN mismatch between GitHub and Vercel
**Problem**: The BOT_VERIFY_TOKEN in Vercel env was longer than what was set in GitHub secrets
**Full token**: `787010dec8c8821b808e519f15c5d016b263640d59e06e68116ae5d9b32c5ef5` (64 hex chars)
**Fix**: Updated GitHub secret to match Vercel env exactly

### 8. Vercel rootDirectory wrong
**Problem**: Vercel project had `rootDirectory: "bot"` but was initially set to None
**Fix**: Set rootDirectory to "bot" in Vercel project settings

## Environment Variables & Secrets

### Vercel Env
- `TELEGRAM_BOT_TOKEN` — Bot token
- `TELEGRAM_ALLOWED_ID` — User chat ID (6404893345) — hard-locks bot to this user
- `BOT_VERIFY_TOKEN` — Shared secret for GitHub Actions → Vercel callback
- `GH_TOKEN` — GitHub token for triggering dispatches
- `GITHUB_REPO` — "AiCurv/storage-to-uploader"
- `STORAGE_TO_VISITOR_TOKEN` — Token for storage.to upload ownership

### GitHub Secrets
- `TELEGRAM_BOT_TOKEN` — Same as Vercel
- `BOT_VERIFY_TOKEN` — Must match Vercel's exactly (64 hex chars)
- `VERCEL_CALLBACK_URL` — `https://storage-to-uploader.vercel.app/api/result`
- `STORAGE_TO_VISITOR_TOKEN` — Same as Vercel
- `TELEGRAM_CHANNEL_ID` — `-1003990524943` (curvstorage channel)
- `TELEGRAM_ALLOWED_ID` — `6404893345`

## Multipart Upload Optimization

For files >50MB, storage.to requires multipart upload:
- Part size: ~33.5MB (33554432 bytes)
- 15GB file = ~471 parts
- **All part URLs are prefetched upfront** in batches of 50 via `/upload/parts`
- **3 concurrent uploads** via `Promise.all` for speed
- Total upload time for 15GB: ~12-15 minutes (sequential was ~16 min)

## Telegram File Forwarding

When a user forwards a file (document, video, audio, photo) to the bot:
1. webhook.js detects the file via `extractFileInfo(message)` 
2. Creates a virtual URL: `tgfile:<file_id>:<filename>`
3. Shows inline keyboard: "Yes, upload it" / "Cancel"
4. On confirmation, triggers upload with the `tgfile:` URL
5. upload.mjs detects `tgfile:` prefix, downloads from Telegram Bot API, uploads to storage.to

**Limitation**: Telegram Bot API `/getFile` has a **20MB download limit**. Files larger than 20MB forwarded to the bot cannot be downloaded this way. The user should share download links instead.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + main menu |
| `/upload <url>` | Upload link to storage.to |
| `/raw <url>` | Same as /upload (kept for compatibility) |
| `/rename <name>` | Set custom filename for next upload |
| `/status` | Current settings |
| `/ping` | Latency check |
| `/help` | Detailed help |
| `/about` | About the bot |

URLs sent as plain text are auto-detected and uploaded without needing a command.

## Update Log

### v5.0 (2026-07-12)
- Stripped ALL FFmpeg, conversion, subtitle extraction, thumbnail generation
- Removed channel file upload (just sends link)
- Fixed ERR_FS_FILE_TOO_LARGE by using createReadStream instead of readFileSync
- Fixed /upload/parts API response format (urls object vs part_urls array)
- Added 3x concurrent multipart upload
- Added Telegram file forwarding with inline keyboard prompt
- Prefetch all part URLs upfront for speed
- **TESTED SUCCESSFULLY**: 15.07GB MKV uploaded from hub.whistle.lat → storage.to/EU5xZI1O1
