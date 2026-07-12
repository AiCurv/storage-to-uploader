#!/usr/bin/env node
// storage-to-uploader: download → upload to storage.to → return HTML link
// NO FFmpeg, NO conversion, NO subtitle extraction. Just raw passthrough.
//
// Usage:
//   node upload.mjs <url> [filename] [content-type]
//
// Env:
//   STORAGE_TO_VISITOR_TOKEN  - reused across runs to keep "ownership" of uploads
//   STORAGE_TO_API            - override API base (default https://storage.to/api)
//   WORK_DIR                  - override temp working dir (default: /tmp/storageto)

import { writeFileSync, statSync, mkdirSync, rmSync, createReadStream } from "node:fs";
import { basename, join, extname } from "node:path";
import { execSync } from "node:child_process";

const API = process.env.STORAGE_TO_API || "https://storage.to/api";
const VISITOR = process.env.STORAGE_TO_VISITOR_TOKEN || cryptoRandom();
const WORK_DIR = process.env.WORK_DIR || "/tmp/storageto";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function log(...args) {
  console.error("[storage-to]", new Date().toISOString(), ...args);
}

// ─── storage.to API ──────────────────────────────────────────────

async function api(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Visitor-Token": VISITOR,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok || json.success === false) {
    throw new Error(`api ${path} ${r.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

/**
 * Upload a file from disk to storage.to using streaming (no memory buffering).
 * Returns { url, raw_url, file_id, filename, size, human_size, expires_at }.
 */
async function uploadFileFromDisk(filePath, filename, contentType) {
  const fileSize = statSync(filePath).size;
  log(`upload: filename=${filename} size=${fileSize} type=${contentType} path=${filePath}`);

  const init = await api("/upload/init", {
    filename,
    content_type: contentType,
    size: fileSize,
  });

  const r2Key = init.r2_key;

  if (init.type === "single") {
    log("single PUT to R2, streaming from disk...");
    const putHeaders = {
      ...(init.headers || {}),
      "Content-Length": String(fileSize),
    };
    const fileStream = createReadStream(filePath);
    const putRes = await fetch(init.upload_url, {
      method: "PUT",
      headers: putHeaders,
      body: fileStream,
      duplex: "half",
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      throw new Error(`R2 PUT ${putRes.status}: ${t.slice(0, 500)}`);
    }
    log("single PUT complete");
  } else if (init.type === "multipart") {
    const partSize = init.part_size;
    const totalParts = init.total_parts;
    const completedParts = [];
    const CONCURRENCY = 3; // Upload 3 parts concurrently for speed

    // Prefetch all part URLs in batches of 50
    // The init response gives us the first batch (in initial_urls)
    // We need to fetch the rest via /upload/parts
    log(`prefetching part URLs for ${totalParts} parts...`);
    const allPartNumbers = Array.from({ length: totalParts }, (_, k) => k + 1);
    for (let batch = 0; batch < totalParts; batch += 50) {
      const batchNums = allPartNumbers.slice(batch, batch + 50);
      // Skip parts we already have URLs for (from init.initial_urls)
      const missing = batchNums.filter(n => !init.initial_urls[String(n)]);
      if (missing.length > 0) {
        const more = await api("/upload/parts", {
          upload_id: init.upload_id,
          part_numbers: missing,
        });
        const urlMap = more.urls || {};
        for (const [num, url] of Object.entries(urlMap)) {
          init.initial_urls[num] = url;
        }
      }
    }
    log(`all ${totalParts} part URLs fetched`);

    // Upload parts with concurrency
    async function uploadPart(partNumber) {
      const partUrl = init.initial_urls[String(partNumber)];
      if (!partUrl) throw new Error(`no URL for part ${partNumber}`);
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, fileSize) - 1;
      const partStream = createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });
      const pr = await fetch(partUrl, {
        method: "PUT",
        body: partStream,
        duplex: "half",
        headers: { "Content-Length": String(end - start + 1) },
      });
      if (!pr.ok) throw new Error(`R2 part ${partNumber} PUT ${pr.status}: ${await pr.text()}`);
      const etag = pr.headers.get("etag") || pr.headers.get("ETag");
      if (!etag) throw new Error(`R2 part ${partNumber} missing etag header`);
      return { partNumber, etag };
    }

    // Process in batches of CONCURRENCY
    for (let batch = 0; batch < totalParts; batch += CONCURRENCY) {
      const batchPartNums = allPartNumbers.slice(batch, batch + CONCURRENCY);
      const batchResults = await Promise.all(batchPartNums.map(n => uploadPart(n)));
      completedParts.push(...batchResults);
      const lastDone = batch + batchPartNums.length;
      if (lastDone % 30 === 0 || lastDone === totalParts) {
        log(`uploaded ${lastDone}/${totalParts} parts`);
      }
    }

    // Sort by part number for the complete-multipart call
    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    log("complete-multipart");
    await api("/upload/complete-multipart", {
      upload_id: init.upload_id,
      parts: completedParts,
    });
  } else {
    throw new Error(`unexpected init response type: ${init.type}`);
  }

  log("confirming upload...");
  const confirm = await api("/upload/confirm", {
    filename,
    size: fileSize,
    content_type: contentType,
    r2_key: r2Key,
  });

  const f = confirm.file;
  log("confirmed:", f.url);

  return {
    url: f.url,             // HTML page — THIS is what we send to user
    raw_url: f.raw_url,     // Direct download link
    file_id: f.id,
    filename: f.filename,
    size: f.size,
    human_size: f.human_size,
    expires_at: f.expires_at,
  };
}

// ─── URL resolvers ───────────────────────────────────────────────

function resolveSource(rawUrl) {
  // Telegram file: tgfile:<file_id>:<filename>
  // This is a virtual URL that means "download from Telegram Bot API"
  // Handled separately in main(), not via curl
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

  // Default: pass-through with browser UA
  return { url: rawUrl, headers: { "User-Agent": UA } };
}

/**
 * Download a file from Telegram Bot API using file_id.
 * Returns { filePath, fileName, contentType }
 * Note: Telegram Bot API has a 20MB download limit for getFile.
 */
async function downloadTelegramFile(fileId, fileName) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN not set, can't download Telegram file");

  log(`downloading Telegram file: file_id=${fileId} name=${fileName}`);

  // Step 1: Get file path via getFile API
  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error(`Telegram getFile failed: ${fileData.description}`);

  const filePath = fileData.result.file_path;
  const fileSize = fileData.result.file_size;
  log(`Telegram file_path: ${filePath} size: ${fileSize || "unknown"}`);

  // Step 2: Download the file
  const dlUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const ext = extname(filePath || fileName).toLowerCase() || ".bin";
  const localPath = join(WORK_DIR, "download" + ext);

  // Use curl for reliability
  const curlCmd = `curl -fSL --retry 3 --retry-delay 5 -o "${localPath}" "${dlUrl}"`;
  log("downloading with curl...");
  try {
    execSync(curlCmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 }); // 5 min
  } catch {
    log("curl failed, trying fetch...");
    const dlResponse = await fetch(dlUrl);
    if (!dlResponse.ok) throw new Error(`Telegram file download failed: ${dlResponse.status}`);
    const buf = Buffer.from(await dlResponse.arrayBuffer());
    writeFileSync(localPath, buf);
  }

  const dlSize = statSync(localPath).size;
  log(`Telegram download complete: ${dlSize} bytes (${(dlSize / 1024 / 1024).toFixed(1)} MB)`);

  // Guess content type from extension
  const ctMap = {
    ".mp4": "video/mp4", ".mkv": "video/matroska", ".avi": "video/x-msvideo",
    ".mov": "video/quicktime", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif",
    ".zip": "application/zip", ".rar": "application/x-rar-compressed",
    ".7z": "application/x-7z-compressed", ".tar": "application/x-tar", ".gz": "application/gzip",
    ".pdf": "application/pdf", ".apk": "application/vnd.android.package-archive",
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

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const [, , srcArg, overrideName, overrideType] = process.argv;
  if (!srcArg) {
    console.error("usage: upload.mjs <url> [filename] [content-type]");
    process.exit(2);
  }

  // Create work directory
  mkdirSync(WORK_DIR, { recursive: true });

  const resolved = resolveSource(srcArg);

  // ── Handle Telegram forwarded files ──
  if (resolved.isTelegramFile) {
    const parts = srcArg.split(":");
    // tgfile:<file_id>:<filename>
    const fileId = parts.slice(1, -1).join(":"); // file_id might contain colons? No, but be safe
    const tgFileName = parts[parts.length - 1] || "file";
    
    const tgResult = await downloadTelegramFile(fileId, decodeURIComponent(tgFileName));
    const workName = overrideName || tgResult.fileName;
    const contentType = overrideType || tgResult.contentType;

    const mainResult = await uploadFileFromDisk(tgResult.filePath, workName, contentType);
    
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
    if (cd && !overrideName) {
      const guessed = guessFilename(srcArg, cd);
      if (guessed && guessed !== "file") workName = guessed;
    }
    const cl = headRes.headers.get("content-length");
    if (cl) log(`content-length: ${(parseInt(cl) / 1024 / 1024).toFixed(1)} MB`);
  } catch (headErr) {
    if (headErr.message.includes("HTML")) throw headErr; // re-throw HTML errors
    log("HEAD request failed, will check content-type after download");
  }

  // Download with curl — handles large files, redirects, retries
  const headerArgs = Object.entries(downloadHeaders || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ");
  const curlCmd = `curl -fSL --retry 3 --retry-delay 5 -o "${dlPath}" ${headerArgs} "${resolvedUrl}"`;
  log("downloading with curl...");
  try {
    execSync(curlCmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 7200_000 }); // 2 hour max for huge files
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

  // ── Step 2: Upload directly to storage.to — NO conversion, NO FFmpeg ──
  const mainResult = await uploadFileFromDisk(dlPath, workName, contentType);

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
