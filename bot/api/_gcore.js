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
//
// NOTE (v7.5): Resource-level `static_response_headers` and `response_headers_hiding_policy` options
// are stored by the API but NOT applied to responses (confirmed via live testing). Header manipulation
// that actually works is done via a RULE — see `ensureStreamRules()` below. The rule matches all URLs
// (ruleType=1 regexp, rule=".*") and carries the same options at the rule level, where they ARE honored.
//
// The resource-level options below (slice, hostHeader, cors, etc.) DO work — only the header-manipulation
// ones needed to be moved to a rule.
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
      // ── v7.6 — force edge caching to defeat origin's `cache-control: private, no-store` ──
      // Use `value` (not `default`) so the TTL applies to 200/206 responses REGARDLESS of
      // what the origin sends in Cache-Control. storage.to sends `private, no-store` which
      // would normally defeat CDN caching — `value` overrides that.
      // "4d" = 4 days. The maximum is 1y. We use 4d to balance freshness vs cache hit rate.
      edge_cache_settings: { enabled: true, value: "4d" },
      // ── v7.6 — cache responses with Set-Cookie header ──
      // storage.to sets a `visitor_token` cookie on every response. By default GCore treats
      // responses with Set-Cookie as non-cacheable. Enabling ignore_cookie caches them as
      // a single file regardless of cookie value.
      ignore_cookie: { enabled: true, value: true },
      // ── v7.6 — serve stale content while updating (smooths over origin hiccups) ──
      // If origin returns an error or is updating, serve the last good cached response.
      stale: { enabled: true, value: ["error", "updating"] },
    },
  };
}

// ─── v7.5: Stream rules (header manipulation that makes download-only links streamable) ──────────
//
// GCore's resource-level `static_response_headers` and `response_headers_hiding_policy` options are
// stored by the API but NOT applied to responses (confirmed via live testing July 2026). However, the
// SAME options placed on a RULE ARE applied. So we create a single global rule (matches all URLs) that:
//
//   1. response_headers_hiding_policy (mode='show', excepted=[streaming-relevant headers])
//      → In GCore's semantics, mode='show' = "show ONLY the excepted list (+ 5 mandatory headers:
//        connection, content-length, content-type, server, date). Hide everything else."
//      → This strips the origin's `Content-Disposition: attachment` (which forces download behavior
//        in VLC / Stremio / TV players) because `content-disposition` is in our excepted list BUT
//        we override it with `inline` via static_response_headers (next).
//      → We also keep: accept-ranges (seek support), cache-control, etag, expires, keep-alive,
//        last-modified, vary, content-encoding — all the headers needed for proper streaming.
//      → The CDN auto-adds `content-range` for 206 Partial Content responses (seek works).
//
//   2. static_response_headers with THREE overrides (v7.6):
//        a. Content-Disposition: inline → players STREAM instead of DOWNLOADING.
//        b. Accept-Ranges: bytes → explicitly advertise Range support (some origins omit this;
//           players may then refuse to seek). GCore supports Range natively, so declaring it is safe.
//        c. Cache-Control: public, max-age=86400 → DEFEATS origin's `private, no-store` so downstream
//           players AND intermediate caches are allowed to cache. (Note: GCore edge cache is governed
//           by `edge_cache_settings.value` on the resource, not by this header — this header is for
//           the player side.)
//      → Per GCore docs: "If the same header is already configured on your server, the CDN servers
//        will override its value."
//      → `always: true` ensures the override is added to ALL response codes (including 206 Partial
//        Content).
//
// The result: players see `Content-Disposition: inline`, `Accept-Ranges: bytes`,
// `Cache-Control: public, max-age=86400` → they STREAM with pause/resume/seek.
//
// v7.6 also includes a RULE UPgrade check: if a rule with our name exists but its options don't
// match the current spec (e.g. an older v7.5 rule with shorter excepted list), we PATCH it to
// the latest spec. This handles the case where the rule was created before v7.6 and needs
// to be brought up to date.
const STREAM_RULE_NAME = "strip-content-disposition-global-v76";

// The v7.6 spec for the stream rule's options. Used to detect outdated rules and PATCH them.
const STREAM_RULE_OPTIONS_SPEC = {
  response_headers_hiding_policy_excepted: [
    "content-disposition",
    "accept-ranges",
    "cache-control",
    "content-encoding",
    "content-range",
    "etag",
    "expires",
    "keep-alive",
    "last-modified",
    "vary",
  ],
  static_response_headers_value: [
    { name: "Content-Disposition", value: ["inline"], always: true },
    { name: "Accept-Ranges", value: ["bytes"], always: true },
    { name: "Cache-Control", value: ["public, max-age=86400"], always: true },
  ],
};

async function listResourceRules(resourceId) {
  const r = await gcoreFetch(`/cdn/resources/${resourceId}/rules`);
  return Array.isArray(r) ? r : (Array.isArray(r?.body) ? r.body : []);
}

