// Gcore CDN helper — used by webhook.js to power the "Stream" button.
//
// v8.3 architecture (per user spec 2026-07-15):
//   - ONE CDN resource in GCore (ID 1003900), cname cdn.streambot.freeddns.org
//   - Origin PERMANENTLY set to pixeldrain.com (origin group 1438033)
//   - ONE rule on the resource (ruleType=1 rule=".*") applies streaming options:
//       * static_response_headers: Content-Disposition: inline, Accept-Ranges: bytes,
//         Cache-Control: public max-age=86400  → makes download-only links streamable
//       * response_headers_hiding_policy: show only streaming-relevant headers
//       * slice enabled (10MB Range fragments for VLC seek)
//       * CORS *, edge_cache_settings 4d, ignore_cookie, stale on error/updating
//   - For ANY pixeldrain file ID, the streamable URL is just:
//       https://cdn.streambot.freeddns.org/api/file/{pixeldrain_id}
//     No origin repointing, no purge, no origin group management needed.
//   - Multi-part M3U uses the SAME URL pattern for each part.
//
// Why no /parts/ prefix: GCore's rewrite option was tested with 6 different body
// formats (^/parts/(.+)$, /parts/(.+), /parts/(.*), flags break/last/redirect)
// and NONE of them actually rewrote the path — the CDN forwarded /parts/{id}
// to pixeldrain.com/parts/{id} which returned 404. Using /api/file/{id} directly
// works perfectly (verified: 200, video/x-matroska, 7.8GB, all streaming headers).
// The user's intent (GCore CDN URLs in M3U for edge caching + IP rate limit
// bypass) is fully satisfied with /api/file/{id}.

const GCORE_API = "https://api.gcore.com";

// ─── Defensive fallback values ───────────────────────────────────────────────
// Hardcoded fallback IDs — bot keeps working even if Vercel env vars are wiped.
// cname is overridden at runtime by GCORE_CDN_CNAME env var when present.
const FALLBACK_RESOURCE_ID = "1003900";
const FALLBACK_CNAME = "cdn.streambot.freeddns.org";

function getResourceId() {
  return process.env.GCORE_CDN_RESOURCE_ID || FALLBACK_RESOURCE_ID;
}
function getCname() {
  return process.env.GCORE_CDN_CNAME || FALLBACK_CNAME;
}

