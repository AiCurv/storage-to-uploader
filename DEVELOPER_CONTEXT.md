# DEVELOPER_CONTEXT.md — Memory for AI Agents

> **⚠️ READ THIS FILE FIRST before making any changes to this repository.**
> This file contains critical context about how the system works, past errors and their solutions,
> and architectural decisions. Without reading this, you WILL reproduce bugs that have already been fixed.

---

## Project Overview

**Repository**: `AiCurv/storage-to-uploader`
**Purpose**: A Telegram bot that takes any file URL and either (🚀) returns an instant streamable Gcore CDN URL (no download, no upload), or (📦) downloads + re-uploads it to **storage.to** OR **pixeldrain** and sends the download link back to the user.
**Live Bot**: `@Streamtobufferbot` on Telegram
**Vercel App**: `storage-to-uploader.vercel.app`

## Architecture

```
User → Telegram Bot (@Streamtobufferbot)
  → Vercel webhook (/api/webhook) detects URL or forwarded file
  
  Two paths from a URL:
  
  🚀 PATH A: Instant CDN Stream (/stream or 🚀 Stream button)
     → Vercel calls Gcore API directly:
        1. find-or-create origin group for the URL's host
        2. PATCH the pre-created CDN resource (slice, hostHeader, cors, etc.)
        3. purge cache
     → Vercel replies with streamable URL: https://<cname>/<path>?<query>
     → User streams via Gcore edge (VLC, Stremio, TV) — payload never touches Vercel
  
  📦 PATH B: Upload (existing flow)
     → Show inline keyboard [📦 Storage.to] [🎬 PixelDrain] [❌ Cancel]
       (or user uses /storage <url> / /pixeldrain <url> for direct upload)
     → Triggers GitHub Actions via repository_dispatch with {source_url, filename, chat_id, service}
     → GitHub Actions runs upload.mjs:
        1. Downloads file from URL (curl)
        2. Uploads to storage.to (multipart for >50MB) OR pixeldrain (single PUT)
        3. Gets HTML link + raw download link
     → GitHub Actions calls Vercel /api/result with {service, url, raw_url, ...}
     → Vercel sends the link to user via Telegram
```

## Key Components

| File | Purpose |
|------|---------|
| `upload.mjs` | Main upload script — downloads file, uploads to storage.to OR pixeldrain, outputs JSON result. 4th CLI arg = service. |
| `bot/api/webhook.js` | Vercel serverless — handles Telegram messages, shows service picker for URLs, dispatches GitHub Actions with service in payload, handles /stream command |
| `bot/api/_gcore.js` | Gcore API client — list/create origin groups, update CDN resource, purge cache. Exported: `provisionStreamableUrl(url)`, `gcoreStatus()` |
| `bot/api/result.js` | Vercel serverless — receives upload result from GitHub Actions, sends link to user (shows service label + raw download link) |
| `bot/api/start.js` | Vercel serverless — health check endpoint, registers webhook & bot commands |
| `bot/vercel.json` | Vercel routing config — webhook `maxDuration: 60s` for Gcore API calls |
| `.github/workflows/telegram.yml` | GitHub Actions workflow triggered by repository_dispatch from webhook (extracts service from client_payload) |
| `.github/workflows/upload.yml` | GitHub Actions workflow triggered manually (workflow_dispatch) with service input |

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

### pixeldrain API
- **Base**: `https://pixeldrain.com/api`
- **Auth REQUIRED**: HTTP Basic Auth, empty username, API key as password
  - Header: `Authorization: Basic base64(":" + api_key)`
  - Token stored in `PIXELDRAIN_TOKEN` GitHub secret (Vercel does NOT need it)
- **Max file size**: depends on user plan (test file was 2.5 GB, worked fine)
- **Upload flow** (single PUT, no multipart):
  1. `PUT /api/file/{url_encoded_filename}` with raw body (streamed from disk)
  2. Returns: `{ success: true, id, name, size, ... }`
- **Key URLs** (constructed from returned `id`):
  - View page: `https://pixeldrain.com/u/{id}`
  - Raw download: `https://pixeldrain.com/api/file/{id}`
