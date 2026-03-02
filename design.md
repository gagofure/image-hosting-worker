# ImageWorker — Design Document

---

## Overview

ImageWorker is an AI-powered image hosting service built entirely on Cloudflare's developer platform. It accepts image URLs via a REST API, stores the image bytes privately in R2, and automatically generates accessibility descriptions (alt-text) using a vision LLM — lazily, on first access, never at upload time.

The service is deployed as a single Cloudflare Worker with no external dependencies at runtime. All storage, inference, caching, and rate limiting are handled by Cloudflare-native primitives, making the system globally distributed by default with no infrastructure to manage. A custom domain is served behind Cloudflare DNS, ensuring production-grade routing, full Cache API behavior at the edge, and an additional layer of network protection.

---

## Core Design Principle: Lazy AI Generation

The most deliberate architectural decision in this system is **deferring AI inference to the first GET request rather than running it at upload time.**

### The Problem With Eager Inference

Running the vision model at upload time seems intuitive — the image is available, so describe it immediately. In practice this creates two problems:

**Cost.** The Workers AI free tier has a fixed daily Neuron budget, and vision models consume significantly more Neurons per call than text models. Running inference at upload time burns quota against every image regardless of whether it is ever viewed. In a realistic workload, a meaningful proportion of uploaded images may never be accessed on a given day. Eager inference wastes budget on images nobody cared about.

**Latency.** A vision model call typically takes several seconds. If inference ran synchronously in the upload handler, every `POST /upload` would stall for that duration before returning a `201`. That is not acceptable for an ingest endpoint — the caller should not be made to wait for something that does not block storage.

### The Lazy Solution

At upload time, the Worker does the minimum necessary work: validate the URL, fetch the image, write to R2, insert a metadata record into D1 with `alt_text = NULL`. The `201` response returns immediately.

On the first `GET /images/:uuid`, the Worker reads D1 and finds `alt_text` is null. It returns the image immediately (the user is never blocked), then fires AI generation in the background via `ctx.waitUntil()`. When inference completes, the result is persisted to D1 and the Cache API entry is rebuilt with the enriched `X-Alt-Text` header.

Every subsequent request hits the Cache API and never reaches the Worker at all.

### Three Layers of Budget Protection

The lazy principle alone is not sufficient — a burst of concurrent requests for the same cold image could still fan out into multiple parallel AI calls. Three layers prevent this:

**D1 as the gate.** Before any AI call is attempted, the Worker queries D1 for an existing `alt_text` value. If one is present, the model is never invoked. This makes inference idempotent — redeploys, cache busts, and retries never trigger redundant AI jobs.

**KV as the deduplication lock.** A short-lived key (`ai:<imageId>`, TTL 300 s) is written to the `AI_QUOTA` KV namespace before the model call. If a second concurrent request arrives for the same image while inference is in flight, it reads the lock and exits early. Without this guard, a thundering herd of requests for a cold image would multiply Neuron spend for a single asset.

**Cache API as the long-term shield.** Once alt-text is ready, the full image response — including the `X-Alt-Text` header — is stored at the global edge with a one-hour TTL. Every subsequent request for that image is served entirely from cache: no Worker CPU, no R2 read, no D1 query, no AI call. A popular image could receive thousands of requests per day and consume exactly **one** inference job for its entire lifetime.

Together these three layers form a cost funnel:

```
Incoming requests
       │
       ▼
  Cache API ──── HIT (majority) ────▶ Serve from edge, zero compute
       │
     MISS
       │
       ▼
    D1 check ── alt_text exists ────▶ Cache + serve, no AI
       │
   alt_text null
       │
       ▼
  KV lock check ── locked ──────────▶ Exit, AI already in flight
       │
    unlocked
       │
       ▼
   Workers AI ── one inference job per image, ever
```

---

## Architecture

```
Client
  │
  ▼
Cloudflare Worker (edge)
  ├── Cache API          ← serves repeat requests instantly (zero compute)
  ├── R2 Bucket          ← private image storage
  ├── D1 Database        ← alt-text persistence and audit log
  ├── Workers AI         ← llama-3.2-11b-vision-instruct (lazy, deduplicated)
  └── Workers KV (×2)   ← rate limiting · AI deduplication lock
```

