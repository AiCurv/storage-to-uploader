// Gcore CDN helper — used by webhook.js to power the "Instant CDN Stream" feature.
//
// Architecture (zero-cost / no-CNAME-delegation variant):
//   1. ONE CDN resource exists in Gcore (provisioned via API by the bot admin).
//      Its cname in Gcore is `stream.theaicurv.com` (placeholder).
//      Gcore's per-account CNAME target is `cl-glff28ad70.gcdn.co`.
//      To enable HTTPS streaming, the user must add a DNS CNAME record:
//          stream.theaicurv.com  →  cl-glff28ad70.gcdn.co
//      and then Gcore auto-issues a Let's Encrypt cert for stream.theaicurv.com.
//      Until DNS is set up, the streaming URL will not resolve.
//   2. For each /stream request we:
//        a) parse the source URL -> originHost + path + query
//        b) find or create an origin group whose source == originHost
//        c) PATCH the CDN resource to point at that origin group with video-friendly options
//           (slice enabled, hostHeader set, ignoreQueryString disabled, CORS *)
//        d) purge the resource's cache so stale entries from the previous origin are dropped
//           (cache purge stays operational using the live Resource ID below)
//        e) return https://<GCORE_CDN_CNAME><path>?<query> — the user streams via Gcore edge
//
// The Vercel function never touches the video payload. Gcore edge pulls from origin on-the-fly.
//
// Env vars (set in Vercel project):
//   GCORE_API_TOKEN          — permanent API token (Authorization: APIKey <token>)
//   GCORE_CDN_RESOURCE_ID    — numeric ID of the CDN resource (live: 1003848)
//   GCORE_CDN_CNAME          — serving hostname for stream URLs (cl-glff28ad70.gcdn.co is Gcore's
//                              per-account CNAME target; stream.theaicurv.com is the resource's
//                              configured cname — the admin picks which one to expose)

const GCORE_API = "https://api.gcore.com";

// ─── Defensive fallback values ───────────────────────────────────────────────
// Per STEP 1 of the v7.1 patch instructions, the live production values are bound here as
// hardcoded fallbacks so the bot keeps working even if Vercel env vars are missing.
// GCore's per-account CNAME target (cl-glff28ad70.gcdn.co) is used as the default serving
// hostname because the user explicitly skipped custom-domain CNAME delegation.
// NOTE: cache purge always uses the LIVE resource ID (1003848 — replaced the deleted 1003843).
const FALLBACK_RESOURCE_ID = "1003848";
const FALLBACK_CNAME = "cl-glff28ad70.gcdn.co";

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

// Defensive helper: rewrite any incoming source-URL path onto the secure Gcore gcdn.co host pattern.
// Per the v7.1 patch instructions: "all incoming URLs processed via the /stream command are
// explicitly reconstructed using the secure https://gcdn.co host pattern" — meaning the Gcore
// edge CNAME (cl-glff28ad70.gcdn.co) is the native target, bypassing any custom-domain validation.
function buildStreamUrl(pathPlus) {
  const cname = getCname(); // = cl-glff28ad70.gcdn.co (per-account CNAME target)
  // Explicitly reconstruct using the gcdn.co host pattern (cname is on the gcdn.co apex domain).
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

// ─── Top-level orchestrator ─────────────────────────────────────────────────

// Returns { stream_url, origin_host, group_id, group_created, resource_id, cname }
export async function provisionStreamableUrl(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== "string") throw new Error("sourceUrl required");
  let u;
  try { u = new URL(sourceUrl); } catch { throw new Error(`invalid URL: ${sourceUrl.slice(0, 100)}`); }
  if (!u.protocol.startsWith("http")) throw new Error("URL must be http(s)");

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
  //    Cache purge stays operational using the LIVE Resource ID (1003848).
  try { await purgeResourceCache(resourceId); } catch (e) {
    // Non-fatal — purge failure just means some stale entries might linger for ~3 minutes
    console.warn("[gcore] purge failed (non-fatal):", e.message);
  }

  // 4. Construct the streamable URL — explicitly route through Gcore's native gcdn.co host
  //    pattern (per v7.1 patch STEP 2: bypass custom-host validation, zero-cost config).
  //    Gcore edge pulls from origin on-the-fly; Vercel never touches the video payload.
  const streamUrl = buildStreamUrl(pathPlus);
  return {
    streamUrl,
    originHost,
    groupId,
    groupCreated,
    resourceId,
    cname,
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
