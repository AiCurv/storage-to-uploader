#!/usr/bin/env node
// Anonymous upload to storage.to using a persistent visitor token.
// Usage:
//   node upload.mjs <file-path-or-url> [filename] [content-type]
// Env:
//   STORAGE_TO_VISITOR_TOKEN  - reused across runs to keep "ownership" of your uploads
//                               (falls back to a per-run token if unset)
//   STORAGE_TO_API            - override API base (default https://storage.to/api)

import { createReadStream, statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";

const API = process.env.STORAGE_TO_API || "https://storage.to/api";
const VISITOR = process.env.STORAGE_TO_VISITOR_TOKEN || cryptoRandom();

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function log(...a) {
  console.log(`[storage-to] ${new Date().toISOString()}`, ...a);
}

async function fetchRemote(url) {
  log("downloading source:", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download failed: ${r.status} ${r.statusText}`);
  const total = Number(r.headers.get("content-length") || 0);
  log("downloaded headers, content-length:", total || "unknown");
  return { stream: r.body, size: total, filename: filenameFrom(url, r) };
}

function filenameFrom(url, resp) {
  const cd = resp.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1]);
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return last;
  } catch {}
  return "upload.bin";
}

function localSource(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const size = statSync(path).size;
  return { stream: createReadStream(path), size, filename: basename(path) };
}

function streamToBuffer(stream) {
  // For small files (e.g. test payloads) we buffer; for big files we pipe.
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function nodeStreamToWeb(stream) {
  return Readable.toWeb(stream);
}

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
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`bad JSON from ${path}: ${r.status} ${text.slice(0, 200)}`);
  }
  if (!r.ok || json.success === false) {
    throw new Error(`api ${path} failed: ${r.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function putParts(r2Key, partSize, totalParts, initialUrls, getStream) {
  const partUrls = new Map();
  for (const [k, v] of Object.entries(initialUrls || {})) {
    partUrls.set(Number(k), v);
  }

  const completed = [];
  for (let n = 1; n <= totalParts; n++) {
    if (!partUrls.has(n)) {
      const need = [];
      for (let i = 1; i <= totalParts; i++) if (!partUrls.has(i)) need.push(i);
      const extra = await api("/upload/parts", {
        upload_id: r2Key,
        part_numbers: need,
      });
      for (const p of extra.part_urls) partUrls.set(p.partNumber, p.url);
    }
    const url = partUrls.get(n);
    if (!url) throw new Error(`no url for part ${n}`);

    const start = (n - 1) * partSize;
    const end = Math.min(start + partSize, getStream.size);
    const buf = await streamToBuffer(getStream.stream, start, end);
    log(`uploading part ${n}/${totalParts} (${(buf.length / 1e6).toFixed(2)} MB)`);
    const put = await fetch(url, { method: "PUT", body: buf });
    if (!put.ok) {
      throw new Error(`PUT part ${n} failed: ${put.status} ${await put.text()}`);
    }
    const etag = put.headers.get("etag") || put.headers.get("ETag");
    completed.push({ partNumber: n, etag });
  }
  return completed;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: node upload.mjs <file-path-or-url> [filename] [content-type]");
    process.exit(2);
  }
  const overrideName = process.argv[3];
  const overrideType = process.argv[4];

  const isUrl = /^https?:\/\//i.test(input);
  const src = isUrl ? await fetchRemote(input) : localSource(input);
  const filename = overrideName || src.filename;
  const contentType = overrideType || "application/octet-stream";
  const size = src.size || 0;

  log("init: filename=", filename, "size=", size, "type=", contentType);
  const init = await api("/upload/init", { filename, content_type: contentType, size });

  let r2Key, confirmBody;
  if (init.type === "single") {
    log("single PUT to R2, size=", size);
    const buf = await streamToBuffer(src.stream);
    const put = await fetch(init.upload_url, { method: "PUT", body: buf });
    if (!put.ok) throw new Error(`PUT failed: ${put.status} ${await put.text()}`);
    r2Key = init.r2_key;
    confirmBody = { filename, size, content_type: contentType, r2_key: r2Key };
  } else {
    log(
      "multipart: parts=",
      init.total_parts,
      "part_size=",
      init.part_size,
      "upload_id=",
      init.upload_id
    );
    const completed = await putParts(
      init.upload_id,
      init.part_size,
      init.total_parts,
      init.initial_urls,
      { stream: src.stream, size }
    );
    await api("/upload/complete-multipart", {
      upload_id: init.upload_id,
      parts: completed,
    });
    r2Key = init.r2_key;
    confirmBody = { filename, size, content_type: contentType, r2_key: r2Key };
  }

  log("confirming");
  const conf = await api("/upload/confirm", confirmBody);
  const out = {
    url: conf.file.url,
    raw_url: conf.file.raw_url,
    id: conf.file.id,
    filename: conf.file.filename,
    size: conf.file.size,
    expires_at: conf.file.expires_at,
    owner_token: conf.owner_token,
    visitor_token: VISITOR,
  };
  console.log("RESULT_JSON_BEGIN");
  console.log(JSON.stringify(out, null, 2));
  console.log("RESULT_JSON_END");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
