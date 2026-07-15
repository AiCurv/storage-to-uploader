#!/usr/bin/env node
// StreamToBuffer uploader: download → upload to pixeldrain OR file.kiwi → return link
// NO FFmpeg transcoding. Files >10GB destined for pixeldrain are split with ffmpeg stream-copy.
//
// Usage:
//   node upload.mjs <url> [filename] [content-type] [service]
//     service: "pixeldrain" (default) | "filekiwi"
//
// Env:
//   PIXELDRAIN_TOKEN          - API key for pixeldrain (REQUIRED when service=pixeldrain)
//   PIXELDRAIN_API            - override API base (default https://pixeldrain.com/api)
//   PIXELDRAIN_MAX_FILESIZE   - override split threshold in bytes (default 10000000000 = 10GB)
//   WORK_DIR                  - override temp working dir (default: /tmp/storageto)

import { writeFileSync, statSync, mkdirSync, rmSync, createReadStream, readdirSync } from "node:fs";
import { basename, join, extname } from "node:path";
import { execSync } from "node:child_process";

const PIXELDRAIN_API = process.env.PIXELDRAIN_API || "https://pixeldrain.com/api";
const PIXELDRAIN_TOKEN = process.env.PIXELDRAIN_TOKEN || "";
const PIXELDRAIN_MAX_FILESIZE = Number(process.env.PIXELDRAIN_MAX_FILESIZE || 10000000000); // 10GB
const WORK_DIR = process.env.WORK_DIR || "/tmp/storageto";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function log(...args) {
  console.error("[uploader]", new Date().toISOString(), ...args);
}

