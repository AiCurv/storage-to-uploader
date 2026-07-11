#!/usr/bin/env node
// storage-to-uploader: download → FFmpeg convert → subtitle extract → upload to storage.to
// DISK-BASED pipeline — no in-memory buffering of large files.
//
// Usage:
//   node upload.mjs <url> [filename] [content-type]
//
// Env:
//   STORAGE_TO_VISITOR_TOKEN  - reused across runs to keep "ownership" of uploads
//   STORAGE_TO_API            - override API base (default https://storage.to/api)
//   CONVERT_TO_MP4            - if "1", convert video to MP4 (default: "1")
//   EXTRACT_SUBS              - if "1", extract subtitles (default: "1")
//   WORK_DIR                  - override temp working dir (default: /tmp/storageto)

import { writeFileSync, readFileSync, unlinkSync, statSync, existsSync, mkdirSync, rmSync, createReadStream } from "node:fs";
import { basename, join, extname } from "node:path";
import { execSync } from "node:child_process";

const API = process.env.STORAGE_TO_API || "https://storage.to/api";
const VISITOR = process.env.STORAGE_TO_VISITOR_TOKEN || cryptoRandom();
const CONVERT_TO_MP4 = process.env.CONVERT_TO_MP4 !== "0";
const EXTRACT_SUBS = process.env.EXTRACT_SUBS !== "0";
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
    throw new Error(`api ${path} ${r.status}: ${text}`);
  }
  return json;
}

/**
 * Upload a file from disk to storage.to using streaming (no memory buffering).
 * Returns { url, raw_url, streaming_url, file_id, filename, size, human_size, expires_at, r2_key }.
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
    // R2 requires Content-Length header — must include it even when streaming from disk
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
      throw new Error(`R2 PUT ${putRes.status}: ${t}`);
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
        for (const p of more.part_urls) {
          init.initial_urls[String(p.partNumber)] = p.url;
        }
        partUrl = init.initial_urls[String(partNumber)];
      }
      const start = i * partSize;
      const end = Math.min(start + partSize, fileSize);
      log(`part ${partNumber}/${totalParts}: bytes ${start}-${end}`);
      // Read specific byte range from file for multipart
      const chunkBuf = readFileSync(filePath, { start, end });
      const pr = await fetch(partUrl, { method: "PUT", body: chunkBuf });
      if (!pr.ok) throw new Error(`R2 part ${partNumber} PUT ${pr.status}: ${await pr.text()}`);
      const etag = pr.headers.get("etag") || pr.headers.get("ETag");
      if (!etag) throw new Error(`R2 part ${partNumber} missing etag header`);
      completedParts.push({ partNumber, etag });
    }
    log("complete-multipart");
    await api("/upload/complete-multipart", {
      upload_id: init.upload_id,
      parts: completedParts,
    });
  } else {
    throw new Error(`unexpected init response type: ${init.type}`);
  }

  if (process.env.STORAGE_TO_NO_CONFIRM === "1") {
    log("skipping confirm");
    return null;
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

  // ── Extract streaming CDN URL from the HTML page ──
  let streamingUrl = "";
  try {
    log("fetching HTML page to extract streaming CDN URL...");
    const htmlRes = await fetch(f.url, { headers: { "User-Agent": UA } });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      // Pattern: <source src="https://cdn.storage.to/<r2_key>?expires=...&sig=..." type="video/mp4">
      const sourceMatch = html.match(/<source\s+src="(https:\/\/cdn\.storage\.to\/[^"]+)"/);
      if (sourceMatch) {
        streamingUrl = sourceMatch[1].replace(/&amp;/g, "&");
        log("streaming CDN URL:", streamingUrl);
      } else {
        log("no <source> tag found in HTML page (may not be a video)");
      }
    }
  } catch (e) {
    log(`failed to extract streaming URL (non-fatal): ${e.message}`);
  }

  return {
    url: f.url,             // HTML page
    raw_url: f.raw_url,     // Download-only link (content-disposition: attachment)
    streaming_url: streamingUrl, // CDN streaming link (no content-disposition, accept-ranges: bytes)
    file_id: f.id,
    filename: f.filename,
    size: f.size,
    human_size: f.human_size,
    expires_at: f.expires_at,
    r2_key: r2Key,
  };
}

// ─── URL resolvers ───────────────────────────────────────────────

function resolveSource(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();

  // Pixeldrain: /u/<id> and /d/<id> are HTML viewers → rewrite to /api/file/<id>
  // /api/file/<id> already serves raw file bytes, no ?download needed (avoids hotlink detection)
  if (host === "pixeldrain.com" || host === "www.pixeldrain.com") {
    const m = u.pathname.match(/^\/(?:u|api\/file|d)\/([A-Za-z0-9]+)/);
    if (m) {
      const fixed = new URL(`/api/file/${m[1]}`, u);
      return { url: fixed.toString(), headers: { "User-Agent": UA } };
    }
  }

  // GoFile: /d/<id> is a share page → need to get content link via API
  // (not yet implemented - pass through and hope it's a direct link)

  // Default: pass-through with browser UA for any URL
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

// ─── Video helpers ───────────────────────────────────────────────

const VIDEO_EXTS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv", ".m4v",
  ".ts", ".mts", ".m2ts", ".vob", ".ogv", ".3gp", ".rm", ".rmvb",
  ".mpg", ".mpeg", ".mpe", ".divx", ".asf", ".amv",
]);

function isVideoFilename(name) {
  return VIDEO_EXTS.has(extname(name).toLowerCase());
}

function isAlreadyMp4(name) {
  return extname(name).toLowerCase() === ".mp4";
}

/** Convert video file on disk to MP4 on disk using FFmpeg. Returns output file path. */
function convertToMp4OnDisk(inputPath, inputName) {
  const outFile = join(WORK_DIR, basename(inputName, extname(inputName)) + ".mp4");

  log("converting to MP4 with FFmpeg (H.264 + AAC, faststart)...");

  const strategies = [
    // Strategy 1: Re-encode video + audio, faststart
    `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -strict experimental -movflags +faststart -map 0:v:0 -map 0:a? "${outFile}"`,
    // Strategy 2: Same but without subtitle mapping (in case subs cause issues)
    `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -strict experimental -movflags +faststart -map 0:v:0 -map 0:a? -map 0:s? "${outFile}"`,
    // Strategy 3: Stream copy (remux only) — fastest, preserves quality
    `ffmpeg -y -i "${inputPath}" -c copy -movflags +faststart "${outFile}"`,
  ];

  let success = false;
  for (let i = 0; i < strategies.length; i++) {
    try {
      execSync(strategies[i], { stdio: ["pipe", "pipe", "pipe"], timeout: 1800_000 }); // 30 min timeout
      if (existsSync(outFile) && statSync(outFile).size > 1024) {
        success = true;
        log(`strategy ${i + 1} succeeded, output: ${statSync(outFile).size} bytes`);
        break;
      }
    } catch (e) {
      log(`strategy ${i + 1} failed: ${e.message?.slice(0, 200)}`);
      try { unlinkSync(outFile); } catch {}
    }
  }

  if (!success) {
    throw new Error("all FFmpeg conversion strategies failed");
  }

  return outFile;
}

