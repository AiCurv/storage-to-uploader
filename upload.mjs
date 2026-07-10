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
  console.error(`[storage-to] ${new Date().toISOString()}`, ...a);
}

function emitResult(obj) {
  // Machine-readable block for CI to extract
  console.log("RESULT_JSON_BEGIN");
  console.log(JSON.stringify(obj, null, 2));
  console.log("RESULT_JSON_END");
}

async function readResponseBody(r) {
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, text: buf.toString("utf8") };
}

async function downloadToBuffer(url) {
  log("downloading source:", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`download failed: ${r.status} ${r.statusText} ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const cd = r.headers.get("content-disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const filename = m ? decodeURIComponent(m[1]) : url.split("/").pop().split("?")[0] || "file.bin";
  const contentType = r.headers.get("content-type") || "application/octet-stream";
  log(`downloaded ${buf.length} bytes, filename guess: ${filename}`);
  return { buffer: buf, filename, contentType };
}

function readLocalFile(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const size = statSync(path).size;
  return { stream: createReadStream(path), size, filename: basename(path) };
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
  const { buf, text } = await readResponseBody(r);
  if (!r.ok) throw new Error(`api ${path} ${r.status}: ${text}`);
  return buf.length ? JSON.parse(text) : {};
}

async function main() {
  const [, , sourceArg, filenameArg, contentTypeArg] = process.argv;
  if (!sourceArg) {
    console.error("usage: node upload.mjs <file-or-url> [filename] [content-type]");
    process.exit(2);
  }

  let buffer, filename, contentType, size;

  if (/^https?:\/\//i.test(sourceArg)) {
    const dl = await downloadToBuffer(sourceArg);
    buffer = dl.buffer;
    filename = filenameArg || dl.filename;
    contentType = contentTypeArg || dl.contentType;
    size = buffer.length;
  } else {
    const local = readLocalFile(sourceArg);
    filename = filenameArg || local.filename;
    contentType = contentTypeArg || "application/octet-stream";
    size = local.size;
    buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      local.stream.on("data", (c) => chunks.push(c));
      local.stream.on("end", () => resolve(Buffer.concat(chunks)));
      local.stream.on("error", reject);
    });
  }

  log(`init: filename=${filename} size=${size} type=${contentType}`);

  const init = await api("/v3/file/init", {
    filename,
    size,
    content_type: contentType,
  });
  log("init response:", JSON.stringify(init));

  let publicUrl, rawUrl;

  if (init.upload_type === "single" && init.upload_url) {
    log(`single PUT to ${new URL(init.upload_url).host}, size=${size}`);
    const r = await fetch(init.upload_url, {
      method: "PUT",
      headers: init.upload_headers || { "Content-Type": contentType },
      body: buffer,
    });
    if (!r.ok) throw new Error(`upload PUT ${r.status}: ${await r.text().catch(() => "")}`);
  } else if (init.upload_type === "multipart" && init.upload_id) {
    log(`multipart upload, ${init.parts?.length || 0} parts`);
    const partResults = [];
    for (const part of init.parts) {
      const start = part.partNumber * init.part_size;
      const end = Math.min(start + init.part_size, size);
      const chunk = buffer.subarray(start, end);
      const r = await fetch(part.upload_url, {
        method: "PUT",
        headers: part.upload_headers || { "Content-Type": contentType },
        body: chunk,
      });
      if (!r.ok) throw new Error(`part ${part.partNumber} upload ${r.status}: ${await r.text().catch(() => "")}`);
      const etag = r.headers.get("etag") || r.headers.get("ETag");
      partResults.push({ partNumber: part.partNumber, etag });
    }
    const finalize = await api("/v3/file/finalize", {
      upload_id: init.upload_id,
      parts: partResults,
    });
    log("finalize response:", JSON.stringify(finalize));
  } else {
    throw new Error("unexpected init response: " + JSON.stringify(init));
  }

  const done = await api("/v3/file/complete", {
    file_id: init.file_id,
  });
  log("complete response:", JSON.stringify(done));

  publicUrl = done.url || init.url;
  rawUrl = done.raw_url || init.raw_url;

  if (!publicUrl) throw new Error("no url in complete response");

  const out = { url: publicUrl, raw_url: rawUrl, file_id: init.file_id, filename, size };
  console.log(JSON.stringify(out, null, 2));
  emitResult(out);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
