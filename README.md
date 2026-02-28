# ImageWorker

An AI-powered image hosting service built on Cloudflare's developer platform. Images are stored in R2, served via a Worker, and automatically described using Workers AI — with results persisted in D1 and cached globally at the edge.

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

### Design Principle: Lazy AI Generation

AI inference only runs when an image is first requested and alt-text has not yet been generated. D1 is the gate (skip AI if alt-text exists), KV holds a short-lived deduplication lock to prevent concurrent re-runs, and the Cache API serves all subsequent requests from the global edge with zero compute.

### Cloudflare Services Used

| Service | Purpose |
|---|---|
| **Workers** | Edge request routing, auth, business logic |
| **R2** | Private image blob storage |
| **D1** | Alt-text and metadata persistence (SQLite at the edge) |
| **Workers AI** | Vision model inference (`llama-3.2-11b-vision-instruct`) |
| **Cache API** | Global edge caching of image responses |
| **KV (RATE_LIMIT)** | Per-IP sliding-window rate limiting |
| **KV (AI_QUOTA)** | AI job deduplication lock (prevents repeat inference) |

---

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | — | Admin dashboard (embedded HTML) |
| `GET` | `/images/:uuid` | — | Serve image + `X-Alt-Text` header |
| `POST` | `/upload` | Bearer | Ingest image from external URL |
| `GET` | `/audit` | Bearer | Paginated JSON inventory from D1 |
| `GET` | `/health` | — | Uptime / deployment check |

---

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Node.js](https://nodejs.org/) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

```bash
npm install -g wrangler
wrangler login
```

---

## Setup

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd image-worker
```

### 2. Create Cloudflare Resources

**R2 Bucket**
```bash
wrangler r2 bucket create image-worker-images
```

**D1 Database**
```bash
wrangler d1 create image-worker-db
```
Copy the `database_id` from the output — you'll need it for `wrangler.toml`.

**KV Namespaces**
```bash
wrangler kv:namespace create RATE_LIMIT
wrangler kv:namespace create AI_QUOTA
```
Copy both namespace IDs.

### 3. Configure `wrangler.jsonc`

```jsonc
{
  "name": "image-worker",
  "main": "src/index.js",
  "compatibility_date": "2024-01-01",

  "r2_buckets": [
    {
      "binding": "IMAGES",
      "bucket_name": "image-worker-images"
    }
  ],

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "image-worker-db",
      "database_id": "<your-database-id>"
    }
  ],

  "kv_namespaces": [
    {
      "binding": "RATE_LIMIT",
      "id": "<your-rate-limit-namespace-id>"
    },
    {
      "binding": "AI_QUOTA",
      "id": "<your-ai-quota-namespace-id>"
    }
  ],

  "ai": {
    "binding": "AI"
  }
}
```

### 4. Initialise the D1 Schema

```bash
wrangler d1 execute image-worker-db --command "
  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    source_url TEXT UNIQUE,
    alt_text   TEXT,
    created_at TEXT,
    updated_at TEXT
  );
"
```

### 5. Set the Admin Token

```bash
wrangler secret put ADMIN_TOKEN
# Enter a strong, randomly generated token when prompted
```

### 6. Accept the Vision Model License

Workers AI requires a one-time licence acceptance for the Llama vision model before it can be used. Send one request with `{ "prompt": "agree" }` to the model via the Cloudflare Dashboard AI playground, or follow the prompt in the [official docs](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/).

### 7. Deploy

```bash
wrangler deploy
```

---

## Usage

### Dashboard

Navigate to your Worker URL in a browser (e.g. `https://image-worker.<your-subdomain>.workers.dev`). Enter your admin token when prompted. The token is stored in `sessionStorage` for the duration of the tab session.

The dashboard has three tabs:

- **Upload** — paste a public image URL and submit. The image is fetched, validated, stored in R2, and a record is created in D1. Alt-text is generated on first access.
- **Gallery** — browse all uploaded images. Cards show alt-text on hover. Pending alt-text polls automatically every few seconds.
- **Audit** — paginated table of all records with status badges and metadata.

### Upload via API

```bash
curl -X POST https://<your-worker>/upload \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/photo.jpg"}'
```

**Response (201)**
```json
{
  "imageId": "550e8400-e29b-41d4-a716-446655440000",
  "url": "/images/550e8400-e29b-41d4-a716-446655440000",
  "message": "Image uploaded — alt-text will generate on first access"
}
```

### Serve an Image

```
GET /images/<uuid>
```

The response includes:

- The raw image bytes with the original `Content-Type`
- `X-Alt-Text` header — populated with the AI-generated description, or `Pending — description being generated` if still processing
- `X-Image-Id` header
- `Cache-Control` — `max-age=3600` once alt-text exists; `max-age=60, stale-while-revalidate=300` while pending

### Audit Log

```bash
curl https://<your-worker>/audit \
  -H "Authorization: Bearer <your-admin-token>"
```

**Query parameters**

| Parameter | Default | Description |
|---|---|---|
| `limit` | `50` | Records per page (max 100) |
| `page` | `1` | Page number |
| `id` | — | Fetch a single record by UUID |

