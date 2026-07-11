#!/usr/bin/env node
// storage-to-uploader: download → FFmpeg convert → subtitle extract → upload to storage.to
// Usage:
//   node upload.mjs <file-path-or-url> [filename] [content-type]
// Env:
//   STORAGE_TO_VISITOR_TOKEN  - reused across runs to keep "ownership" of your uploads
//   STORAGE_TO_API            - override API base (default https://storage.to/api)
//   STORAGE_TO_NO_CONFIRM     - if "1", stop after PUT (skip /upload/confirm)
//   CONVERT_TO_MP4            - if "1", convert video to MP4 (default: "1")
//   EXTRACT_SUBS              - if "1", extract subtitles (default: "1")

import { writeFileSync, readFileSync, unlinkSync, statSync, existsSync } from "node:fs";
import { readFile as readFilePromise } from "node:fs/promises";
import { basename, join, extname } from "node:path";
import { execSync } from "node:child_process";

const API = process.env.STORAGE_TO_API || "https://storage.to/api";
const VISITOR = process.env.STORAGE_TO_VISITOR_TOKEN || cryptoRandom();
const CONVERT_TO_MP4 = process.env.CONVERT_TO_MP4 !== "0";
const EXTRACT_SUBS = process.env.EXTRACT_SUBS !== "0";

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

