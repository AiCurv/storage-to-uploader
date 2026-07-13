// Gcore CDN helper — used by webhook.js to power the "Instant CDN Stream" feature.
//
// Architecture (Dynu free subdomain + Gcore Let's Encrypt SSL — fully working HTTPS variant):
//   1. ONE CDN resource exists in Gcore (ID in GCORE_CDN_RESOURCE_ID env, provisioned via API).
//      Its cname in Gcore is set in GCORE_CDN_CNAME env (a Dynu free subdomain).
//      DNS CNAME: <cname>  →  Gcore per-account CNAME target (visible in Gcore portal).
//      Let's Encrypt SSL cert is auto-issued by Gcore via API:
//          POST /cdn/sslData {name, automated:true}  →  PATCH /cdn/resources/{id} {sslData, sslEnabled:true}
//      Auto-renewal is handled by Gcore.
//   2. For each /stream request we:
//        a) parse the source URL -> originHost + path + query
//        b) find or create an origin group whose source == originHost
//        c) PATCH the CDN resource to point at that origin group with video-friendly options
//           (slice enabled, hostHeader set, ignoreQueryString disabled, CORS *)
//        d) purge the resource's cache so stale entries from the previous origin are dropped
//           (cache purge stays operational using the live Resource ID from env)
//        e) return https://<GCORE_CDN_CNAME><path>?<query> — the user streams via Gcore edge
//
// The Vercel function never touches the video payload. Gcore edge pulls from origin on-the-fly.
//
// Env vars (set in Vercel project; see .env.example for full list):
//   GCORE_API_TOKEN          — permanent API token (Authorization: APIKey <token>)
//   GCORE_CDN_RESOURCE_ID    — numeric ID of the CDN resource
//   GCORE_CDN_CNAME          — serving hostname for stream URLs (the resource's cname)

const GCORE_API = "https://api.gcore.com";

// ─── Defensive fallback values ───────────────────────────────────────────────
// Hardcoded fallback IDs — bot keeps working even if Vercel env vars are wiped.
// cname is overridden at runtime by GCORE_CDN_CNAME env var when present.
// If env vars are missing AND these constants are stale, /stream will return a clear error.
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

// Build the streamable URL: route any source-URL path through the Gcore edge using the
// resource's cname (read from GCORE_CDN_CNAME env). HTTPS is served via Let's Encrypt.
// The Vercel function never touches the video payload — Gcore edge pulls from origin on-the-fly.
function buildStreamUrl(pathPlus) {
  const cname = getCname(); // from GCORE_CDN_CNAME env (with hardcoded fallback)
  return `https://${cname}${pathPlus}`;
}

// ─── Origin group management ────────────────────────────────────────────────

// Sanitize a host into a valid origin group name (alphanum, dash, underscore, ≤255 chars)
function groupNameFor(host) {
  const safe = host.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/-+/g, "-").slice(0, 200);
  return `auto-${safe}`;
}

// List all origin groups (paginated). Returns array of group objects.
async function listOriginGroups() {
  const out = [];
  let page = 1;
  // First call without page to discover total pages
  while (true) {
    // GCore API uses snake_case for this endpoint: /cdn/origin_groups (NOT /cdn/originGroups).
    const data = await gcoreFetch(`/cdn/origin_groups?page=${page}&per_page=100`);
    const arr = Array.isArray(data) ? data : (data && data.results) || (data && data.origin_groups) || [];
    if (Array.isArray(arr)) out.push(...arr);
    const totalPages = (data && (data.total_pages || data.pages)) || 1;
    if (page >= totalPages || arr.length === 0) break;
    page++;
    if (page > 50) break; // hard safety cap
  }
  return out;
}