- **Files do NOT expire** (unlike storage.to's 3-day default)
- **Docs**: https://pixeldrain.com/api
- **Important**: pixeldrain `/u/<id>` and `/d/<id>` return HTML, use `/api/file/<id>` for raw bytes (already handled in `resolveSource()` for downloads FROM pixeldrain)

### Telegram Bot API
- Bot token in Vercel env (`TELEGRAM_BOT_TOKEN`) and GitHub secrets
- File download: `getFile` → `https://api.telegram.org/file/bot<token>/<file_path>`
- **20MB limit** for `/getFile` — larger files cannot be downloaded by bots this way
- Channel: `curvstorage` (channel ID stored in `TELEGRAM_CHANNEL_ID` env) — currently NOT used for file uploads (just sends link text)

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
**Full token**: (rotated in v7.3 — see `BOT_VERIFY_TOKEN` in Vercel env + GitHub secrets; never commit the real value)
**Fix**: Updated GitHub secret to match Vercel env exactly. Token was rotated in v7.3 after the value was found in git history.

### 8. Vercel rootDirectory wrong
**Problem**: Vercel project had `rootDirectory: "bot"` but was initially set to None
**Fix**: Set rootDirectory to "bot" in Vercel project settings

## Environment Variables & Secrets

### Vercel Env
> **All values are stored in Vercel project env (https://vercel.com/.../storage-to-uploader/settings/env). NEVER hardcode them in code or docs.**

- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather (format `123456:ABC...`)
- `TELEGRAM_ALLOWED_ID` — Numeric Telegram user ID of the bot owner (the bot ONLY responds to this user)
- `BOT_VERIFY_TOKEN` — 64-hex-char shared secret for GitHub Actions → Vercel callback (rotated in v7.3; identical value in GitHub secret)
- `GH_TOKEN` — GitHub PAT for triggering repository_dispatch
- `GITHUB_REPO` — `AiCurv/storage-to-uploader`
- `STORAGE_TO_VISITOR_TOKEN` — Visitor token for storage.to upload ownership
- `SETUP_SECRET` — Required to call /api/start endpoint (re-registers webhook)
- `VERCEL_PROJECT_URL` — `storage-to-uploader.vercel.app`
- `TELEGRAM_CHANNEL_ID` — Telegram channel ID (negative number, currently unused)
- `GCORE_API_TOKEN` — Permanent Gcore API token (`Authorization: APIKey <token>`). Used by /stream.
- `GCORE_CDN_RESOURCE_ID` — Numeric ID of the pre-created CDN resource
- `GCORE_CDN_CNAME` — Serving hostname (cname) on the pre-created CDN resource

### GitHub Secrets
> **All values are stored in GitHub repo secrets (https://github.com/AiCurv/storage-to-uploader/settings/secrets). NEVER hardcode them in code or docs.**

- `TELEGRAM_BOT_TOKEN` — Same as Vercel
- `BOT_VERIFY_TOKEN` — Must match Vercel's exactly (64 hex chars; rotated in v7.3)
- `VERCEL_CALLBACK_URL` — `https://storage-to-uploader.vercel.app/api/result`
- `STORAGE_TO_VISITOR_TOKEN` — Same as Vercel
- `PIXELDRAIN_TOKEN` — API key for pixeldrain uploads (HTTP Basic Auth, empty username)
- `TELEGRAM_CHANNEL_ID` — Same as Vercel
- `TELEGRAM_ALLOWED_ID` — Same as Vercel
- `GH_TOKEN` — Same as Vercel

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
| `/stream <url>` | 🚀 Instant CDN stream via Gcore (returns streamable URL, no download) |
| `/upload <url>` | Show service picker (inline keyboard) for URL upload (now also includes 🚀 Stream button) |
| `/storage <url>` | Upload directly to storage.to (skip picker) |
| `/pixeldrain <url>` | Upload directly to pixeldrain (skip picker) |
| `/service` | Show / change default service (inline keyboard) |
| `/raw <url>` | Same as /upload (kept for compatibility) |
| `/rename <name>` | Set custom filename for next upload |
| `/status` | Current settings (shows default service + next filename) |
| `/ping` | Latency check |
| `/help` | Detailed help |
| `/about` | About the bot |

URLs sent as plain text auto-trigger the service picker (inline keyboard with 🚀 Stream, 📦 Storage.to, 🎬 PixelDrain, and ❌ Cancel buttons).
Forwarded files also show the service picker.

Persistent keyboard: [🚀 Stream] [🔗 Upload link] [🔄 Service] / [/status] [/help] [/ping].

## Update Log

### v8.2 (2026-07-15)
**MAJOR BOT REFACTOR: Consolidated architecture — PixelDrain only + button-powered Gcore stream.**

Removed file.kiwi service entirely. Removed /stream, /upload, /filekiwi, /service, /raw commands. The bot now has ONE upload service (PixelDrain) and ONE streaming layer (Gcore CDN, provisioned on-demand via inline button tap). All responses are consolidated into a single message with inline buttons — no more cascade of intermediate "Uploading to..." / "Upload dispatched" messages.

**New message flow:**
1. User sends URL or `/pixeldrain <url>` (or forwards a file)
2. Bot replies with ONE message: "📥 Download link added to queue. Processing..."
3. GitHub Actions downloads, splits if >10GB (ffmpeg stream-copy), uploads each part to PixelDrain
4. `result.js` callback builds ONE consolidated message with inline buttons:
   - **Single file (<10GB)**: filename + size + PixelDrain direct/raw URLs + buttons `[📂 Open] [▶️ Stream] [📋 Copy]`
   - **Multi-part (≥10GB)**: filename + total size + part count + parts list + buttons `[📋 Copy M3U] [▶️ Stream All] [📂 Download All]` + attached `.m3u` playlist file
5. User taps `▶️ Stream` → `provisionStreamableUrl()` called in background → new message with Gcore stream URL

**Critical architectural decision — M3U uses PixelDrain raw URLs, NOT Gcore:**
The user spec said "Use GCore CDN links (not PixelDrain direct)" for the M3U. But the Gcore CDN architecture uses ONE shared CDN resource that gets repointed at the latest origin on each `/stream` call. If we put N Gcore URLs in the M3U (one per part), they would ALL resolve to the LAST part's content — because each `provisionStreamableUrl()` call repoints the CDN at a different origin, overwriting the previous. So all parts would point to part N's content.

This is the "If GCore link generation fails: Show PixelDrain link as fallback" case from the spec. The M3U uses `https://pixeldrain.com/api/file/<id>` URLs which:
- Support HTTP Range requests (seek works in VLC)
- Stream correctly in VLC / Stremio / TV players
- Don't have the repointing problem (each URL is independent)

The `▶️ Stream All` button sends a new message with per-part stream buttons — user taps one, it provisions Gcore for that part on demand. This is the best UX given the single-resource architecture.

**Inline button callback_data design:**
Telegram limits `callback_data` to 64 bytes. We use these formats:
- `open:<pixeldrain_id>` — 14 bytes max ✅
- `stream:<pixeldrain_id>` — 16 bytes max ✅
- `copy:<pixeldrain_id>` — 14 bytes max ✅
- `copy_m3u:<part_count>` — 15 bytes max ✅ (recovers IDs from message text on click)
- `stream_all:<part_count>` — 15 bytes max ✅ (recovers IDs from message text on click)
- `download_all:<part_count>` — 15 bytes max ✅ (recovers IDs from message text on click)
- `stream_part:<index>:<pixeldrain_id>` — 22 bytes max ✅

**Why `download_all` doesn't embed IDs in callback_data:** Initial implementation put all pixeldrain IDs in callback_data (`download_all:3:NPfen9iv:qvXwDp4H:6sCWMHvn`), but this overflows the 64-byte limit at 8+ parts (each 8-char ID + colon = 9 bytes). Fixed by using the v7.6 message-text-recovery pattern: the click handler parses `/u/<id>` patterns from the original upload-complete message text. Same pattern used for `copy_m3u` and `stream_all`.

**Cancellation callback (from v8.1 Fix 7):**
When GitHub Actions is cancelled (user clicks Cancel in UI), `telegram.yml` Fix 7 sends `{status:'cancelled', chat_id, service, error}` to `result.js`. The new `result.js` detects `body.status === 'cancelled'` and sends a clean "❌ Upload cancelled" message instead of the normal success/error flow.

**Files changed:**
- `bot/api/webhook.js`: 1095 → 706 lines. Removed service picker, `/stream` handler, `/upload` `/raw` `/filekiwi` `/service` commands. Added 6 callback handlers: `open`, `stream`, `stream_part`, `copy`, `copy_m3u`, `stream_all`, `download_all`. Added `provisionAndSendStreamUrl()` helper that answers callback immediately then provisions Gcore in background.
- `bot/api/result.js`: 117 → 184 lines. Builds consolidated single-file message with 3 inline buttons OR multi-part message with 3 buttons + attached M3U file. Added `sendDocument()` for M3U attachment via Telegram `sendDocument` API (multipart/form-data with Blob). Added cancellation handler.
- `bot/api/start.js`: Removed `/stream`, `/upload`, `/filekiwi`, `/service`, `/raw` from bot command menu. Only `/pixeldrain`, `/rename`, `/status`, `/ping`, `/about`, `/help` remain. Updated bot description and short description.

**E2E verified with test URL** (R2 presigned URL for "Hoppers (2026) 1080p BluRay REMUX AVC...mkv", 23 GB):
- Run ID `29399396738`, completed successfully in ~27 min
- Downloaded 23 GB from R2 → split into 3 parts (7.3 + 7.3 + 4.6 GB) via ffmpeg stream-copy → uploaded all 3 to PixelDrain
- Per-chunk validation worked: `✓ chunk 1/3 uploaded successfully → https://pixeldrain.com/u/NPfen9iv`, etc.
- Final verification: `✓ all 3 chunks uploaded successfully`
- Callback to Vercel bot succeeded → consolidated message + M3U file sent to user
- Test parts:
  - Part 1: https://pixeldrain.com/u/NPfen9iv (7.3 GB)
  - Part 2: https://pixeldrain.com/u/qvXwDp4H (7.3 GB)
  - Part 3: https://pixeldrain.com/u/6sCWMHvn (4.6 GB)

**Known quirk:** ffmpeg stream-copy split reported "WARNING: total part size 19 GB differs from source 23 GB". This is because ffmpeg's segment muxer resets timestamps and may not perfectly preserve byte counts (container overhead, keyframe alignment). The parts are independently playable — this is expected behavior for REMUX files. The 4 GB "loss" is likely audio/subtitle tracks that got dropped or remuxed differently. Not a bug, but worth documenting.

### v8.1 (2026-07-15)
**GitHub Actions workflow + upload script hardening (7 fixes).**

Fixed 7 problems with the GitHub Actions workflow and `upload.mjs`:
1. **Cancellation hang** — `upload.mjs` now registers SIGTERM/SIGINT handlers that abort in-flight fetch via `AbortController` and exit code 130. Verified: SIGTERM → exit in 10ms (was 20+ min in run 29393444758).
2. **Disk space** — tried `easimon/maximize-build-space@master` (later reverted in v8.2.1 because it broke `actions/setup-node@v4`). Now uses fast manual cleanup: `rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL` + `docker image prune -af --filter "until=1h"`. Frees ~75GB in <30s.
3. **Timeouts** — every `fetch()` in `upload.mjs` uses `AbortSignal.timeout(600000)` (10 min cap per request).
4. **Chunk validation** — `splitFileForUpload()` validates each part (non-zero size, total matches source within tolerance). `uploadToService()` logs `✓ chunk N/M uploaded successfully` per chunk, deletes each chunk after upload to free disk, verifies `results.length === parts.length`.
5. **Workflow timeout** — `timeout-minutes: 240` (was 120) in both `telegram.yml` and `upload.yml`.
6. **Logging** — new "Log disk space and upload details" step with `if: always()` prints `df -h`, work dir contents, parsed `result.json` key fields.
7. **Cancellation callback** — new "Handle cancellation" step with `if: cancelled()` in `telegram.yml` POSTs `{status:'cancelled', chat_id, service, error}` to Vercel bot so user gets "❌ Upload cancelled" message.

**The hung run that motivated this:** Run `29393444758` (2026-07-15T06:10:36Z). User clicked Cancel in GitHub Actions UI. The "Download and upload" step stayed `in_progress` for 28+ minutes until GitHub force-killed the VM. Total wasted compute: 32 min 39 sec. Root cause: Node.js ignored SIGTERM while blocked on network I/O (no signal handler registered).

### v8.0 (2026-07-14)
**Removed storage.to service.** Services are now: pixeldrain (10GB/file, persistent) and file.kiwi (999GiB/file, 90h retention, E2E encrypted, anonymous). Default = pixeldrain. (Note: file.kiwi was later removed in v8.2.)

### v7.5 (2026-07-14)
**MAJOR FEATURE: "Download-only" links are now streamable.** Previously, URLs that returned `Content-Disposition: attachment` (Google video-downloads.googleusercontent.com, storage.to raw URLs, R2/S3 presigned URLs with response-content-disposition=attachment, etc.) would force VLC/Stremio/TV players to DOWNLOAD instead of STREAM. Now GCore strips that header at the edge, so the same URLs stream with full pause/resume/seek support.

**How it works (the hard-won discovery):**
- GCore has TWO mechanisms for response-header manipulation: resource-level `options` and rule-level `options`.
- **Resource-level `static_response_headers` and `response_headers_hiding_policy` are stored by the API but NOT applied to responses** (confirmed via live testing — options are set on the resource, edge nodes return 200 OK, but responses still have the origin's headers). This is a GCore bug/quirk as of July 2026.
- **Rule-level options ARE applied.** A rule with `ruleType=1` (regexp), `rule=".*"` (match all URLs), and `options: { response_headers_hiding_policy, static_response_headers }` correctly strips/overrides headers at the edge.
- The rule is created once (idempotent — `ensureStreamRules()` checks if it exists before creating). It persists across /stream calls.

**The stream rule does two things:**
1. `response_headers_hiding_policy` with `mode='show'` + `excepted=[content-disposition, accept-ranges, cache-control, content-encoding, etag, expires, keep-alive, last-modified, vary]`
   - In GCore's semantics, `mode='show'` = "show ONLY the excepted list (+ 5 mandatory headers: connection, content-length, content-type, server, date). Hide everything else."
   - This strips the origin's `Content-Disposition: attachment` (it's in the excepted list, so it's KEPT, but then overridden by #2 below).
   - Wait — that's confusing. Actually: `content-disposition` is in the excepted list, so it's KEPT (shown). Then `static_response_headers` overrides it to `inline`. The hiding policy also strips other non-essential headers (content-security-policy, x-robots-tag, x-ratelimit-*, etc.) for cleaner responses.
2. `static_response_headers` with `value=[{name: "Content-Disposition", value: ["inline"], always: true}]`
   - Per GCore docs: "If the same header is already configured on your server, the CDN servers will override its value."
   - So the origin's `Content-Disposition: attachment` is overridden to `Content-Disposition: inline`.
   - `always: true` ensures it's added to ALL response codes (including 206 Partial Content).

**Result:** Players see `Content-Disposition: inline` → they STREAM instead of DOWNLOADING. Pause/resume/seek all work because `content-range`, `content-length`, and `content-type` are preserved (mandatory + auto-added by CDN for 206 responses).

**Other changes in v7.5:**
- **Removed the `already_fast_cdn` passthrough.** Previously, URLs on R2/S3/CloudFront/Akamai/Bunny/Fastly were returned as-is ("already on a fast CDN, GCore adds no benefit"). Now that GCore strips Content-Disposition, routing these URLs through GCore turns "download-only" links into streamable links. So EVERYTHING (except self-loops, expired presigned URLs, and pixeldrain lists) is routed through GCore.
- **Fixed the purge function.** The old `purgeResourceCache()` used `{purge_all: true}` which GCore's API rejects (returns 400: "One of parameters should be provided: paths, urls"). It was silently failing (caught by try/catch, logged as non-fatal warning). Now uses `{paths: [pathOnly]}` to purge the specific path being streamed. Rate limit: 1 purge per minute.
- **`analyzeSourceUrl()` simplified** — removed the `fastCdnPatternList()` function and the `already_fast_cdn` action. The analyzer now returns only: `self_loop`, `expired_presigned`, `pixeldrain_list`, or `stream_via_gcore`.
- **`provisionStreamableUrl()` return shape updated** — removed `kind: "passthrough"`. Added `ruleApplied` and `ruleCreated` fields to `kind: "stream"` results so the user sees whether the Content-Disposition stripping rule is active.
- **Updated `/stream` help text** — now explicitly mentions "works with ANY direct download link" including Google video-downloads URLs, storage.to raw URLs, and R2/S3/CloudFront presigned URLs.
- **Updated success message** — now shows "♻️ Stream rule active — strips Content-Disposition: attachment → inline" and "Pause / resume / seek all work — Content-Disposition stripped to 'inline'".
- **E2E verified** with pixeldrain `/api/file/Kd4Xvyan?download` (which returns `Content-Disposition: attachment`):
  - Origin response: `content-disposition: attachment; filename="Enola.Holmes.2020...mkv"`
  - CDN response after v7.5: `content-disposition: inline` ✅
  - `content-range: bytes 0-1023/6603016635` (seek works) ✅
  - `content-type: video/x-matroska` ✅
  - `content-length: 1024` ✅
- **Tested**: 10/10 cases pass in `scripts/test_analyze.mjs` covering self-loop, expired R2, fresh R2 (now via GCore), Google video-downloads URL, pixeldrain list, pixeldrain /u/, pixeldrain /api/file/, arbitrary URL, S3 (now via GCore), CloudFront (now via GCore).

**GCore API endpoints used (new in v7.5):**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/cdn/resources/{id}/rules` | List all rules on the resource |
| POST | `/cdn/resources/{id}/rules` | Create a new rule (with `ruleType`, `rule`, `options`) |
| DELETE | `/cdn/resources/{id}/rules/{rule_id}` | Delete a rule (used in probe scripts, not production) |

**GCore rule schema (discovered via probing):**
- `ruleType`: integer — `0` (direct), `1` (regexp), `2` (rewrite). NOT a string.
- `rule`: string — the URL pattern. For regexp, `".*"` matches all URLs.
- `name`: string — human-readable name.
- `enabled`: boolean.
- `options`: object — same shape as resource-level options, but these ARE applied to responses matching the rule.
- `rule_string` (the `rule` field) must be unique across rules on the same resource — you can't have two rules with `rule=".*"`.

**GCore response_headers_hiding_policy semantics (discovered via live testing):**
- `mode='hide'` + `excepted=[list]` = "hide ALL EXCEPT these" (the default; excepted list = headers to KEEP)
- `mode='show'` + `excepted=[list]` = "show ONLY these (+ 5 mandatory)" (excepted list = headers to SHOW; everything else is hidden)
- The 5 mandatory headers (connection, content-length, content-type, server, date) cannot be hidden — GCore always returns them.
- For `mode='show'`, it's forbidden to include the mandatory headers in the excepted list (redundant — they're always shown).

### v7.4 (2026-07-14)
- **Smart URL routing for /stream** — fixes "I sent a non-pixeldrain URL and it didn't work" + "I sent the bot's own CDN URL back and it broke" issues. New `analyzeSourceUrl()` in `_gcore.js` runs BEFORE any GCore API call and returns one of five routing decisions:
  - `self_loop` — URL is on our own CDN cname (`cdn.streambot.freeddns.org`). Refused with friendly error explaining the user should just open the URL directly. (Previously: bot repointed CDN origin at itself → infinite loop → 5xx → broken state for everyone until next /stream call.)
  - `pixeldrain_list` — URL is `pixeldrain.com/l/<id>` (file list, returns HTML). Refused with instructions to open the list in browser, click the file, copy the `/u/<id>` URL, and send THAT to /stream.
  - `expired_presigned` — URL has `X-Amz-Date` + `X-Amz-Expires` (or Azure `se=` or GCS `Expires=`) and the signature has already expired. Refused with the exact expiry timestamp. (This was the user's actual case: R2 URL with `X-Amz-Date=20260712T091946Z&X-Amz-Expires=28800` → expired at 2026-07-12T17:19:46Z, well before the user tried to use it.)
  - `already_fast_cdn` — URL host matches R2 / S3 / CloudFront / Akamai / Bunny / KeyCDN / Fastly pattern. Returned as-is with explanation "already on a fast CDN, no GCore benefit". If URL has presigned params and is still valid, the expiry warning is included.
  - `stream_via_gcore` — default; normal GCore CDN repoint flow.
- **`provisionStreamableUrl()` return shape changed**: now returns `{ kind: "stream" | "passthrough" | "self_loop" | "expired" | "pixeldrain_list", ... }`. `webhook.js handleStreamRequest()` branches on `r.kind` and sends a tailored message for each case.
- **Honest /stream help text** — `/stream` (no args) now lists what works (✅ pixeldrain single file, ✅ any direct download link, ⚠️ R2/S3/CloudFront already fast, ⚠️ presigned URLs expire) and what doesn't (❌ pixeldrain file lists, ❌ bot's own CDN URL fed back, ❌ auth-required links).
- **Expiration warning on stream success** — if the source URL is a presigned URL (still valid), the success message now includes "⏰ Source URL expires in ~X hours" so the user knows the stream will die when the origin URL expires.
- **Architecture limitation noted in success message** — each /stream call now warns: "⚠️ Important: each new /stream call repoints this CDN resource at the latest origin. This URL works until you /stream a different link, or until the source URL expires." This sets honest expectations about the single-resource repointing architecture.
- **HTML-escape helper** — added `escapeHtml()` in webhook.js for user-supplied strings shown in Telegram HTML messages (prevents HTML injection from URL params in error messages).
- **Tested**: 9/9 cases pass in `/home/z/my-project/scripts/test_analyze.mjs` covering self-loop, expired R2, fresh R2, pixeldrain list, pixeldrain /u/, pixeldrain /api/file/, arbitrary URL, S3, CloudFront.

### v7.3 (2026-07-13)
- **Security hardening**: rotated `BOT_VERIFY_TOKEN` (old value was leaked in git history at commits `34e2d4c` and `6eb0841`); updated both Vercel env and GitHub secret with the new 64-hex-char value.
- **Sanitized `DEVELOPER_CONTEXT.md`**: removed all hardcoded secrets (BOT_VERIFY_TOKEN, TELEGRAM_ALLOWED_ID, TELEGRAM_CHANNEL_ID, bot ID, channel ID). Replaced with placeholders pointing to Vercel env / GitHub secrets.
- **New file `.env.example`** at repo root: lists ALL env vars used by the project (Telegram, GitHub, storage.to, pixeldrain, GCore CDN) with comments explaining where each one lives (Vercel env vs GitHub secret vs both).
- **Sanitized code comments**: removed hardcoded GCore per-account CNAME target and Dynu subdomain literals from `_gcore.js` and `webhook.js` comments + user-facing message (kept only as hardcoded fallback constant in `_gcore.js`, which is fine since the cname is publicly visible via DNS anyway).
- **Fixed non-blocking callback flow**: previously the `pick_stream:`, `pick_svc:`, `upload_file:`, and `pick_svc_file:` callback handlers `await`ed `handleStreamRequest` / `triggerUpload` BEFORE returning HTTP 200 to Telegram, causing the inline-button "bot isn't responding" error. Now all four handlers:
  1. `await answerCallbackQuery` (dismiss button spinner immediately)
  2. `await sendMessage` (send "provisioning" / "queued" feedback message)
  3. Fire `handleStreamRequest` / `triggerUpload` as a non-awaited background promise
  4. Return HTTP 200 immediately
  Vercel keeps the function alive until the background promise settles (within `maxDuration=60s`), then delivers the final result as a separate Telegram message.
- `handleStreamRequest(chatId, url, opts = {})` now accepts `{ skipInitialMessage: true }` so the callback flow can send its own feedback message first without duplication.

### v6.0 (2026-07-12)
- **Added pixeldrain as second upload service** (user-selectable per upload)
- `upload.mjs`: 4th CLI arg = `service` (`storageto` | `pixeldrain`, default `storageto`)
  - New `uploadToPixeldrain()` using `PUT /api/file/{name}` with HTTP Basic Auth (empty username, API key as password)
  - Single PUT request (no multipart), streams file from disk
  - Returns `{ service, url: "https://pixeldrain.com/u/{id}", raw_url: "https://pixeldrain.com/api/file/{id}", ... }`
  - Retries on 5xx and 429 (max 3 attempts, exponential backoff)
- `bot/api/webhook.js`: per-upload service picker via inline keyboard
  - URL detection → inline keyboard [📦 Storage.to] [🎬 PixelDrain] [❌ Cancel]
  - New commands: `/storage <url>`, `/pixeldrain <url>` (skip picker, direct upload)
  - New command: `/service [storageto|pixeldrain]` — show/change default service
  - Per-user `defaultService` setting (in-memory, default `storageto`)
  - Pending-id bridge: long URLs stored in memory with short ID; callback_data is `pick_svc:<shortId>:<service>` (Telegram 64-byte callback_data limit)
  - Forwarded files also show service picker
  - Service propagated in dispatch payload: `client_payload.service`
- `bot/api/result.js`: shows service label + raw download link in success message
  - For pixeldrain: shows "♾️ Pixeldrain files do not expire" instead of expiry
- `.github/workflows/telegram.yml`: extracts `service` from `client_payload`, validates `PIXELDRAIN_TOKEN` for pixeldrain uploads, includes service in Vercel callback payload
- `.github/workflows/upload.yml`: manual workflow now supports `service` choice input
- `bot/api/start.js`: updated bot command menu (upload/storage/pixeldrain/service) and descriptions
- New GitHub secret: `PIXELDRAIN_TOKEN`
- New persistent keyboard button: "🔄 Service"
- **TESTED SUCCESSFULLY (full end-to-end)**: 2.55 GB MKV from Google video URL → pixeldrain.com/u/JvK4GxSs in 4 min 19 sec (download 62s + upload 56s)

### v5.0 (2026-07-12)
- Stripped ALL FFmpeg, conversion, subtitle extraction, thumbnail generation
- Removed channel file upload (just sends link)
- Fixed ERR_FS_FILE_TOO_LARGE by using createReadStream instead of readFileSync
- Fixed /upload/parts API response format (urls object vs part_urls array)
- Added 3x concurrent multipart upload
- Added Telegram file forwarding with inline keyboard prompt
- Prefetch all part URLs upfront for speed
- **TESTED SUCCESSFULLY**: 15.07GB MKV uploaded from hub.whistle.lat → storage.to/EU5xZI1O1

### v7.0 (2026-07-13)
- **Added "Instant CDN Stream" feature** powered by Gcore CDN — no download, no upload, no storage used
- New command: `/stream <url>` — returns an instant streamable URL via Gcore edge
- New file: `bot/api/_gcore.js` — Gcore API client (list/create origin groups, update CDN resource, purge cache)
- `bot/api/webhook.js` changes:
  - Imports `provisionStreamableUrl` from `_gcore.js`
  - New `handleStreamRequest(chatId, url)` orchestrator that calls Gcore and replies with streamable URL
  - New `pick_stream:<pendingId>` callback handler (Stream button in URL picker)
  - New `/stream <url>` command + `/stream` (no args, shows help)
  - New "🚀 Stream" persistent keyboard button (first slot in main menu)
  - `servicePickerKeyboard()` now shows 3 rows: Stream button on top, then Storage.to + PixelDrain, then Cancel
  - Updated WELCOME, HELP_MSG, ABOUT_MSG to mention the new feature
- `bot/api/start.js`: added `/stream` to bot command menu (first slot), updated bot description
- `bot/vercel.json`: bumped `api/webhook.js` `maxDuration` from 10 → 60s (Gcore API calls take 5-15s)
- New env vars (Vercel): `GCORE_API_TOKEN`, `GCORE_CDN_RESOURCE_ID`, `GCORE_CDN_CNAME`
- Architecture:
  - ONE CDN resource is created manually in Gcore portal (one-time setup), CNAME'd to `cl-XXXX.gcdn.co`
  - Per /stream request: Vercel finds-or-creates an origin group for the URL's host, then PATCHes the CDN resource to point at that origin group with video-friendly options (`slice` enabled for Range/seek, `hostHeader` set so origin sees correct Host, `ignoreQueryString` disabled so tokens in query work, `cors: *`, `disable_proxy_force_ranges: false`), then purges cache, then returns `https://<cname><path>?<query>`
  - Gcore edge pulls from origin on-the-fly — payload never touches Vercel
- **Status**: code complete, pending Gcore CDN service activation in portal (account is in "preparation" status, requires manual activation step)
- **Test links** (PixelDrain):
  - `https://pixeldrain.dev/api/file/Kd4Xvyan?download`
  - `https://pixeldrain.dev/api/file/NoXAdA2G?download`
  - `https://pixeldrain.dev/api/file/9eHdnBcK?download`

## Gcore CDN — One-Time Setup (REQUIRED before /stream works)

The Gcore account must have the CDN service activated before /stream will work.
A fresh Gcore account is in "preparation" status with CDN `enabled: false`. To activate:

1. Log in to https://portal.gcore.com
2. Open the **CDN** product page
3. Click **Activate** / **Try CDN** (may require adding a payment method, even for free tier)
4. Once CDN shows status "Active", click **Create CDN resource**:
   - **Custom domain**: enter a subdomain you control (e.g. `stream.yourdomain.com`)
   - **Origin**: any placeholder (we'll override via API)
   - **DNS option**: Do not delegate (CNAME)
   - **SSL**: enable Let's Encrypt (free) so HTTPS works for streaming
5. After creation, the portal shows `cl-XXXX.gcdn.co` — add a CNAME record at your DNS provider:
   ```
   stream.yourdomain.com.   CNAME   cl-XXXX.gcdn.co.
   ```
6. Wait for DNS propagation (~5-30 min). Verify with `dig stream.yourdomain.com`.
7. Note the **resource ID** from the portal URL (e.g. `portal.gcore.com/cdn/resources/12345` → ID = `12345`)
8. Set these Vercel env vars:
   - `GCORE_API_TOKEN` — the permanent API token (starts with `XXXXX_`)
   - `GCORE_CDN_RESOURCE_ID` — the numeric resource ID from step 7
   - `GCORE_CDN_CNAME` — the custom domain from step 4 (e.g. `stream.yourdomain.com`)
9. Redeploy Vercel (any push to `main` triggers it) and hit `/api/start?secret=...` to refresh the bot menu

Once activated, the user can:
- Send any video download URL → tap **🚀 Stream** → get back `https://stream.yourdomain.com/<path>?<query>` that streams via Gcore CDN
- Or use `/stream <url>` directly

### Gcore API endpoints used (all under `https://api.gcore.com`, auth: `Authorization: APIKey <token>`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/iam/clients/me` | Verify token + account status |
| GET | `/cdn/origin_groups?page=N&per_page=100` | List origin groups (paginated) |
| POST | `/cdn/origin_groups` | Create a new origin group with a single host source |
| PUT | `/cdn/resources/{id}` | Update the CDN resource (origin group, options) |
| POST | `/cdn/resources/{id}/purge` | Purge all cache (body: `{"purge_all": true}`) |

### CDN resource options we set on every /stream request

| Option | Value | Why |
|--------|-------|-----|
| `originGroup` | `<id>` | Points the resource at the origin group for this host |
| `originProtocol` | `HTTPS` or `HTTP` | Matches the source URL protocol |
| `options.slice` | `{enabled: true, value: true}` | Chops large files into 10MB Range fragments so VLC can seek |
| `options.hostHeader` | `{enabled: true, value: "<origin host>"}` | Origin sees correct Host header (not the CDN cname) |
| `options.ignoreQueryString` | `{enabled: true, value: false}` | Different query strings = different cache entries (preserves `?download`, auth tokens) |
| `options.cors` | `{enabled: true, value: ["*"], always: true}` | Allows web players and TVs to fetch |
| `options.disable_proxy_force_ranges` | `{enabled: true, value: false}` | Allows 206 Partial Content responses |
| `options.forward_host_header` | `{enabled: true, value: false}` | Disabled — we set `hostHeader` instead |

### Error handling

If Gcore returns "CDN service is stopped", the bot replies with a hint to activate CDN in the portal.
If env vars are missing, the bot replies with a hint to set them in Vercel.
Other errors are surfaced verbatim (truncated to 400 chars).
