// Gcore CDN helper — powers both instant stream AND post-upload stream.
//
// v8.5 architecture (per user spec 2026-07-15):
//   - ONE CDN resource (ID 1003900), cname cdn.streambot.freeddns.org
//   - Default origin: pixeldrain.com (origin group 1438033) — for post-upload streaming
//   - For INSTANT stream of an arbitrary URL: repoint origin to that URL's host,
//     return https://cdn.streambot.freeddns.org{path}?{query}
//   - For POST-UPLOAD stream (file is on pixeldrain): origin stays pixeldrain.com,
//     return https://cdn.streambot.freeddns.org/parts/{pixeldrain_id}
//   - /parts/{id} rewrite rule on the resource maps to /api/file/{id} internally
//   - Origin groups are reused (named "auto-<host>") or created on demand
//
// Why this works for a single-user bot:
//   - Only one user (TELEGRAM_ALLOWED_ID), so no concurrent repointing conflicts
//   - Instant stream leaves origin on the streamed host; next upload repoints
//     back to pixeldrain.com before the GitHub Actions run starts
//   - The result GCore link (post-upload) always works because we repoint to
//     pixeldrain.com in the confirm_upload handler before dispatching

const GCORE_API = "https://api.gcore.com";

// ─── Defensive fallback values ───────────────────────────────────────────────
const FALLBACK_RESOURCE_ID = "1003900";
const FALLBACK_CNAME = "cdn.streambot.freeddns.org";
const PIXELDRAIN_ORIGIN_GROUP_ID = "1438033"; // origin group for pixeldrain.com
const PIXELDRAIN_HOST = "pixeldrain.com";

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

// ─── Origin group management ─────────────────────────────────────────────────

/**
 * Find an existing origin group by host (named "auto-<host>").
 * Returns the group object or null.
 */
async function findOriginGroupByHost(host) {
  const groups = await gcoreFetch(`/cdn/origin_groups?per_page=1000`);
  if (!Array.isArray(groups)) return null;
  const targetName = `auto-${host}`;
  return groups.find(g => g.name === targetName) || null;
}

/**
 * Create a new origin group for a host.
 * Name: "auto-<host>" (so we can find it later)
 * Source: the host itself (port 443 for HTTPS)
 */
