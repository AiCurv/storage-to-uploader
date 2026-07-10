#!/usr/bin/env node
// Anonymous upload to storage.to using a persistent visitor token.
// Usage:
//   node upload.mjs <file-path-or-url> [filename] [content-type]
// Env:
//   STORAGE_TO_VISITOR_TOKEN  - reused across runs to keep "ownership" of your uploads
//                               (falls back to a per-run token if unset)
//   STORAGE_TO_API            - override API base (default https://storage.to/api)
//   STORAGE_TO_NO_CONFIRM     - if "1", stop after PUT (skip /upload/confirm)

import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

const API = process.env.STORAGE_TO_API || "https://storage.to/api";
const VISITOR = process.env.STORAGE_TO_VISITOR_TOKEN || cryptoRandom();

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function log(...args) {
  console.error("[storage-to]", new Date().toISOString(), ...args);
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
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok || json.success === false) {
    throw new Error(`api ${path} ${r.status}: ${text}`);
  }
  return json;
}

async function getSource(src) {
  if (/^https?:\/\//i.test(src)) {
    log("downloading source:", src);
    const r = await fetch(src);
    if (!r.ok) throw new Error(`source fetch ${r.status} ${src}`);
    const sizeHeader = r.headers.get("content-length");
    const buf = Buffer.from(await r.arrayBuffer());
    const filename = guessFilename(src, r.headers.get("content-disposition"));
    return { buffer: buf, size: buf.length, filename, contentType: r.headers.get("content-type") || "application/octet-stream" };
  }
  const st = statSync(src);
  log("reading local file:", src, st.size, "bytes");
  const buf = await BunOrFsRead(src);
  return { buffer: buf, size: st.size, filename: basename(src), contentType: "application/octet-stream" };
}

async function BunOrFsRead(p) {
  const { readFile } = await import("node:fs/promises");
  return readFile(p);
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

async function main() {
  const [, , srcArg, overrideName, overrideType] = process.argv;
  if (!srcArg) {
    console.error("usage: upload.mjs <file-or-url> [filename] [content-type]");
    process.exit(2);
  }

  const source = await getSource(srcArg);
  const filename = overrideName || source.filename || "file";
  const contentType = overrideType || source.contentType || "application/octet-stream";
  log(`init: filename=${filename} size=${source.size} type=${contentType}`);

  const init = await api("/upload/init", {
    filename,
    content_type: contentType,
    size: source.size,
  });

  let file;
  if (init.type === "single") {
    log("single PUT to R2, size=", source.size);
    const putRes = await fetch(init.upload_url, {
      method: "PUT",
      headers: init.headers || {},
      body: source.buffer,
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
      const partUrl = init.initial_urls[String(partNumber)];
      if (!partUrl) {
        const more = await api("/upload/parts", {
          upload_id: init.upload_id,
          part_numbers: Array.from({ length: Math.min(totalParts - i, 50) }, (_, k) => i + k + 1),
        });
        for (const p of more.part_urls) {
          init.initial_urls[String(p.partNumber)] = p.url;
        }
      }
      const url = init.initial_urls[String(partNumber)];
      const start = i * partSize;
      const end = Math.min(start + partSize, source.size);
      const chunk = source.buffer.subarray(start, end);
      log(`part ${partNumber}/${totalParts}: bytes ${start}-${end} (${chunk.length})`);
      const pr = await fetch(url, { method: "PUT", body: chunk });
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
    log("skipping confirm (STORAGE_TO_NO_CONFIRM=1)");
    return;
  }

  log("confirm");
  const confirm = await api("/upload/confirm", {
    filename,
    size: source.size,
    content_type: contentType,
    r2_key: init.r2_key,
  });

  const f = confirm.file;
  log("done:", f.url);

  const result = {
    url: f.url,
    raw_url: f.raw_url,
    file_id: f.id,
    filename: f.filename,
    size: f.size,
    human_size: f.human_size,
    expires_at: f.expires_at,
    owner_token: confirm.owner_token,
    visitor_token: VISITOR,
  };
  process.stdout.write("RESULT_JSON_BEGIN\n" + JSON.stringify(result, null, 2) + "\nRESULT_JSON_END\n");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