/** Ensure MP4 file has faststart (moov atom at front for streaming). In-place fix. */
function ensureFastStartOnDisk(filePath) {
  const outFile = join(WORK_DIR, "faststart_" + basename(filePath));

  try {
    // Always remux with faststart — it's a copy operation so very fast
    execSync(`ffmpeg -y -i "${filePath}" -c copy -movflags +faststart "${outFile}"`, {
      timeout: 600_000, // 10 min
    });
    if (existsSync(outFile) && statSync(outFile).size > 1024) {
      log("faststart ensured on disk");
      return outFile;
    }
  } catch (e) {
    log(`faststart check failed (non-fatal): ${e.message?.slice(0, 100)}`);
  }
  try { unlinkSync(outFile); } catch {}
  return filePath; // return original if faststart fails
}

/** Extract subtitles from video file on disk. Returns array of {filePath, filename}. */
function extractSubtitlesOnDisk(inputPath, inputName) {
  let probeOutput;
  try {
    probeOutput = execSync(
      `ffprobe -v quiet -print_format json -show_streams -select_streams s "${inputPath}"`,
      { encoding: "utf-8", timeout: 60_000 }
    );
  } catch {
    log("ffprobe failed, no subtitles detected");
    return [];
  }

  let probeJson;
  try { probeJson = JSON.parse(probeOutput); } catch {
    log("ffprobe output parse failed");
    return [];
  }

  const subStreams = probeJson.streams || [];
  if (subStreams.length === 0) {
    log("no subtitle streams found");
    return [];
  }

  log(`found ${subStreams.length} subtitle stream(s)`);

  const subs = [];
  const seenLangs = new Set();

  for (const stream of subStreams) {
    const idx = stream.index;
    let lang = (stream.tags?.language || stream.tags?.lang || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (!lang) lang = `und${idx}`;
    const codec = stream.codec_name || "";

    // Skip duplicate languages
    if (seenLangs.has(lang)) continue;
    seenLangs.add(lang);

    // Choose output format based on codec
    let ext = ".srt";
    let extractCodec = "srt";
    if (codec === "ass" || codec === "ssa") {
      ext = ".ass";
      extractCodec = "ass";
    } else if (codec === "webvtt") {
      ext = ".vtt";
      extractCodec = "webvtt";
    } else if (codec === "subrip" || codec === "srt") {
      ext = ".srt";
      extractCodec = "srt";
    }

    const baseName = basename(inputName, extname(inputName));
    const subFilename = `${baseName}_${lang}${ext}`;
    const subFile = join(WORK_DIR, subFilename);

    const cmd = `ffmpeg -y -i "${inputPath}" -map 0:${idx} -c:s ${extractCodec} "${subFile}"`;

    try {
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
      const subSize = statSync(subFile).size;
      if (subSize > 10) {
        subs.push({ filePath: subFile, filename: subFilename });
        log(`extracted subtitle: ${subFilename} (${subSize} bytes)`);
      } else {
        try { unlinkSync(subFile); } catch {}
      }
    } catch (e) {
      log(`failed to extract subtitle stream ${idx}: ${e.message?.slice(0, 100)}`);
      try { unlinkSync(subFile); } catch {}
    }
  }

  return subs;
}

/** Generate thumbnail from video file. Returns {filePath, filename} or null. */
function generateThumbnail(inputPath, inputName) {
  const baseName = basename(inputName, extname(inputName));
  const thumbFile = join(WORK_DIR, `${baseName}_thumb.jpg`);

  try {
    // Try to grab a frame at 10% of the video duration, or at 5 seconds
    execSync(
      `ffmpeg -y -ss 5 -i "${inputPath}" -vframes 1 -q:v 2 -vf "scale=640:-2" "${thumbFile}"`,
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
    );
    if (existsSync(thumbFile) && statSync(thumbFile).size > 500) {
      log(`thumbnail generated: ${thumbFile} (${statSync(thumbFile).size} bytes)`);
      return { filePath: thumbFile, filename: `${baseName}_thumb.jpg` };
    }
  } catch (e) {
    log(`thumbnail generation failed (non-fatal): ${e.message?.slice(0, 100)}`);
  }
  try { unlinkSync(thumbFile); } catch {}
  return null;
}

/** Get video info using ffprobe. Returns object with duration, resolution, codec, etc. */
function getVideoInfo(filePath) {
  try {
    const probe = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { encoding: "utf-8", timeout: 60_000 }
    );
    const info = JSON.parse(probe);
    const videoStream = (info.streams || []).find(s => s.codec_type === "video");
    const audioStream = (info.streams || []).find(s => s.codec_type === "audio");
    const format = info.format || {};

    return {
      duration: format.duration ? parseFloat(format.duration) : null,
      size: format.size ? parseInt(format.size) : null,
      bitrate: format.bit_rate ? parseInt(format.bit_rate) : null,
      video_codec: videoStream?.codec_name || "unknown",
      video_resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : "unknown",
      video_fps: videoStream?.r_frame_rate || "unknown",
      audio_codec: audioStream?.codec_name || "none",
      audio_sample_rate: audioStream?.sample_rate || "none",
      subtitle_count: (info.streams || []).filter(s => s.codec_type === "subtitle").length,
    };
  } catch (e) {
    log(`ffprobe failed: ${e.message?.slice(0, 100)}`);
    return null;
  }
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

  // ── Step 1: Download file to disk using curl (most reliable for large files) ──
  log("downloading source:", resolvedUrl);

  let workName = overrideName || guessFilename(srcArg, null) || "file";
  const dlPath = join(WORK_DIR, "download" + (extname(workName).toLowerCase() || ".bin"));
  let contentType = "application/octet-stream";

  // First, do a HEAD request to check content-type and get filename
  try {
    const headRes = await fetch(resolvedUrl, { method: "HEAD", redirect: "follow", headers: downloadHeaders });
    contentType = headRes.headers.get("content-type") || "application/octet-stream";
    if (contentType.startsWith("text/html") && !srcArg.endsWith(".html") && !srcArg.endsWith(".htm")) {
      throw new Error(
        `source returned HTML (content-type: ${contentType}), not a file. ` +
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
    // HEAD might not be supported — we'll discover content-type during download
    log("HEAD request failed, will check content-type after download");
  }

  // Download with curl — handles large files, redirects, retries natively
  const headerArgs = Object.entries(downloadHeaders || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(" ");
  const curlCmd = `curl -fSL --retry 3 --retry-delay 5 -o "${dlPath}" ${headerArgs} "${resolvedUrl}"`;
  log("downloading with curl...");
  try {
    execSync(curlCmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 1800_000 }); // 30 min
  } catch (curlErr) {
    // If curl fails, try fetch as fallback (for environments without curl)
    log("curl failed, trying fetch-based download...");
    const dlResponse = await fetch(resolvedUrl, { redirect: "follow", headers: downloadHeaders });
    if (!dlResponse.ok) throw new Error(`source fetch ${dlResponse.status} ${resolvedUrl}`);
    contentType = dlResponse.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await dlResponse.arrayBuffer());
    writeFileSync(dlPath, buf);
  }

  const dlSize = statSync(dlPath).size;
  log(`download complete: ${dlSize} bytes (${(dlSize / 1024 / 1024).toFixed(1)} MB)`);

  const isVideo = isVideoFilename(workName);

  // ── Step 2: Get video info ──
  let videoInfo = null;
  if (isVideo) {
    videoInfo = getVideoInfo(dlPath);
    if (videoInfo) {
      log(`video info: ${videoInfo.video_codec} ${videoInfo.video_resolution} ${videoInfo.duration?.toFixed(1)}s ${videoInfo.subtitle_count} subs`);
    }
  }

  // ── Step 3: Extract subtitles from ORIGINAL (before conversion) ──
  let subtitleResults = [];
  if (isVideo && EXTRACT_SUBS) {
    log("checking for subtitles...");
    try {
      const subs = extractSubtitlesOnDisk(dlPath, workName);
      for (const sub of subs) {
        log(`uploading subtitle: ${sub.filename}`);
        const subResult = await uploadFileFromDisk(sub.filePath, sub.filename, "text/plain");
        if (subResult) subtitleResults.push(subResult);
        // Cleanup subtitle file
        try { unlinkSync(sub.filePath); } catch {}
      }
    } catch (e) {
      log(`subtitle extraction/upload failed (non-fatal): ${e.message}`);
    }
  }

  // ── Step 4: Convert video to MP4 if needed ──
  let finalVideoPath = dlPath;
  let converted = false;

  if (isVideo && CONVERT_TO_MP4 && !isAlreadyMp4(workName)) {
    log(`converting ${workName} to MP4 on disk...`);
    try {
      finalVideoPath = convertToMp4OnDisk(dlPath, workName);
      workName = basename(workName, extname(workName)) + ".mp4";
      converted = true;
      log(`conversion done, MP4 size: ${(statSync(finalVideoPath).size / 1024 / 1024).toFixed(1)} MB`);

      // Delete original download to free disk space
      if (finalVideoPath !== dlPath) {
        try { unlinkSync(dlPath); log("deleted original download to free disk space"); } catch {}
      }
    } catch (e) {
      log(`FFmpeg conversion failed: ${e.message}`);
      log("uploading original file instead (may not be streamable)...");
      finalVideoPath = dlPath;
    }
  } else if (isVideo && isAlreadyMp4(workName)) {
    // Already MP4 — ensure faststart for streaming
    log("already MP4, ensuring streamable (faststart) on disk...");
    const fsResult = ensureFastStartOnDisk(dlPath);
    if (fsResult !== dlPath) {
      finalVideoPath = fsResult;
      converted = true;
      // Delete original if faststart created a new file
      try { unlinkSync(dlPath); log("deleted original MP4, keeping faststart version"); } catch {}
    }
  }

  // ── Step 5: Generate thumbnail ──
  let thumbResult = null;
  if (isVideo) {
    try {
      const thumb = generateThumbnail(finalVideoPath, workName);
      if (thumb) {
        log("uploading thumbnail...");
        thumbResult = await uploadFileFromDisk(thumb.filePath, thumb.filename, "image/jpeg");
        try { unlinkSync(thumb.filePath); } catch {}
      }
    } catch (e) {
      log(`thumbnail upload failed (non-fatal): ${e.message}`);
    }
  }

  // ── Step 6: Upload main file to storage.to ──
  const mainContentType = isVideo ? "video/mp4" : (overrideType || contentType || "application/octet-stream");
  const mainResult = await uploadFileFromDisk(finalVideoPath, workName, mainContentType);

  // Cleanup final video file
  try { unlinkSync(finalVideoPath); log("cleaned up final video file"); } catch {}

  // ── Output results ──
  const output = {
    main: mainResult,
    subtitles: subtitleResults,
    thumbnail: thumbResult,
    video_info: videoInfo,
    converted: converted,
    visitor_token: VISITOR,
  };

  process.stdout.write("RESULT_JSON_BEGIN\n" + JSON.stringify(output, null, 2) + "\nRESULT_JSON_END\n");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