// Find an existing origin group whose single source matches `host`.
function findGroupForHost(groups, host) {
  for (const g of groups) {
    const sources = g.sources || [];
    if (sources.length !== 1) continue;
    const s = sources[0];
    const src = (s.source || "").toLowerCase();
    if (src === host.toLowerCase()) return g;
    // Also match "host:port" form
    if (src.startsWith(host.toLowerCase() + ":")) return g;
  }
  return null;
}

// Create a new origin group with a single host source.
async function createOriginGroup(host) {
  const body = {
    name: groupNameFor(host),
    use_next: true,
    sources: [{ source: host, backup: false, enabled: true }],
  };
  // GCore API uses snake_case: /cdn/origin_groups (NOT /cdn/originGroups).
  return await gcoreFetch(`/cdn/origin_groups`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── CDN resource update ────────────────────────────────────────────────────

// Build the PATCH body for the CDN resource to point at `originGroupId` with video-streaming options.
function buildResourcePatch(originGroupId, originHost, protocol) {
  return {
    originGroup: originGroupId,
    originProtocol: protocol, // "HTTPS" | "HTTP" | "MATCH"
    active: true,
    options: {
      // Slice: chop large files into 10MB Range fragments so VLC can seek.
      slice: { enabled: true, value: true },
      // Host header: tell origin we're requesting from its real hostname.
      // This is critical — without it the origin would see the CDN cname as Host.
      hostHeader: { enabled: true, value: originHost },
      // Don't ignore query string — PixelDrain and others use ?download and tokens in query.
      ignoreQueryString: { enabled: true, value: false },
      // CORS: allow any origin so web players and TVs can fetch.
      cors: { enabled: true, value: ["*"], always: true },
      // Allow 206 Partial Content responses (Range requests) regardless of origin settings.
      disable_proxy_force_ranges: { enabled: true, value: false },
      // Forward the Host header from end-user request to origin — DISABLED because we set hostHeader above.
      forward_host_header: { enabled: true, value: false },
    },
  };
}

// PATCH /cdn/resources/{id} — update the resource to point at the given origin group.
async function updateResource(resourceId, originGroupId, originHost, protocol) {
  const body = buildResourcePatch(originGroupId, originHost, protocol);
  return await gcoreFetch(`/cdn/resources/${resourceId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// Purge the entire cache for the resource so stale entries from the previous origin are dropped.
async function purgeResourceCache(resourceId) {
  return await gcoreFetch(`/cdn/resources/${resourceId}/purge`, {
    method: "POST",
    body: JSON.stringify({ purge_all: true }),
  });
}

// ─── Source URL routing analyzer ─────────────────────────────────────────────
// Pre-flight check on the input URL — decides HOW to handle the /stream request.
// Returns one of:
//   { action: "self_loop", cname }                          — URL is on OUR OWN CDN cname → reject
//   { action: "already_fast_cdn", originalUrl, host }       — URL is on R2/S3/CloudFront/etc → return as-is
//   { action: "expired_presigned", originalUrl, expiredAt } — presigned URL already expired → warn
//   { action: "pixeldrain_list", listId }                   — pixeldrain /l/<id> → tell user to send single file URLs
//   { action: "stream_via_gcore", url: URL, presignedExpiresAt? } — normal case, repoint GCore origin
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

  // ── 2. Pixeldrain file LIST URL (/l/<id>) → returns HTML, not raw bytes ──
  if (host === "pixeldrain.com" || host.endsWith(".pixeldrain.com")) {
    const listMatch = u.pathname.match(/^\/l\/([A-Za-z0-9]+)/);
    if (listMatch) {
      return { action: "pixeldrain_list", listId: listMatch[1] };
    }
  }

  // ── 3. Presigned URL expiration check (R2 / S3 / Azure / GCS) ──
  //    Done BEFORE the fast-CDN check so an expired R2/S3 URL is reported as "expired"
  //    rather than "already on a fast CDN" (which would tell the user to just open it — but it's dead).
  //    AWS-style:  X-Amz-Date=YYYYMMDDTHHMMSSZ  &  X-Amz-Expires=<seconds>
  //    Azure:      se=YYYY-MM-DDThh:mm:ssZ  (URL-encoded ISO 8601)
  //    GCS:        Expires=<unix-epoch-seconds>
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
      // Not expired yet — but if host is a fast CDN, return as-is (no GCore benefit).
      // Otherwise proceed via GCore (user gets a stream that works until origin URL expires).
      const fastCdnPatterns = fastCdnPatternList();
      for (const re of fastCdnPatterns) {
        if (re.test(host)) {
          return { action: "already_fast_cdn", originalUrl: sourceUrl, host, presignedExpiresAt: expiresAt.toISOString() };
        }
      }
      return { action: "stream_via_gcore", url: u, presignedExpiresAt: expiresAt.toISOString() };
    }
  }
  const azureSe = u.searchParams.get("se");
  if (azureSe) {
    try {
      const expiresAt = new Date(decodeURIComponent(azureSe));
      if (!isNaN(expiresAt.getTime())) {
        if (Date.now() > expiresAt.getTime()) {
          return { action: "expired_presigned", originalUrl: sourceUrl, expiredAt: expiresAt.toISOString() };
        }
        const fastCdnPatterns = fastCdnPatternList();
        for (const re of fastCdnPatterns) {
          if (re.test(host)) {
            return { action: "already_fast_cdn", originalUrl: sourceUrl, host, presignedExpiresAt: expiresAt.toISOString() };
          }
        }
        return { action: "stream_via_gcore", url: u, presignedExpiresAt: expiresAt.toISOString() };
      }
    } catch {}
  }
  const gcsExpires = u.searchParams.get("Expires");
  if (gcsExpires) {
    const expiresAt = new Date(parseInt(gcsExpires, 10) * 1000);
    if (!isNaN(expiresAt.getTime())) {
      if (Date.now() > expiresAt.getTime()) {
        return { action: "expired_presigned", originalUrl: sourceUrl, expiredAt: expiresAt.toISOString() };
      }
      const fastCdnPatterns = fastCdnPatternList();
      for (const re of fastCdnPatterns) {
        if (re.test(host)) {
          return { action: "already_fast_cdn", originalUrl: sourceUrl, host, presignedExpiresAt: expiresAt.toISOString() };
        }
      }
      return { action: "stream_via_gcore", url: u, presignedExpiresAt: expiresAt.toISOString() };
    }
  }

  // ── 4. Already-fast CDN hosts (no presigned URL params) — running through GCore adds no benefit ──
  //    R2:          *.r2.cloudflarestorage.com  (Cloudflare R2 — already a CDN)
  //    S3:          *.s3*.amazonaws.com          (AWS S3 — already a CDN, esp. with CloudFront in front)
  //    CloudFront:  d[id].cloudfront.net
  //    Akamai:      *.akamaihd.net, *.akamaized.net
  //    Bunny:       *.b-cdn.net
  //    KeyCDN:      *.kxcdn.com
  //    Fastly:      *.fastly.net, *.fastlycdn.com
  for (const re of fastCdnPatternList()) {
    if (re.test(host)) {
      return { action: "already_fast_cdn", originalUrl: sourceUrl, host };
    }
  }

  // ── 5. Default: stream via GCore CDN (repoint origin, return CDN URL) ──
  return { action: "stream_via_gcore", url: u };
}

// Shared list of "already fast" CDN host patterns. Used by analyzeSourceUrl in multiple places.
function fastCdnPatternList() {
  return [
    /\.r2\.cloudflarestorage\.com$/i,
    /\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i,
    /^d[a-z0-9]+\.cloudfront\.net$/i,
    /\.akamaihd\.net$/i,
    /\.akamaized\.net$/i,
    /\.b-cdn\.net$/i,
    /\.kxcdn\.com$/i,
    /\.fastlycdn\.com$/i,
    /\.fastly\.net$/i,
  ];
}

// ─── Top-level orchestrator ─────────────────────────────────────────────────
//
// Returns one of:
//   { kind: "stream", streamUrl, originHost, groupId, groupCreated, resourceId, cname, presignedExpiresAt? }
//   { kind: "passthrough", originalUrl, host, reason }   — already on a fast CDN, return as-is
//   { kind: "self_loop", cname }                          — URL is on our own CDN, refused
//   { kind: "expired", originalUrl, expiredAt }           — presigned URL already expired
//   { kind: "pixeldrain_list", listId }                   — file list URL, not streamable directly
export async function provisionStreamableUrl(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== "string") throw new Error("sourceUrl required");

  const decision = analyzeSourceUrl(sourceUrl);

  // ── Pass-through cases (no GCore API calls needed) ──
  if (decision.action === "self_loop") {
    return { kind: "self_loop", cname: decision.cname };
  }
  if (decision.action === "already_fast_cdn") {
    return { kind: "passthrough", originalUrl: decision.originalUrl, host: decision.host, reason: "already_fast_cdn", presignedExpiresAt: decision.presignedExpiresAt || null };
  }
  if (decision.action === "expired_presigned") {
    return { kind: "expired", originalUrl: decision.originalUrl, expiredAt: decision.expiredAt };
  }
  if (decision.action === "pixeldrain_list") {
    return { kind: "pixeldrain_list", listId: decision.listId };
  }

  // ── Normal GCore CDN stream ──
  const u = decision.url;
  const originHost = u.host; // includes port if non-default
  const pathPlus = u.pathname + (u.search || ""); // path + ?query
  const protocol = u.protocol === "https:" ? "HTTPS" : "HTTP";

  // Defensive: use hardcoded fallbacks if env vars are missing (per v7.1 patch STEP 1)
  const resourceId = getResourceId();
  const cname = getCname();

  // 1. Find or create origin group for this host
  const groups = await listOriginGroups();
  let group = findGroupForHost(groups, originHost);
  let groupCreated = false;
  if (!group) {
    group = await createOriginGroup(originHost);
    groupCreated = true;
  }
  const groupId = group.id || (group.data && group.data.id);
  if (!groupId) throw new Error(`origin group has no id: ${JSON.stringify(group).slice(0, 300)}`);

  // 2. Update the CDN resource to point at this origin group
  await updateResource(resourceId, groupId, originHost, protocol);

  // 3. Purge the cache so we never serve stale content from the previous origin.
  //    Cache purge stays operational using the LIVE resource ID from env.
  try { await purgeResourceCache(resourceId); } catch (e) {
    // Non-fatal — purge failure just means some stale entries might linger for ~3 minutes
    console.warn("[gcore] purge failed (non-fatal):", e.message);
  }

  // 4. Construct the streamable URL — route through Gcore edge using the resource's cname
  //    (HTTPS via Let's Encrypt). Vercel never touches video payload.
  const streamUrl = buildStreamUrl(pathPlus);
  return {
    kind: "stream",
    streamUrl,
    originHost,
    groupId,
    groupCreated,
    resourceId,
    cname,
    presignedExpiresAt: decision.presignedExpiresAt || null,
  };
}

// Lightweight health check — verifies token + lists resources (for /api/gcore-status debug endpoint)
export async function gcoreStatus() {
  const me = await gcoreFetch(`/iam/clients/me`);
  let originGroups = [];
  let cdnServiceError = null;
  try { originGroups = await listOriginGroups(); } // reuses paginated call
  catch (e) { cdnServiceError = e.message; }
  return {
    account: { id: me.id, email: me.email, status: me.status, capabilities: me.capabilities },
    cdnServiceError,
    originGroupsCount: Array.isArray(originGroups) ? originGroups.length : 0,
    liveResourceId: getResourceId(),
    liveCname: getCname(),
  };
}