**Response**
```json
{
  "total": 42,
  "page": 1,
  "limit": 50,
  "count": 42,
  "data": [
    {
      "id": "550e8400-...",
      "source_url": "https://example.com/photo.jpg",
      "alt_text": "A golden retriever running across a sunlit meadow.",
      "created_at": "2025-06-01T10:00:00",
      "updated_at": "2025-06-01T10:00:05"
    }
  ]
}
```

---

## Security

- **Bearer token auth** — all write and audit endpoints require a valid `Authorization: Bearer <token>` header. The token is stored as a Wrangler secret and never embedded in code.
- **SSRF protection** — the upload endpoint validates URLs against loopback (`127.x`, `::1`), link-local (`169.254.x`), and RFC1918 private ranges (`10.x`, `172.16–31.x`, `192.168.x`) before making any outbound fetch.
- **Input validation** — UUIDs are validated against a strict regex; source URLs must match `^https?://`. MIME types are checked against an allowlist before storage.
- **Alt-text sanitisation** — AI output is stripped of HTML tags, special characters are encoded, and the result is truncated to 500 characters before it is written to D1.
- **Rate limiting** — a sliding window of 10 requests per minute per IP is enforced via KV. The check fails open (does not block) if KV is unavailable.
- **CORS** — `Access-Control-Allow-Origin: *` is set on API responses. Restrict this to your specific origin in production.

---

## Caching Behaviour

| Scenario | Cache-Control | Edge cache? |
|---|---|---|
| Alt-text ready | `public, max-age=3600` | Yes — stored for 1 hour |
| Alt-text pending | `public, max-age=60, stale-while-revalidate=300` | Short-lived entry; rebuilt after AI completes |
| Repeated request | Served directly from Cache API | No compute, no R2/D1 reads |

Cache writes use `ctx.waitUntil()` so they happen in the background without adding latency to the response.

---

## Supported Image Types

`image/jpeg` · `image/png` · `image/gif` · `image/webp` · `image/avif`

Maximum upload size: **10 MB**

---

## Local Development

```bash
wrangler dev
```

> Note: Workers AI and R2 are not fully emulated locally. Use `wrangler dev --remote` to run against live Cloudflare infrastructure during development.

---

### Why Lazy AI Generation?

The free tier imposes a hard daily Neuron budget, and vision models consume significantly more Neurons per call than text models. Running inference at upload time would burn quota against every image regardless of whether it is ever viewed — most of which may never be accessed in a given day. The lazy pattern inverts this: **inference only fires when a real user actually requests the image**, meaning Neurons are only spent on images people care about.

**Upload-time performance.** Deliberately deferring AI is also what keeps the upload endpoint fast. At upload time the Worker does the minimum necessary work synchronously: a D1 deduplication check, an outbound fetch of the source image, an R2 write, and a D1 insert. That pipeline is I/O-bound but predictable. If inference were triggered here instead, the upload would stall for the full duration of a vision model call — typically several seconds — before returning a response to the caller. By moving AI out of the upload path entirely, the `POST /upload` endpoint returns a `201` as soon as the image is safely in R2 and D1, and the caller is never made to wait for something that does not block storage. The AI work happens later, in the background of the first `GET /images/:uuid` request, via `ctx.waitUntil()` so even that response is not delayed.

Three additional layers protect the budget further:

- **D1 as the gate.** Before any AI call is attempted, the Worker queries D1 for an existing `alt_text` value. If one is present the model is never invoked. This makes inference idempotent — re-deploying, cache-busting, or retrying a request never triggers a redundant AI job.
- **KV as the deduplication lock.** A short-lived key (`ai:<imageId>`, TTL 300 s) is written to KV before the model call. If a second concurrent request arrives for the same image while inference is in flight, it reads the lock and exits early. Without this guard, a burst of simultaneous requests for a cold image could fan out into multiple parallel AI calls, multiplying Neuron spend for a single asset.
- **Cache API as the long-term shield.** Once alt-text is ready, the full image response — including the `X-Alt-Text` header — is stored at the global edge with a one-hour TTL. Every subsequent request for that image is served entirely from cache: no Worker CPU, no R2 read, no D1 query, and crucially no AI call. A popular image could receive thousands of requests per day and consume exactly **one** inference job for its entire lifetime.

Together these three layers form a cost funnel: the Cache API eliminates the vast majority of requests before they reach the Worker, D1 eliminates any that do reach it but already have alt-text, and KV eliminates duplicate concurrent calls for the same cold image. AI is only invoked in the narrow case of a genuine first access.

---

## Environment Variables / Secrets

| Name | Type | Description |
|---|---|---|
| `ADMIN_TOKEN` | Secret | Bearer token for protected endpoints |
| `IMAGES` | R2 binding | Image blob storage |
| `DB` | D1 binding | Metadata and alt-text persistence |
| `RATE_LIMIT` | KV binding | Per-IP rate limit counters |
| `AI_QUOTA` | KV binding | AI deduplication locks |
| `AI` | AI binding | Workers AI access |

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

---

## Author

**Ogaga Agofure** — Cloud & Infrastructure Engineer