### Service Responsibilities

| Service | Role | Why This Service |
|---|---|---|
| **Workers** | Request routing, auth, orchestration | Edge compute, runs globally, zero cold start |
| **R2** | Private image blob storage | No egress fees, native Worker binding, private by default |
| **D1** | Metadata and alt-text persistence | SQL semantics at the edge, UNIQUE constraint enforces dedup |
| **Workers AI** | Vision model inference | No external API key, same network as Worker, Neuron-based billing |
| **Cache API** | Global HTTP response caching | Zero compute on cache hit, automatic PoP distribution |
| **KV (RATE_LIMIT)** | Per-IP sliding-window rate limiting | Low-latency reads, TTL-based expiry handles window cleanup |
| **KV (AI_QUOTA)** | AI job deduplication lock | Same TTL mechanism, isolates AI concerns from rate limiting |

### Why Two KV Namespaces?

Rate limiting and AI deduplication are separated into two KV namespaces intentionally. They have different TTLs, different key patterns, different failure modes, and different operational concerns. Mixing them into one namespace would make it harder to inspect, debug, or independently scale either concern. The cost of an extra namespace binding is zero.

---

## Request Lifecycle

### Upload — `POST /upload`

```
1. Auth          requireBearer() — 401 if ADMIN_TOKEN mismatch
2. SSRF check    isSafeUrl() — block loopback, link-local, RFC1918
3. Dedup         D1 SELECT on source_url — return existing ID if found
4. Fetch         AbortController-bounded (10 s), User-Agent header set
5. Validate      MIME type allowlist, 10 MB size cap
6. Store         R2.put() — bytes with content-type metadata
7. Record        D1 INSERT — id, source_url, alt_text=NULL
8. Respond       201 with imageId and relative URL
```

If D1 insert fails after a successful R2 write, a compensating `R2.delete()` is attempted to prevent orphaned objects. This is best-effort — the delete is fire-and-forget and logged on failure.

### Image Serve — `GET /images/:uuid`

```
1. Cache check   caches.default.match() — return immediately on HIT
2. Parallel fetch Promise.allSettled([D1.select alt_text, R2.get bytes])
                 D1 failure is non-fatal — image still served without alt-text
3. Respond       200 with image bytes, X-Alt-Text, Cache-Control headers
4. Background    ctx.waitUntil(generateAndCache()) if alt_text is null
                 ├── Acquire KV lock
                 ├── Call Workers AI vision model
                 ├── sanitiseAltText() — strip HTML, encode chars, truncate 500
                 ├── D1 upsert alt_text
                 └── Rebuild Cache API entry with enriched headers
```

The use of `Promise.allSettled` rather than `Promise.all` is deliberate. A D1 read failure should not prevent image delivery — R2 is the source of truth for the bytes. The system degrades gracefully: the image is served, alt-text is omitted from the header, and the failure is logged.

---

## Data Model

```sql
CREATE TABLE images (
  id         TEXT PRIMARY KEY,                    -- UUID v4
  source_url TEXT UNIQUE,                         -- Dedup key
  alt_text   TEXT,                                -- NULL until AI completes
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX idx_images_created_at
  ON images (created_at DESC);                    -- Audit pagination

CREATE UNIQUE INDEX idx_images_source_url
  ON images (source_url);                         -- Dedup enforcement at DB level
```

The `UNIQUE` constraint on `source_url` enforces deduplication at the database level, independently of the application-layer check. The application check is a fast-path optimisation; the index is the invariant guarantee.

