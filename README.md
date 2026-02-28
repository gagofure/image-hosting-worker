# ImageWorker

ImageWorker is an AI-powered image hosting service built entirely on Cloudflare's developer platform. Upload an image URL, and ImageWorker stores it privately in R2, creates a metadata record in D1, and — on first access — automatically generates an accessibility description using a vision LLM. Every subsequent request is served from the global edge cache with zero compute.

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

Three layers protect inference budget:

- **D1 as the gate** — if `alt_text` already exists, the model is never invoked. Inference is idempotent across redeploys, cache busts, and retries.
- **KV as the deduplication lock** — a short-lived key (`ai:<imageId>`, TTL 300 s) prevents concurrent requests for the same cold image from fanning out into multiple parallel AI calls.
- **Cache API as the long-term shield** — once alt-text is ready, the full response is cached at the global edge for one hour. A popular image consumes exactly one inference job for its entire lifetime.

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

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient; a payment card is required to enable D1)
- [Node.js](https://nodejs.org/) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

```bash
npm install -g wrangler
```

```bash
export CLOUDFLARE_API_TOKEN=your-token
```

```bash
wrangler whoami
# Output should show your account and token scopes
```

---

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/gagofure/image-hosting-worker
cd image-hosting-worker
```

### 2. Create Cloudflare Resources

**R2 Bucket**
```bash
wrangler r2 bucket create image-worker-store
```

**D1 Database**
```bash
wrangler d1 create image-worker-db
```
Copy the `database_id` from the output — you'll need it for `wrangler.jsonc`.

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
      "bucket_name": "image-worker-store"
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
wrangler d1 execute image-worker-db --file=schema.sql
```

The `schema.sql` file (included in this repo) creates the `images` table and the indexes on `created_at` and `source_url`.

### 5. Accept the Vision Model License

Workers AI requires a one-time licence acceptance for the Llama vision model before it can be used. Run the command below, then follow the prompt in the [official docs](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/) if needed.

```bash
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -d '{"prompt": "agree"}'
```

### 6. Deploy

```bash
wrangler deploy
```

### 7. Set the Admin Token

```bash
wrangler secret put ADMIN_TOKEN
# Enter a strong, randomly generated token when prompted
```

---

## Usage

### Dashboard

Navigate to your Worker URL in a browser (e.g. `https://image-worker.<your-subdomain>.workers.dev`). Enter your admin token when prompted. The token is stored in `sessionStorage` for the duration of the tab session.

The dashboard has three tabs:

- **Upload** — paste a public image URL and submit. The image is fetched, validated, stored in R2, and a record is created in D1. Alt-text is generated lazily on first access.
- **Gallery** — browse all uploaded images. Cards show alt-text on hover. Pending alt-text updates automatically without a page reload.
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
- `X-Alt-Text` — the AI-generated description, or `Pending — description being generated` if still processing
- `X-Image-Id` — the image UUID
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
- **Alt-text sanitisation** — AI output is stripped of HTML tags, special characters are encoded, and the result is truncated to 500 characters before being written to D1 or returned in response headers.
- **Rate limiting** — a sliding window of 100 requests per minute per IP is enforced via KV. The limiter fails open (does not block requests) if KV is unavailable, to avoid turning a KV outage into a site-wide outage.
- **CORS** — `Access-Control-Allow-Origin: *` is set on all API responses. Restrict this to your deployed origin in production.

---

## Caching Behaviour

| Scenario | Cache-Control | Edge cache? |
|---|---|---|
| Alt-text ready | `public, max-age=3600` | Yes — stored for 1 hour |
| Alt-text pending | `public, max-age=60, stale-while-revalidate=300` | Short-lived; rebuilt after AI completes |
| Repeated request (warm) | Served from Cache API | No compute, no R2/D1 reads |

Cache writes use `ctx.waitUntil()` so they happen in the background without adding latency to the response.

---

## Supported Image Types

`image/jpeg` · `image/png` · `image/gif` · `image/webp` · `image/avif`

Maximum upload size: **10 MB**

---

## Local Development

```bash
wrangler dev --remote
```

> Workers AI and R2 are not fully emulated in local mode. The `--remote` flag runs the Worker against live Cloudflare infrastructure, which is the most reliable way to develop and test this project.

---

## Environment Variables & Secrets

| Name | Type | Description |
|---|---|---|
| `ADMIN_TOKEN` | Secret | Bearer token for protected endpoints |
| `IMAGES` | R2 binding | Image blob storage |
| `DB` | D1 binding | Metadata and alt-text persistence |
| `RATE_LIMIT` | KV binding | Per-IP rate limit counters |
| `AI_QUOTA` | KV binding | AI deduplication locks |
| `AI` | AI binding | Workers AI access |

---

## Author

**Ogaga Agofure**