async function createOriginGroup(host) {
  const body = {
    name: `auto-${host}`,
    sources: [
      {
        source: host,
        backup: false,
        enabled: true,
        host_header_override: null,
      },
    ],
    use_next: true,
    proxy_next_upstream: ["error", "timeout", "invalid_header", "http_500", "http_502", "http_503", "http_504"],
    auth_type: "none",
  };
  return await gcoreFetch(`/cdn/origin_groups`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Find or create an origin group for a host.
 * Returns the origin group ID.
 */
async function findOrCreateOriginGroup(host) {
  const existing = await findOriginGroupByHost(host);
  if (existing) {
    console.log(`[_gcore] found existing origin group ${existing.id} for ${host}`);
    return existing.id;
  }
  console.log(`[_gcore] creating new origin group for ${host}`);
  const created = await createOriginGroup(host);
  console.log(`[_gcore] created origin group ${created.id} for ${host}`);
  return created.id;
}

// ─── CDN resource repointing ─────────────────────────────────────────────────

/**
 * Repoint the CDN resource to a specific origin group + host header.
 * Uses PUT /cdn/resources/{id} (GCore API requires PUT, not PATCH).
 *
 * NOTE: This also sends the current options to avoid wiping them.
 * We only change originGroup + options.hostHeader.
 */
async function repointResource(originGroupId, hostHeader) {
  const resourceId = getResourceId();
  // GCore PUT requires the full options object, otherwise it may wipe
  // existing settings. We send a minimal body with just the fields we want
  // to change — GCore accepts partial updates for the resource.
  const body = {
    originGroup: parseInt(originGroupId, 10),
    options: {
      hostHeader: {
        enabled: true,
        value: hostHeader,
      },
    },
  };
  console.log(`[_gcore] repointing resource ${resourceId} to originGroup=${originGroupId} hostHeader=${hostHeader}`);
  return await gcoreFetch(`/cdn/resources/${resourceId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * Purge the CDN cache for the resource (all URLs).
 */
async function purgeCache() {
  const resourceId = getResourceId();
  try {
    await gcoreFetch(`/cdn/resources/${resourceId}/purge`, {
      method: "POST",
      body: JSON.stringify({ purgeAll: true }),
    });
    console.log(`[_gcore] cache purged for resource ${resourceId}`);
  } catch (err) {
    // Non-fatal — purge may fail but the stream still works (just with stale cache)
    console.error(`[_gcore] purge failed (non-fatal): ${err.message}`);
  }
}

/**
 * Repoint the CDN back to pixeldrain.com (the default origin).
 * Call this before sending a post-upload GCore link to the user.
 */
export async function repointToPixeldrain() {
  await repointResource(PIXELDRAIN_ORIGIN_GROUP_ID, PIXELDRAIN_HOST);
  await purgeCache();
}

// ─── Source URL analyzer ─────────────────────────────────────────────────────
export function analyzeSourceUrl(sourceUrl) {
  let u;
  try { u = new URL(sourceUrl.trim()); } catch { throw new Error(`invalid URL: ${sourceUrl.slice(0, 100)}`); }
  if (!u.protocol.startsWith("http")) throw new Error("URL must be http(s)");

  const host = u.host.toLowerCase();
  const cname = getCname().toLowerCase();

  // ── 1. Self-loop: URL is on our own CDN cname → reject ──
  if (host === cname || host.endsWith("." + cname)) {
    return { action: "self_loop", cname };
  }

  // ── 2. Pixeldrain URLs — extract the file ID ──
  if (host === "pixeldrain.com" || host.endsWith(".pixeldrain.com")) {
    const listMatch = u.pathname.match(/^\/l\/([A-Za-z0-9]+)/);
    if (listMatch) {
      return { action: "pixeldrain_list", listId: listMatch[1] };
    }
    const fileMatch = u.pathname.match(/^\/(?:u|d|api\/file)\/([A-Za-z0-9]+)/);
    if (fileMatch) {
      return {
        action: "pixeldrain_file",
        url: u,
        pixeldrainId: fileMatch[1],
      };
    }
    throw new Error(`Could not extract pixeldrain file ID from URL: ${sourceUrl.slice(0, 200)}`);
  }

  // ── 3. Non-pixeldrain URL — needs origin repointing for instant stream ──
  return {
    action: "instant_stream",
    url: u,
    host,
    path: u.pathname,
    search: u.search,
  };
}

// ─── Top-level orchestrator: INSTANT stream (no upload) ──────────────────────
//
// For non-pixeldrain URLs: repoint CDN origin to the URL's host, return GCore URL.
// For pixeldrain URLs: no repointing needed (origin is already pixeldrain.com),
//   just construct /parts/{id} URL.
//
// Returns one of:
//   { kind: "stream", streamUrl, host?, pixeldrainId?, cname }
//   { kind: "self_loop", cname }
//   { kind: "pixeldrain_list", listId }
export async function provisionInstantStream(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== "string") throw new Error("sourceUrl required");

  const decision = analyzeSourceUrl(sourceUrl);

  if (decision.action === "self_loop") {
    return { kind: "self_loop", cname: decision.cname };
  }
  if (decision.action === "pixeldrain_list") {
    return { kind: "pixeldrain_list", listId: decision.listId };
  }

  // Pixeldrain file URL — no repointing needed, just construct /parts/{id}
  if (decision.action === "pixeldrain_file") {
    const cname = getCname();
    const streamUrl = `https://${cname}/parts/${decision.pixeldrainId}`;
    return {
      kind: "stream",
      streamUrl,
      pixeldrainId: decision.pixeldrainId,
      cname,
      repointed: false,
    };
  }

  // Non-pixeldrain URL — repoint origin to the host, then construct GCore URL
  if (decision.action === "instant_stream") {
    const { host, path, search } = decision;
    const originGroupId = await findOrCreateOriginGroup(host);
    await repointResource(originGroupId, host);
    await purgeCache();
    const cname = getCname();
    const streamUrl = `https://${cname}${path}${search || ""}`;
    return {
      kind: "stream",
      streamUrl,
      host,
      cname,
      repointed: true,
    };
  }

  throw new Error("unreachable");
}

// ─── Build a GCore stream URL from a pixeldrain ID (no API calls) ────────────
// Used by result.js for post-upload GCore links.
// Uses /parts/{id} pattern — the CDN rewrite rule maps it to /api/file/{id}.
export function buildGcoreStreamUrl(pixeldrainId) {
  if (!pixeldrainId) throw new Error("pixeldrainId required");
  const cname = getCname();
  return `https://${cname}/parts/${pixeldrainId}`;
}

// ─── Extract pixeldrain ID from any pixeldrain URL ───────────────────────────
export function extractPixeldrainId(url) {
  if (!url) return null;
  const m = String(url).match(/\/(?:u|api\/file|d|parts)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Lightweight health check
export async function gcoreStatus() {
  const me = await gcoreFetch(`/iam/clients/me`);
  return {
    account: { id: me.id, email: me.email, status: me.status, capabilities: me.capabilities },
    liveResourceId: getResourceId(),
    liveCname: getCname(),
    pixeldrainOriginGroup: PIXELDRAIN_ORIGIN_GROUP_ID,
  };
}