function humanSize(n) {
  if (!n) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ─── pixeldrain API ──────────────────────────────────────────────

/**
 * Upload a single file from disk to pixeldrain using streaming PUT.
 * Returns { service, url, raw_url, file_id, filename, size, human_size, expires_at }.
 */
async function uploadToPixeldrain(filePath, filename, contentType) {
  if (!PIXELDRAIN_TOKEN) {
    throw new Error("PIXELDRAIN_TOKEN env var is required for service=pixeldrain");
  }
  const fileSize = statSync(filePath).size;
  log(`[pixeldrain] upload: filename=${filename} size=${fileSize} (${humanSize(fileSize)}) type=${contentType} path=${filePath}`);

  if (fileSize > PIXELDRAIN_MAX_FILESIZE) {
    throw new Error(`file too large for pixeldrain: ${fileSize} bytes (${humanSize(fileSize)}) > limit ${humanSize(PIXELDRAIN_MAX_FILESIZE)}. Splitting should have happened before this point.`);
  }

  const basicAuth = "Basic " + Buffer.from(`:${PIXELDRAIN_TOKEN}`).toString("base64");
  const uploadUrl = `${PIXELDRAIN_API}/file/${encodeURIComponent(filename)}`;
  log(`[pixeldrain] PUT ${uploadUrl} (streaming from disk)...`);

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5000;

  async function attempt(tryNum = 1) {
    const stream = createReadStream(filePath);
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Authorization": basicAuth,
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": String(fileSize),
      },
      body: stream,
      duplex: "half",
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!r.ok || json.success === false) {
      const errMsg = json.message || json.value || text.slice(0, 300);
      if (tryNum < MAX_RETRIES && (r.status >= 500 || r.status === 429)) {
        log(`[pixeldrain] PUT ${r.status} (attempt ${tryNum}/${MAX_RETRIES}): ${errMsg}. Retrying in ${RETRY_DELAY_MS * tryNum}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * tryNum));
        return attempt(tryNum + 1);
      }
      throw new Error(`pixeldrain PUT ${r.status} (${json.value || "error"}): ${errMsg}`);
    }
    return json;
  }

  let json;
  try {
    json = await attempt(1);
  } catch (err) {
    if (err.message && err.message.includes("fetch failed")) {
      log(`[pixeldrain] network error on attempt, retrying once more after 10s...`);
      await new Promise(r => setTimeout(r, 10000));
      json = await attempt(2);
    } else {
      throw err;
    }
  }

  const id = json.id;
  if (!id) {
    throw new Error(`pixeldrain upload returned no id: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const result = {
    service: "pixeldrain",
    url: `https://pixeldrain.com/u/${id}`,
    raw_url: `https://pixeldrain.com/api/file/${id}`,
    file_id: id,
    filename: json.name || filename,
    size: json.size || fileSize,
    human_size: humanSize(json.size || fileSize),
    expires_at: "",
  };

  log(`[pixeldrain] upload complete: ${result.url} (${result.human_size})`);
  return result;
}

// ─── file.kiwi API (via official @file-kiwi/node SDK) ────────────

/**
 * Upload a file to file.kiwi using the official SDK.
 * file.kiwi uses end-to-end encryption + chunked uploads to Cloudflare R2.
 * The returned URL is an HTML page (not a direct download link).
 * Returns { service, url, raw_url, file_id, filename, size, human_size, expires_at, retention_hours }.
 */
async function uploadToFileKiwi(filePath, filename) {
  const fileSize = statSync(filePath).size;
  log(`[filekiwi] upload: filename=${filename} size=${fileSize} (${humanSize(fileSize)}) path=${filePath}`);

  // Dynamic import — the SDK is installed via npm in GitHub Actions
  let createWebFolder, startUpload;
  try {
    const sdk = await import("@file-kiwi/node");
    createWebFolder = sdk.createWebFolder;
    startUpload = sdk.startUpload;
  } catch (importErr) {
    throw new Error(`@file-kiwi/node SDK not installed. Run: npm install @file-kiwi/node. Error: ${importErr.message}`);
  }

  log("[filekiwi] creating webfolder...");
  const wf = await createWebFolder({
    title: filename.slice(0, 200),
    files: [filePath],
  });

  log(`[filekiwi] webfolder created: id=${wf.webfolderId} url=${wf.webfolderUrl} retention=${wf.retentionHours}h`);
  for (const f of wf.files) {
    log(`[filekiwi] file: chunks=${f.chunks} chunkSize=${f.chunkSize} freeDownloadHours=${f.freeDownloadHours}`);
  }

  log("[filekiwi] starting chunked upload...");
  const startTime = Date.now();
  let lastProgressLog = 0;
  await startUpload(wf, {
    onProgress: (file, uploaded, total) => {
      const now = Date.now();
      if (now - lastProgressLog > 10000 || uploaded === total) {
        const pct = total > 0 ? ((uploaded / total) * 100).toFixed(1) : "0";
        const elapsed = ((now - startTime) / 1000).toFixed(0);
        log(`[filekiwi] progress: ${uploaded}/${total} chunks (${pct}%) elapsed=${elapsed}s`);
        lastProgressLog = now;
      }
    },
    onFileComplete: (file) => log(`[filekiwi] file complete: ${file.filepath}`),
    onError: (file, err) => {
      log(`[filekiwi] ERROR on ${file.filepath}: ${err.message}`);
      throw err;
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`[filekiwi] upload complete in ${elapsed}s`);

  const result = {
    service: "filekiwi",
    url: wf.webfolderUrl,
    raw_url: wf.webfolderUrl, // file.kiwi URLs are HTML pages (E2E encrypted), no raw download
    file_id: wf.webfolderId,
    filename,
    size: fileSize,
    human_size: humanSize(fileSize),
    expires_at: `${wf.retentionHours}h retention`,
    retention_hours: wf.retentionHours,
  };

  return result;
}

// ─── file splitting (for pixeldrain, files >10GB) ────────────────

/**
 * Split a large file into segments under the size limit.
 *
 * Strategy:
 *   1. If the file is a video (ffprobe can read duration): use ffmpeg segment muxer
 *      with -segment_time calculated from bitrate. Produces independently playable
 *      segments (timestamps reset to 0). No re-encoding (stream copy = fast).
 *   2. If ffprobe fails (not a video): use binary `split` command. Parts are NOT
 *      individually playable — user must merge with `cat part_* > original.mkv`.
 *
 * Returns array of { filePath, filename } for each part.
 */
function splitFileForUpload(filePath, baseFilename, maxBytes) {
  const fileSize = statSync(filePath).size;
  if (fileSize <= maxBytes) {
    return [{ filePath, filename: baseFilename }];
  }

  const ext = extname(baseFilename).toLowerCase() || ".mkv";
  const stem = basename(baseFilename, ext);
  // Target 90% of limit for safety margin
  const targetSize = Math.floor(maxBytes * 0.9);

  log(`[split] file ${humanSize(fileSize)} > limit ${humanSize(maxBytes)}, target segment size ~${humanSize(targetSize)}`);

  // Check tools are available
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    throw new Error("ffmpeg not installed but file splitting is required. Install ffmpeg in the workflow.");
  }

  // Try to get file duration with ffprobe (works for video/audio files)
  let durationSec = null;
  try {
    const dur = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }
    ).toString().trim();
    durationSec = parseFloat(dur);
    if (!isNaN(durationSec) && durationSec > 0) {
      log(`[split] ffprobe duration: ${durationSec.toFixed(1)}s`);
    }
  } catch (err) {
    log(`[split] ffprobe failed (not a video/audio file?): ${err.message.split("\n")[0]}`);
  }

  let partPrefix;

  if (durationSec && durationSec > 0) {
    // ── Video/audio file: use ffmpeg segment muxer with stream copy ──
    // Calculate segment_time from target size and bitrate
    const bytesPerSec = fileSize / durationSec;
    const segmentTime = Math.floor(targetSize / bytesPerSec);
    log(`[split] bitrate ~${humanSize(bytesPerSec)}/s, segment_time=${segmentTime}s`);

    partPrefix = `${stem}_part_`;
    const partPattern = join(WORK_DIR, `${partPrefix}%03d${ext}`);
    const cmd = `ffmpeg -y -i "${filePath}" -c copy -f segment -segment_time ${segmentTime} -reset_timestamps 1 "${partPattern}"`;
    log(`[split] running ffmpeg segment...`);

    try {
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 1800_000 }); // 30 min max
    } catch (err) {
      log(`[split] ffmpeg stderr: ${err.stderr ? err.stderr.toString().slice(-500) : "n/a"}`);
      throw new Error(`ffmpeg segment failed: ${err.message}`);
    }
  } else {
    // ── Non-video file: use binary split ──
    log(`[split] using binary split (parts will need cat-merge)`);
    partPrefix = `${stem}_part_`;
    const partPrefixPath = join(WORK_DIR, partPrefix);
    const cmd = `split -b ${targetSize} -a 3 "${filePath}" "${partPrefixPath}"`;
    log(`[split] running: ${cmd}`);

    try {
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 1800_000 });
    } catch (err) {
      throw new Error(`binary split failed: ${err.message}`);
    }
  }

  // Collect generated parts (sorted by name)
  // For ffmpeg: files are named ${stem}_part_000.mkv, ${stem}_part_001.mkv, ...
  // For split:  files are named ${stem}_part_aaa, ${stem}_part_aab, ... (no extension)
  const parts = readdirSync(WORK_DIR)
    .filter(f => f.startsWith(partPrefix))
    .sort()
    .map(f => ({
      filePath: join(WORK_DIR, f),
      filename: f,
    }));

  if (parts.length === 0) {
    throw new Error("split produced no output files");
  }

  log(`[split] produced ${parts.length} parts:`);
  for (const p of parts) {
    log(`[split]   ${p.filename} (${humanSize(statSync(p.filePath).size)})`);
  }

  return parts;
}