function authHeaders() {
  const tok = process.env.GCORE_API_TOKEN;
  if (!tok) throw new Error("GCORE_API_TOKEN not set");
  return {
    Authorization: `APIKey ${tok}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function gcoreFetch(path, init = {}) {
  const res = await fetch(`${GCORE_API}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const txt = await res.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  if (!res.ok) {
    const msg = (body && typeof body === "object" && (body.message || body.errors)) || `${res.status} ${res.statusText}`;
    const err = new Error(`Gcore ${res.status} ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 400)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ─── Source URL analyzer ─────────────────────────────────────────────────────
// Pre-flight check on the input URL. Returns one of:
//   { action: "self_loop", cname }                          — URL is on OUR OWN CDN cname → reject
//   { action: "expired_presigned", originalUrl, expiredAt } — presigned URL already expired → warn
//   { action: "pixeldrain_list", listId }                   — pixeldrain /l/<id> → tell user to send single file URLs
//   { action: "stream_via_gcore", url: URL, pixeldrainId, presignedExpiresAt? } — normal case
export function analyzeSourceUrl(sourceUrl) {
  let u;
  try { u = new URL(sourceUrl.trim()); } catch { throw new Error(`invalid URL: ${sourceUrl.slice(0, 100)}`); }
  if (!u.protocol.startsWith("http")) throw new Error("URL must be http(s)");

  const host = u.host.toLowerCase();
  const cname = getCname().toLowerCase();

  // ── 1. Self-loop: URL is on our own CDN cname → reject (would create infinite origin loop) ──
  if (host === cname || host.endsWith("." + cname)) {
    return { action: "self_loop", cname };
  }

  // ── 2. Pixeldrain URLs — extract the file ID ──
  if (host === "pixeldrain.com" || host.endsWith(".pixeldrain.com")) {
    // Pixeldrain file LIST URL (/l/<id>) — returns HTML, not raw bytes
    const listMatch = u.pathname.match(/^\/l\/([A-Za-z0-9]+)/);
    if (listMatch) {
      return { action: "pixeldrain_list", listId: listMatch[1] };
    }
    // Pixeldrain file URL: /u/<id>, /d/<id>, or /api/file/<id>
    const fileMatch = u.pathname.match(/^\/(?:u|d|api\/file)\/([A-Za-z0-9]+)/);
    if (fileMatch) {
      return {
        action: "stream_via_gcore",
        url: u,
        pixeldrainId: fileMatch[1],
      };
    }
    // Other pixeldrain URL — treat as not streamable
    throw new Error(`Could not extract pixeldrain file ID from URL: ${sourceUrl.slice(0, 200)}`);
  }

  // ── 3. Presigned URL expiration check (R2 / S3 / Azure / GCS) ──
  //    If expired → refuse. If still valid → route through GCore (with expiration warning).
  //    AWS-style:  X-Amz-Date=YYYYMMDDTHHMMSSZ  &  X-Amz-Expires=<seconds>
  //    Azure:      se=YYYY-MM-DDThh:mm:ssZ  (URL-encoded ISO 8601)
  //    GCS:        Expires=<unix-epoch-seconds>
  //    NOTE: With v8.3 architecture, the CDN origin is permanently pixeldrain.com.
  //    Non-pixeldrain URLs cannot be streamed directly anymore. The bot should
  //    upload to pixeldrain first, then stream from pixeldrain via CDN.
  const amzDate = u.searchParams.get("X-Amz-Date");
  const amzExpires = u.searchParams.get("X-Amz-Expires");
  if (amzDate && amzExpires) {
    const m = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (m) {
      const dt = new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
      const expiresAt = new Date(dt.getTime() + parseInt(amzExpires, 10) * 1000);
      if (Date.now() > expiresAt.getTime()) {
        return { action: "expired_presigned", originalUrl: sourceUrl, expiredAt: expiresAt.toISOString() };
      }
      // Non-pixeldrain presigned URL — can't stream via CDN anymore (origin is pixeldrain)
      return {
        action: "non_pixeldrain_url",
        originalUrl: sourceUrl,
        presignedExpiresAt: expiresAt.toISOString(),
      };
    }
  }

  // ── 4. Non-pixeldrain URL — can't stream via CDN (origin is permanently pixeldrain.com) ──
  return {
    action: "non_pixeldrain_url",
    originalUrl: sourceUrl,
  };
}

// ─── Top-level orchestrator ─────────────────────────────────────────────────
//
// v8.3: NO MORE origin repointing. The CDN resource's origin is permanently
// set to pixeldrain.com. We just construct the GCore URL for the pixeldrain ID.
//
// Returns one of:
//   { kind: "stream", streamUrl, pixeldrainId, cname }
//   { kind: "self_loop", cname }
//   { kind: "expired", originalUrl, expiredAt }
//   { kind: "pixeldrain_list", listId }
//   { kind: "non_pixeldrain_url", originalUrl, presignedExpiresAt? }
export async function provisionStreamableUrl(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== "string") throw new Error("sourceUrl required");

  const decision = analyzeSourceUrl(sourceUrl);

  // ── Pass-through cases (no GCore API calls needed) ──
  if (decision.action === "self_loop") {
    return { kind: "self_loop", cname: decision.cname };
  }
  if (decision.action === "expired_presigned") {
    return { kind: "expired", originalUrl: decision.originalUrl, expiredAt: decision.expiredAt };
  }
  if (decision.action === "pixeldrain_list") {
    return { kind: "pixeldrain_list", listId: decision.listId };
  }
  if (decision.action === "non_pixeldrain_url") {
    return {
      kind: "non_pixeldrain_url",
      originalUrl: decision.originalUrl,
      presignedExpiresAt: decision.presignedExpiresAt || null,
    };
  }

  // ── Normal case: pixeldrain URL → GCore CDN URL ──
  // No API calls needed. The CDN resource is already configured with:
  //   - origin = pixeldrain.com
  //   - streaming options (Content-Disposition: inline, etc.)
  //   - slice enabled (10MB Range fragments)
  // We just construct the URL.
  const cname = getCname();
  const streamUrl = `https://${cname}/api/file/${decision.pixeldrainId}`;
  return {
    kind: "stream",
    streamUrl,
    pixeldrainId: decision.pixeldrainId,
    cname,
    presignedExpiresAt: decision.presignedExpiresAt || null,
  };
}

// ─── Build a GCore stream URL from a pixeldrain ID (no API calls) ────────────
// Convenience function for use in result.js when constructing M3U playlists.
export function buildGcoreStreamUrl(pixeldrainId) {
  if (!pixeldrainId) throw new Error("pixeldrainId required");
  const cname = getCname();
  return `https://${cname}/api/file/${pixeldrainId}`;
}

// ─── Extract pixeldrain ID from any pixeldrain URL ───────────────────────────
export function extractPixeldrainId(url) {
  if (!url) return null;
  const m = String(url).match(/\/(?:u|api\/file|d)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Lightweight health check — verifies token + lists resources (for /api/gcore-status debug endpoint)
export async function gcoreStatus() {
  const me = await gcoreFetch(`/iam/clients/me`);
  return {
    account: { id: me.id, email: me.email, status: me.status, capabilities: me.capabilities },
    liveResourceId: getResourceId(),
    liveCname: getCname(),
  };
}