// Returns the rule object if it exists, null otherwise.
async function findStreamRule(resourceId) {
  const rules = await listResourceRules(resourceId);
  return rules.find(r => r.name === STREAM_RULE_NAME) || null;
}

// Create the stream rule if it doesn't exist. Idempotent — safe to call on every /stream request.
// v7.6: ALSO upgrades outdated rules to the latest spec (PATCHes them in place).
// Returns { ruleId, created, upgraded } where:
//   created=true   — we created a new rule
//   upgraded=true  — we PATCHed an existing rule to bring it up to v7.6 spec
//   both false     — rule was already up-to-date
async function ensureStreamRules(resourceId) {
  // Check if a stream rule already exists. We look for:
  //   1. A rule with our exact name (STREAM_RULE_NAME, including previous versions like -v75), OR
  //   2. A rule with rule=".*" and ruleType=1 (regexp matching all URLs) — this is the functional
  //      equivalent, even if named differently (e.g. from a previous version or manual creation).
  const rules = await listResourceRules(resourceId);
  const existing = rules.find(r =>
    r.name === STREAM_RULE_NAME ||
    r.name === "strip-content-disposition-global-v75" ||
    r.name === "strip-content-disposition-global" ||
    (r.ruleType === 1 && r.rule === ".*")
  );
  if (existing) {
    // ── v7.6: check if existing rule's options match the current spec; PATCH if not ──
    const needsUpgrade = !ruleMatchesSpec(existing);
    if (needsUpgrade) {
      console.log(`[gcore] upgrading stream rule ${existing.id} (name="${existing.name}") to v7.6 spec`);
      const upgraded = await patchStreamRule(existing.id, resourceId);
      return { ruleId: existing.id, created: false, upgraded: true };
    }
    return { ruleId: existing.id, created: false, upgraded: false };
  }

  // Create it. ruleType=1 (regexp), rule=".*" (match all URLs).
  const body = buildStreamRuleBody();

  try {
    const r = await gcoreFetch(`/cdn/resources/${resourceId}/rules`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const ruleId = r?.id;
    if (!ruleId) {
      throw new Error(`failed to create stream rule: ${JSON.stringify(r).slice(0, 400)}`);
    }
    return { ruleId, created: true, upgraded: false };
  } catch (e) {
    // If the error is "rule_string must be unique", another rule with rule=".*" already exists
    // (possibly with a different name from a previous version). Re-list, upgrade it, and reuse.
    if (e.message && e.message.includes("rule_string must be unique")) {
      const rules2 = await listResourceRules(resourceId);
      const existing2 = rules2.find(r => r.ruleType === 1 && r.rule === ".*");
      if (existing2?.id) {
        await patchStreamRule(existing2.id, resourceId);
        return { ruleId: existing2.id, created: false, upgraded: true };
      }
    }
    throw e;
  }
}

// Build the rule body for CREATE. Also used as the reference spec for upgrade checks.
function buildStreamRuleBody() {
  return {
    name: STREAM_RULE_NAME,
    ruleType: 1,           // 1 = regexp
    rule: ".*",            // match all URLs
    enabled: true,
    options: {
      // "Show ONLY these headers (+ 5 mandatory: connection, content-length, content-type, server, date).
      // Hide everything else (cleans up CSP, x-robots-tag, etc. that might confuse players)."
      response_headers_hiding_policy: {
        enabled: true,
        mode: "show",
        excepted: STREAM_RULE_OPTIONS_SPEC.response_headers_hiding_policy_excepted,
      },
      // Override key headers to force streaming-friendly behavior.
      // Per GCore docs: "If the same header is already configured on your server, the CDN servers
      // will override its value."
      static_response_headers: {
        enabled: true,
        value: STREAM_RULE_OPTIONS_SPEC.static_response_headers_value,
      },
    },
  };
}

// Check if an existing rule's options match the current v7.6 spec.
// Returns true if rule is up-to-date, false if it needs to be PATCHed.
function ruleMatchesSpec(rule) {
  if (!rule.options) return false;
  const hp = rule.options.response_headers_hiding_policy;
  if (!hp || !hp.enabled || hp.mode !== "show") return false;
  // Compare excepted arrays (order-insensitive)
  const expectedExcepted = STREAM_RULE_OPTIONS_SPEC.response_headers_hiding_policy_excepted;
  const actualExcepted = hp.excepted || [];
  if (actualExcepted.length !== expectedExcepted.length) return false;
  const expectedSet = new Set(expectedExcepted);
  if (!actualExcepted.every(h => expectedSet.has(h))) return false;
  // Compare static_response_headers
  const srh = rule.options.static_response_headers;
  if (!srh || !srh.enabled) return false;
  const expectedSrh = STREAM_RULE_OPTIONS_SPEC.static_response_headers_value;
  const actualSrh = srh.value || [];
  if (actualSrh.length !== expectedSrh.length) return false;
  // Each expected entry must be present (by name + value + always)
  for (const exp of expectedSrh) {
    const match = actualSrh.find(a =>
      a.name === exp.name &&
      Array.isArray(a.value) &&
      a.value.length === exp.value.length &&
      a.value.every((v, i) => v === exp.value[i]) &&
      a.always === exp.always
    );
    if (!match) return false;
  }
  return true;
}

// PATCH an existing rule to bring it up to v7.6 spec.
async function patchStreamRule(ruleId, resourceId) {
  const body = buildStreamRuleBody();
  return await gcoreFetch(`/cdn/resources/${resourceId}/rules/${ruleId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// PATCH /cdn/resources/{id} — update the resource to point at the given origin group.
async function updateResource(resourceId, originGroupId, originHost, protocol) {
  const body = buildResourcePatch(originGroupId, originHost, protocol);
  return await gcoreFetch(`/cdn/resources/${resourceId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// Purge cache for the resource. The GCore API requires `paths` (array of URL paths starting with /)
// or `urls` — `purge_all: true` is NOT supported (returns 400). Rate limit: 1 purge per minute.
// We purge the specific path being streamed (most relevant) + a wildcard attempt (best-effort).
async function purgeResourceCache(resourceId, pathPlus) {
  // pathPlus is the path+query from the source URL, e.g. "/api/file/abc?download"
  // Extract just the path (without query) for purging — GCore purges by path pattern.
  let pathOnly = pathPlus;
  try {
    const u = new URL(`https://example.com${pathPlus}`);
    pathOnly = u.pathname;
  } catch {}

  // Try purging the specific path. If rate-limited (429), the non-fatal warning is logged.
  try {
    return await gcoreFetch(`/cdn/resources/${resourceId}/purge`, {
      method: "POST",
      body: JSON.stringify({ paths: [pathOnly] }),
    });
  } catch (e) {
    // Non-fatal — purge failure just means some stale entries might linger for ~3 minutes
    console.warn(`[gcore] purge for ${pathOnly} failed (non-fatal):`, e.message);
  }
}

// ─── Source URL routing analyzer ─────────────────────────────────────────────
// Pre-flight check on the input URL — decides HOW to handle the /stream request.
// Returns one of:
//   { action: "self_loop", cname }                          — URL is on OUR OWN CDN cname → reject
//   { action: "expired_presigned", originalUrl, expiredAt } — presigned URL already expired → warn
//   { action: "pixeldrain_list", listId }                   — pixeldrain /l/<id> → tell user to send single file URLs
//   { action: "stream_via_gcore", url: URL, presignedExpiresAt? } — normal case, repoint GCore origin
//
// NOTE (v7.5): We NO LONGER pass through R2/S3/CloudFront/Akamai/Bunny/Fastly URLs as-is.
// Previously we returned them unchanged ("already on a fast CDN, GCore adds no benefit"). But now
// that GCore strips `Content-Disposition: attachment` via a rule, routing these URLs through GCore
// turns "download-only" links (which force download in VLC/players) into streamable links. So we
// route EVERYTHING through GCore (except self-loops, expired presigned URLs, and pixeldrain lists).
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
  //    If expired → refuse. If still valid → route through GCore (with expiration warning).
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
      return { action: "stream_via_gcore", url: u, presignedExpiresAt: expiresAt.toISOString() };
    }
  }

  // ── 4. Default: stream via GCore CDN (repoint origin, return CDN URL) ──
  //    This now includes R2/S3/CloudFront/etc. URLs — GCore strips Content-Disposition: attachment
  //    via the stream rule, making "download-only" links streamable.
  return { action: "stream_via_gcore", url: u };
}

// ─── Top-level orchestrator ─────────────────────────────────────────────────
//
// Returns one of:
//   { kind: "stream", streamUrl, originHost, groupId, groupCreated, resourceId, cname, presignedExpiresAt?, ruleApplied?, ruleCreated? }
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

  // 3. Ensure the stream rules exist (creates the Content-Disposition stripping rule if missing).
  //    This is what makes "download-only" links streamable in VLC / Stremio / TV.
  //    Idempotent — only creates the rule if it doesn't already exist.
  let ruleInfo = null;
  try {
    ruleInfo = await ensureStreamRules(resourceId);
  } catch (e) {
    // Non-fatal — if rule creation fails, streaming still works but Content-Disposition won't be stripped
    console.warn("[gcore] ensureStreamRules failed (non-fatal):", e.message);
  }

  // 4. Purge the cache for this specific path so we never serve stale content from the previous origin.
  //    Note: GCore purge API requires `paths` (not `purge_all`), rate limit 1/minute.
  try { await purgeResourceCache(resourceId, pathPlus); } catch (e) {
    // Non-fatal — purge failure just means some stale entries might linger for ~3 minutes
    console.warn("[gcore] purge failed (non-fatal):", e.message);
  }

  // 5. Construct the streamable URL — route through Gcore edge using the resource's cname
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
    ruleApplied: ruleInfo ? !!ruleInfo.ruleId : false,
    ruleCreated: ruleInfo ? ruleInfo.created : false,
    ruleUpgraded: ruleInfo ? !!ruleInfo.upgraded : false,
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