// ─── URL resolvers ───────────────────────────────────────────────

function resolveSource(rawUrl) {
  if (rawUrl.startsWith("tgfile:")) {
    return { url: rawUrl, headers: {}, isTelegramFile: true };
  }

  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();

  // Pixeldrain: /u/<id> and /d/<id> are HTML viewers → rewrite to /api/file/<id>
  if (host === "pixeldrain.com" || host === "www.pixeldrain.com") {
    const m = u.pathname.match(/^\/(?:u|api\/file|d)\/([A-Za-z0-9]+)/);
    if (m) {
      const fixed = new URL(`/api/file/${m[1]}`, u);
      return { url: fixed.toString(), headers: { "User-Agent": UA } };
    }
  }

  return { url: rawUrl, headers: { "User-Agent": UA } };
}

/**
 * Download a file from Telegram Bot API using file_id.
 * Note: Telegram Bot API has a 20MB download limit for getFile.
 */
async function downloadTelegramFile(fileId, fileName) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN not set, can't download Telegram file");

  log(`downloading Telegram file: file_id=${fileId} name=${fileName}`);
  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error(`Telegram getFile failed: ${fileData.description}`);

  const filePath = fileData.result.file_path;
  const dlUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const ext = extname(filePath || fileName).toLowerCase() || ".bin";
  const localPath = join(WORK_DIR, "download" + ext);

  const curlCmd = `curl -fSL --retry 3 --retry-delay 5 -o "${localPath}" "${dlUrl}"`;
  try {
    execSync(curlCmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
  } catch {
    const dlResponse = await fetch(dlUrl);
    if (!dlResponse.ok) throw new Error(`Telegram file download failed: ${dlResponse.status}`);
    const buf = Buffer.from(await dlResponse.arrayBuffer());
    writeFileSync(localPath, buf);
  }

  const ctMap = {
    ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".mov": "video/quicktime", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const contentType = ctMap[ext] || "application/octet-stream";
  return { filePath: localPath, fileName: fileName || basename(filePath) || "file", contentType };
}

function guessFilename(url, contentDisposition) {
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(contentDisposition);
    if (m) try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {}
  return "file";
}

// ─── Service dispatcher ──────────────────────────────────────────

async function uploadToService(service, filePath, filename, contentType) {
  if (service === "filekiwi") {
    return uploadToFileKiwi(filePath, filename);
  }
  if (service === "pixeldrain") {
    // Check if file needs splitting
    const fileSize = statSync(filePath).size;
    if (fileSize > PIXELDRAIN_MAX_FILESIZE) {
      log(`[pixeldrain] file ${humanSize(fileSize)} exceeds limit ${humanSize(PIXELDRAIN_MAX_FILESIZE)}, splitting...`);
      const parts = splitFileForUpload(filePath, filename, PIXELDRAIN_MAX_FILESIZE);
      log(`[pixeldrain] uploading ${parts.length} parts...`);
      const results = [];
      for (let i = 0; i < parts.length; i++) {
        log(`[pixeldrain] uploading part ${i + 1}/${parts.length}: ${parts[i].filename}`);
        const r = await uploadToPixeldrain(parts[i].filePath, parts[i].filename, contentType);
        results.push(r);
      }
      return { multi: true, parts: results };
    }
    return uploadToPixeldrain(filePath, filename, contentType);
  }
  throw new Error(`unknown service: "${service}". Valid: pixeldrain | filekiwi`);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const [, , srcArg, overrideName, overrideType, overrideService] = process.argv;
  if (!srcArg) {
    console.error("usage: upload.mjs <url> [filename] [content-type] [service]");
    console.error("       service: pixeldrain (default) | filekiwi");
    process.exit(2);
  }

  const service = (overrideService || process.env.UPLOAD_SERVICE || "pixeldrain").toLowerCase();
  log(`service = ${service}`);

  mkdirSync(WORK_DIR, { recursive: true });

  const resolved = resolveSource(srcArg);

  // ── Handle Telegram forwarded files ──
  if (resolved.isTelegramFile) {
    const parts = srcArg.split(":");
    const fileId = parts.slice(1, -1).join(":");
    const tgFileName = parts[parts.length - 1] || "file";

    const tgResult = await downloadTelegramFile(fileId, decodeURIComponent(tgFileName));
    const workName = overrideName || tgResult.fileName;
    const contentType = overrideType || tgResult.contentType;

    const mainResult = await uploadToService(service, tgResult.filePath, workName, contentType);

    try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}

    const output = { main: mainResult };
    process.stdout.write("RESULT_JSON_BEGIN\n" + JSON.stringify(output, null, 2) + "\nRESULT_JSON_END\n");
    return;
  }

  const { url: resolvedUrl, headers: downloadHeaders } = resolved;

  // ── Step 1: Download file to disk using curl ──
  log("downloading source:", resolvedUrl);

  let workName = overrideName || guessFilename(srcArg, null) || "file";
  const dlPath = join(WORK_DIR, "download" + (extname(workName).toLowerCase() || ".bin"));
  let contentType = overrideType || "application/octet-stream";

  // HEAD request to get content-type and filename hints
  try {
    const headRes = await fetch(resolvedUrl, { method: "HEAD", redirect: "follow", headers: downloadHeaders });
    const headCt = headRes.headers.get("content-type") || "";
    if (headCt && headCt !== "application/octet-stream" && !overrideType) {
      contentType = headCt;
    }
    if (headCt.startsWith("text/html") && !srcArg.endsWith(".html")) {
      throw new Error(
        `source returned HTML (content-type: ${headCt}), not a file. ` +
        `The URL may be a share-page link rather than a direct download link.`
      );
    }
    const cd = headRes.headers.get("content-disposition");
    if (cd) {
      const guessed = guessFilename(srcArg, cd);
      if (guessed && guessed !== "file" && guessed.length > 3) {
        workName = guessed;
        log(`using content-disposition filename: ${workName}`);
      }
    }
    const cl = headRes.headers.get("content-length");
    if (cl) log(`content-length: ${(parseInt(cl) / 1024 / 1024).toFixed(1)} MB`);
  } catch (headErr) {
    if (headErr.message.includes("HTML")) throw headErr;
    log("HEAD request failed, will check content-type after download");
  }

  // Download with curl — handles large files, redirects, retries
  const headerArgs = Object.entries(downloadHeaders || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ");
  const curlCmd = `curl -fSL --retry 3 --retry-delay 5 -o "${dlPath}" ${headerArgs} "${resolvedUrl}"`;
  log("downloading with curl...");
  try {
    execSync(curlCmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 7200_000 }); // 2 hour max
  } catch (curlErr) {
    log("curl failed, trying fetch-based download...");
    const dlResponse = await fetch(resolvedUrl, { redirect: "follow", headers: downloadHeaders });
    if (!dlResponse.ok) throw new Error(`source fetch ${dlResponse.status} ${resolvedUrl}`);
    if (!overrideType) contentType = dlResponse.headers.get("content-type") || contentType;
    const buf = Buffer.from(await dlResponse.arrayBuffer());
    writeFileSync(dlPath, buf);
  }

  const dlSize = statSync(dlPath).size;
  log(`download complete: ${dlSize} bytes (${(dlSize / 1024 / 1024).toFixed(1)} MB)`);

  // ── Step 2: Upload to the selected service ──
  const mainResult = await uploadToService(service, dlPath, workName, contentType);

  // Cleanup
  try { rmSync(WORK_DIR, { recursive: true, force: true }); log("cleaned up work dir"); } catch {}

  // ── Output results ──
  const output = {
    main: mainResult,
  };

  process.stdout.write("RESULT_JSON_BEGIN\n" + JSON.stringify(output, null, 2) + "\nRESULT_JSON_END\n");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