async function uploadBuffer(buffer, filename, contentType) {
  log(`upload: filename=${filename} size=${buffer.length} type=${contentType}`);
  const init = await api("/upload/init", {
    filename,
    content_type: contentType,
    size: buffer.length,
  });

  if (init.type === "single") {
    log("single PUT to R2, size=", buffer.length);
    const putRes = await fetch(init.upload_url, {
      method: "PUT",
      headers: init.headers || {},
      body: buffer,
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      throw new Error(`R2 PUT ${putRes.status}: ${t}`);
    }
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
      const end = Math.min(start + partSize, buffer.length);
      const chunk = buffer.subarray(start, end);
      log(`part ${partNumber}/${totalParts}: bytes ${start}-${end} (${chunk.length})`);
      const pr = await fetch(partUrl, { method: "PUT", body: chunk });
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
    throw new Error(`unexpected init response: ${JSON.stringify(init)}`);
  }

  if (process.env.STORAGE_TO_NO_CONFIRM === "1") {
    log("skipping confirm");
    return null;
  }

  log("confirm");
  const confirm = await api("/upload/confirm", {
    filename,
    size: buffer.length,
    content_type: contentType,
    r2_key: init.r2_key,
  });

  const f = confirm.file;
  log("done:", f.url);
  return {
    url: f.url,
    raw_url: f.raw_url,
    file_id: f.id,
    filename: f.filename,
    size: f.size,
    human_size: f.human_size,
    expires_at: f.expires_at,
  };
}

// ─── URL resolvers ───────────────────────────────────────────────

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function resolveSource(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();

  if (host === "pixeldrain.com" || host === "www.pixeldrain.com") {
    const m = u.pathname.match(/^\/(?:u|api\/file|d)\/([A-Za-z0-9]+)/);
    if (m) {
      const fixed = new URL(`/api/file/${m[1]}?download`, u);
      return { url: fixed.toString(), headers: { "User-Agent": UA } };
    }
  }

  return { url: rawUrl, headers: { "User-Agent": UA } };
}

async function getSource(src) {
  if (/^https?:\/\//i.test(src)) {
    const { url, headers } = resolveSource(src);
    log("downloading source:", url);
    const r = await fetch(url, { redirect: "follow", headers });
    if (!r.ok) throw new Error(`source fetch ${r.status} ${url}`);
    const contentType = r.headers.get("content-type") || "application/octet-stream";
    if (contentType.startsWith("text/html") && !src.endsWith(".html") && !src.endsWith(".htm")) {
      throw new Error(`source returned HTML (content-type: ${contentType}), not a file. ` +
        `The URL may be a share-page link rather than a direct download link.`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const filename = guessFilename(src, r.headers.get("content-disposition"));
    return { buffer: buf, size: buf.length, filename, contentType };
  }
  const st = statSync(src);
  log("reading local file:", src, st.size, "bytes");
  const buf = await readFilePromise(src);
  return { buffer: buf, size: st.size, filename: basename(src), contentType: "application/octet-stream" };
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

/** Convert video buffer to MP4 using FFmpeg. Returns converted buffer. */
function convertToMp4Sync(inputBuf, inputName) {
  const tmpDir = `/tmp/storageto_conv_${Date.now()}`;
  execSync(`mkdir -p ${tmpDir}`);
  const inFile = join(tmpDir, "input" + extname(inputName).toLowerCase());
  const outFile = join(tmpDir, "output.mp4");

  writeFileSync(inFile, inputBuf);

  log("converting to MP4 with FFmpeg (H.264 + AAC, faststart)...");

  // Strategy 1: Full re-encode with H.264 + AAC + faststart
  const strategies = [
    // Strategy 1: Re-encode video, keep all audio + subs
    `ffmpeg -y -i "${inFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -strict experimental -movflags +faststart -map 0:v:0 -map 0:a? -map 0:s? "${outFile}"`,
    // Strategy 2: Re-encode without subtitle mapping
    `ffmpeg -y -i "${inFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -strict experimental -movflags +faststart -map 0:v:0 -map 0:a? "${outFile}"`,
    // Strategy 3: Stream copy (no re-encode) — just remux to MP4 container + faststart
    `ffmpeg -y -i "${inFile}" -c copy -movflags +faststart "${outFile}"`,
  ];

  let success = false;
  for (let i = 0; i < strategies.length; i++) {
    try {
      execSync(strategies[i], { stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 });
      if (existsSync(outFile) && statSync(outFile).size > 1024) {
        success = true;
        break;
      }
    } catch (e) {
      log(`strategy ${i + 1} failed: ${e.message?.slice(0, 150)}`);
      // Clean up failed output file
      try { unlinkSync(outFile); } catch {}
    }
  }

  if (!success) {
    throw new Error("all FFmpeg conversion strategies failed");
  }

  const outBuf = readFileSync(outFile);
  log(`converted: ${inputBuf.length} bytes → ${outBuf.length} bytes (MP4)`);

  // Cleanup
  try { unlinkSync(inFile); } catch {}
  try { unlinkSync(outFile); } catch {}

  return outBuf;
}

/** Ensure MP4 has faststart (moov atom at front for streaming). In-place fix. */
function ensureFastStart(inputBuf) {
  const tmpDir = `/tmp/storageto_fs_${Date.now()}`;
  execSync(`mkdir -p ${tmpDir}`);
  const inFile = join(tmpDir, "input.mp4");
  const outFile = join(tmpDir, "output.mp4");

  writeFileSync(inFile, inputBuf);

  try {
    // Check if already has faststart by looking at moov position
    const probe = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${inFile}"`, { encoding: "utf-8", timeout: 30_000 });
    // Just always add faststart — it's a copy operation so very fast
    execSync(`ffmpeg -y -i "${inFile}" -c copy -movflags +faststart "${outFile}"`, { timeout: 300_000 });
    const outBuf = readFileSync(outFile);
    log("faststart ensured");
    try { unlinkSync(inFile); } catch {}
    try { unlinkSync(outFile); } catch {}
    return outBuf;
  } catch (e) {
    log(`faststart check failed (non-fatal): ${e.message?.slice(0, 100)}`);
    try { unlinkSync(inFile); } catch {}
    try { unlinkSync(outFile); } catch {}
    return inputBuf; // return original if faststart fails
  }
}

/** Extract subtitles from video buffer. Returns array of {buffer, filename}. */
function extractSubtitlesSync(inputBuf, inputName) {
  const tmpDir = `/tmp/storageto_subs_${Date.now()}`;
  execSync(`mkdir -p ${tmpDir}`);
  const inFile = join(tmpDir, "input" + extname(inputName).toLowerCase());

  writeFileSync(inFile, inputBuf);

  // Probe for subtitle streams
  let probeOutput;
  try {
    probeOutput = execSync(
      `ffprobe -v quiet -print_format json -show_streams -select_streams s "${inFile}"`,
      { encoding: "utf-8", timeout: 30_000 }
    );
  } catch {
    log("ffprobe failed, no subtitles detected");
    try { unlinkSync(inFile); } catch {}
    return [];
  }

  let probeJson;
  try { probeJson = JSON.parse(probeOutput); } catch {
    log("ffprobe output parse failed");
    try { unlinkSync(inFile); } catch {}
    return [];
  }

  const subStreams = probeJson.streams || [];
  if (subStreams.length === 0) {
    log("no subtitle streams found");
    try { unlinkSync(inFile); } catch {}
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
    }

    const baseName = basename(inputName, extname(inputName));
    const subFile = join(tmpDir, `${baseName}_${lang}${ext}`);

    const cmd = `ffmpeg -y -i "${inFile}" -map 0:${idx} -c:s ${extractCodec} "${subFile}"`;

    try {
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
      const subBuf = readFileSync(subFile);
      if (subBuf.length > 10) {
        subs.push({ buffer: subBuf, filename: `${baseName}_${lang}${ext}` });
        log(`extracted subtitle: ${baseName}_${lang}${ext} (${subBuf.length} bytes)`);
      }
      try { unlinkSync(subFile); } catch {}
    } catch (e) {
      log(`failed to extract subtitle stream ${idx}: ${e.message?.slice(0, 100)}`);
    }
  }

  try { unlinkSync(inFile); } catch {}
  return subs;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const [, , srcArg, overrideName, overrideType] = process.argv;
  if (!srcArg) {
    console.error("usage: upload.mjs <file-or-url> [filename] [content-type]");
    process.exit(2);
  }

  const source = await getSource(srcArg);
  let workBuf = source.buffer;
  let workName = overrideName || source.filename || "file";
  const isVideo = isVideoFilename(workName);

  // ── Step 1: If video, extract subtitles from ORIGINAL (before conversion) ──
  let subtitleResults = [];
  if (isVideo && EXTRACT_SUBS) {
    log("checking for subtitles...");
    try {
      const subs = extractSubtitlesSync(workBuf, workName);
      for (const sub of subs) {
        log(`uploading subtitle: ${sub.filename}`);
        const subResult = await uploadBuffer(sub.buffer, sub.filename, "text/plain");
        if (subResult) subtitleResults.push(subResult);
      }
    } catch (e) {
      log(`subtitle extraction/upload failed (non-fatal): ${e.message}`);
    }
  }

  // ── Step 2: Convert video to MP4 if needed ──
  if (isVideo && CONVERT_TO_MP4 && !isAlreadyMp4(workName)) {
    log(`converting ${workName} to MP4...`);
    try {
      workBuf = convertToMp4Sync(workBuf, workName);
      workName = basename(workName, extname(workName)) + ".mp4";
    } catch (e) {
      log(`FFmpeg conversion failed: ${e.message}`);
      log("uploading original file instead (may not be streamable)...");
    }
  } else if (isVideo && isAlreadyMp4(workName)) {
    // Already MP4 — ensure faststart for streaming
    log("already MP4, ensuring streamable (faststart)...");
    workBuf = ensureFastStart(workBuf);
  }

  // ── Step 3: Upload main file to storage.to ──
  const contentType = isVideo ? "video/mp4" : (overrideType || source.contentType || "application/octet-stream");
  const mainResult = await uploadBuffer(workBuf, workName, contentType);

  // ── Output results ──
  const output = {
    main: mainResult,
    subtitles: subtitleResults,
    visitor_token: VISITOR,
  };

  process.stdout.write("RESULT_JSON_BEGIN\n" + JSON.stringify(output, null, 2) + "\nRESULT_JSON_END\n");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