The `alt_text` column being nullable is load-bearing — a `NULL` value is the signal that triggers AI generation. It is not an oversight; it is the state machine (a system that behaves differently depending on what state it's in. Your Worker reads that column and makes a decision).

---

## Security Design

### Authentication
Write and audit endpoints require a `Bearer` token compared against `ADMIN_TOKEN`, injected as a Wrangler secret. The token is never embedded in code or committed to source control. The dashboard stores it in `sessionStorage` — ephemeral to the tab session, not persisted across browser restarts.

### SSRF Protection
The upload endpoint validates the hostname of every provided URL before making an outbound fetch. Blocked ranges:

| Range | Reason |
|---|---|
| `127.x`, `::1` | Loopback |
| `169.254.x` | Link-local / cloud metadata endpoints (AWS IMDSv1, GCP) |
| `10.x` | RFC1918 Class A |
| `172.16–31.x` | RFC1918 Class B |
| `192.168.x` | RFC1918 Class C |

This is an application-layer defence. Cloudflare's infrastructure enforces similar restrictions at the network level; the application check makes the policy explicit and auditable in code.

### Input Sanitisation
AI model output is sanitised before storage and before being returned in HTTP response headers. The `sanitiseAltText()` function strips HTML tags, encodes five special characters, and truncates to 500 characters. This prevents a malicious or hallucinating model response from injecting markup into D1 or the dashboard UI. Manual descriptions provided at upload time pass through the same function — consistent behaviour regardless of the source.

### Rate Limiting
A sliding window of 100 requests per minute per IP is enforced via KV. The limiter is deliberately fail-open: if KV is unavailable, requests proceed. This prioritises availability over strict enforcement — a KV outage should not take down the service. The window key includes the minute epoch, and the TTL is set to 75 seconds (slightly above 60) to account for clock skew between edge nodes.

---

## Caching Strategy

| State | Cache-Control | Behaviour |
|---|---|---|
| Alt-text ready | `public, max-age=3600` | Cached for 1 hour at nearest PoP |
| Alt-text pending | `public, max-age=60, stale-while-revalidate=300` | Short-lived entry; rebuilt after AI completes |
| Cache hit | — | Served from edge, zero Worker invocation |

The `stale-while-revalidate=300` directive on pending responses allows the edge to serve the stale (pending) response for up to 5 minutes while revalidation happens in the background. This prevents a thundering herd from hitting the Worker simultaneously when the 60-second TTL expires on a cold image.

Cache writes always use `ctx.waitUntil()` — they happen after the response is returned to the client, adding zero latency to the request.

---

## Frontend Design

The admin dashboard is a single-page application embedded as a string in `handleRoot()`. It has no framework, no bundler, and no external JavaScript dependencies. Three deliberate security decisions:

**No `innerHTML` with database data.** All DOM mutations that render database content use `textContent` or explicit DOM API calls (`createElement`, `appendChild`). This prevents stored XSS — a malicious alt-text value in D1 can never be interpreted as markup by the browser.

**SessionStorage for the token.** The admin token is stored in `sessionStorage` rather than `localStorage`. It survives page refreshes but is cleared when the tab closes, reducing the window of exposure compared to a persistent store.

**Polling with guards.** The gallery polls `/audit?id=` every 3 seconds for images with pending alt-text. The poll stops immediately when the modal is closed and when alt-text is received — it never runs unnecessarily and never leaks beyond its intended scope.

---

## Deployment Configuration

### `wrangler.jsonc`

```jsonc
{
  "name": "imageworker",
  "main": "src/worker.js",
  "compatibility_date": "2024-09-23",

  // R2 bucket — stores private image bytes
  "r2_buckets": [
    {
      "binding": "IMAGES",
      "bucket_name": "imageworker-images",
      "preview_bucket_name": "imageworker-images-dev" // used by wrangler dev
    }
  ],

  // D1 database — metadata and alt-text persistence
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "imageworker-db",
      "database_id": "<your-d1-database-id>" // fill in after: wrangler d1 create imageworker-db
    }
  ],

  // KV namespaces — rate limiting and AI deduplication lock
  "kv_namespaces": [
    {
      "binding": "RATE_LIMIT",
      "id": "<your-rate-limit-kv-id>",         // fill in after: wrangler kv namespace create RATE_LIMIT
      "preview_id": "<your-rate-limit-kv-preview-id>"
    },
    {
      "binding": "AI_QUOTA",
      "id": "<your-ai-quota-kv-id>",           // fill in after: wrangler kv namespace create AI_QUOTA
      "preview_id": "<your-ai-quota-kv-preview-id>"
    }
  ],

  // Workers AI binding — vision model inference
  "ai": {
    "binding": "AI"
  }

  // ADMIN_TOKEN is not listed here — it is a secret, set via:
  //   wrangler secret put ADMIN_TOKEN
  // Secrets are never stored in wrangler.jsonc or committed to source control.
}
```

### Bootstrap Steps

Run these commands once before the first `wrangler deploy`. Each command outputs an ID — copy it into `wrangler.jsonc` where indicated.

```bash
# 1. Create the R2 bucket
wrangler r2 bucket create imageworker-images

# 2. Create the D1 database — copy the returned database_id into wrangler.jsonc
wrangler d1 create imageworker-db

# 3. Apply the schema and indexes (run against both local dev and production)
wrangler d1 execute imageworker-db --file=./schema.sql
wrangler d1 execute imageworker-db --remote --file=./schema.sql

# 4. Create the KV namespaces — copy the returned IDs into wrangler.jsonc
wrangler kv namespace create RATE_LIMIT
wrangler kv namespace create AI_QUOTA

# 5. Accept the Meta Llama license (required once per account before the model can be used)
# Send a single request to Workers AI with { prompt: "agree" } via the dashboard or API.
# See: https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/

# 6. Deploy first — the Worker must exist before a secret can be attached to it
wrangler deploy

# 7. Set the admin token secret — you will be prompted to enter the value
wrangler secret put ADMIN_TOKEN
```

### `schema.sql`

Save this file alongside `wrangler.jsonc` and reference it in step 3 above.

```sql
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  source_url TEXT UNIQUE,
  alt_text   TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_images_created_at
  ON images (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_images_source_url
  ON images (source_url);
```

`IF NOT EXISTS` guards on all statements make this migration safe to re-run — useful during local development or if bootstrap is accidentally repeated.

---

## Trade-offs and Limitations

### Acknowledged Trade-offs

**Single file.** The entire application is one JavaScript file. This is pragmatic for a Worker deployment — no bundler required, straightforward to deploy — but increases cognitive load as the codebase grows. A build step with module splitting would be the first structural improvement in a production system.

**Best-effort rollback.** The compensating R2 delete on D1 failure is fire-and-forget. A failed delete leaves an orphaned object in R2 with no metadata record. In a production system, a dead-letter KV entry and a reconciliation Cron Worker would close this gap.

**Polling for alt-text updates.** The dashboard polls D1 every 3 seconds per open modal. This is appropriate for a low-traffic admin tool but does not scale to many concurrent users. Durable Objects with WebSocket broadcast would be the production solution — deliberately out of scope for this assignment.

**Hostname-only SSRF blocking.** The SSRF check inspects the parsed hostname string, not the resolved IP. A DNS rebinding attack could theoretically bypass it. Cloudflare's network layer mitigates this in practice; it is noted as a known limitation.

### What I Would Do With More Time

- **Module decomposition** — split into `router.js`, `handlers/`, `middleware/`, `lib/` with a build step
- **Test suite** — Vitest with `@cloudflare/vitest-pool-workers` targeting `sanitiseAltText()`, `isSafeUrl()`, `rateLimit()`, and `handleUpload()`
- **Dead-letter reconciliation** — KV namespace for orphaned R2 objects, Cron Worker to clean up
- **Real-time alt-text updates** — replace polling with a Durable Object WebSocket broadcast
- **Structured logging** — replace `console.error` with a structured logger that emits to Workers Logpush for observability in production

---

## Why Cloudflare's Stack?

Every service used in this project is a Cloudflare-native primitive accessed via a Worker binding — no API keys, no network hops to external services, no latency added by leaving the Cloudflare network. R2, D1, KV, Workers AI, and the Cache API all run in the same execution environment as the Worker itself.

This is not just convenient, it is architecturally significant. The alternative (S3 for storage, RDS for the database, an external AI API) would add network latency on every request, introduce external failure domains, and require credential management for each service. The Cloudflare-native approach collapses all of that into a single deployment unit with a single `wrangler deploy`.