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
    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1;
      let partUrl = init.initial_urls[String(partNumber)];
      if (!partUrl) {
        const more = await api("/upload/parts", {
          upload_id: init.upload_id,
          part_numbers: Array.from({ length: Math.min(totalParts - i, 50) }, (_, k) => i + k + 1),
        });
        // API returns { success: true, urls: { "51": "https://...", "52": "..." } }
        const urlMap = more.urls || {};
        for (const [num, url] of Object.entries(urlMap)) {
          init.initial_urls[num] = url;
        }
        partUrl = init.initial_urls[String(partNumber)];
      }
      const start = i * partSize;
      const end = Math.min(start + partSize, fileSize) - 1; // createReadStream end is inclusive
      log(`part ${partNumber}/${totalParts}: bytes ${start}-${end + 1}`);
      // Use createReadStream with start/end to avoid ERR_FS_FILE_TOO_LARGE for files >2GB
      // readFileSync allocates a buffer for the full file size even with start/end
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
      completedParts.push({ partNumber, etag });
      log(`part ${partNumber}/${totalParts} done (etag: ${etag})`);
    }
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

  const { url: resolvedUrl, headers: downloadHeaders } = resolveSource(srcArg);

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
