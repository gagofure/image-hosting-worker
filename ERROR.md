# Error Log: AI-Powered Image Worker

---

## Error 1 — Wrangler Login Failure
**Command:** `wrangler login`

**Error:**
```
Login failed / browser did not open
```

**Cause:** `wrangler login` is unreliable in some environments.

**Fix:** Use a Cloudflare API Token instead:
```
export CLOUDFLARE_API_TOKEN=your-token-here
```

---

## Error 2 — Authentication Error on R2 Bucket Create
**Command:** `wrangler r2 bucket create image-hosting-store`

**Error:**
```
A request to the Cloudflare API (/memberships) failed.
Unable to authenticate request [code: 10001]
```

**Cause:** `CLOUDFLARE_API_TOKEN` environment variable was not set in the terminal session.

**Fix:** Re-set the token in the terminal:
```
export CLOUDFLARE_API_TOKEN=your-token-here
```
Then verify with `wrangler whoami`.

---

## Error 3 — Authentication Error Persists After Token Set
**Command:** `wrangler r2 bucket create image-hosting-store`

**Error:**
```
A request to the Cloudflare API (/accounts/.../r2/buckets) failed.
Authentication error [code: 10000]
```

**Cause:** The custom API token was missing the `Workers R2 Storage: Edit` permission.

**Fix:** Edit the token at `https://dash.cloudflare.com/profile/api-tokens` and add all required permissions:

| Category | Permission | Access |
|----------|-----------|--------|
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Workers KV Storage | Edit |
| Account | D1 | Edit |
| Account | Workers AI | Read |
| User | Memberships | Read |
| User | User Details | Read |

---

## Error 4 — Lost API Token (Agent Lee Token)
**Problem:** Cloudflare auto-created a custom token called "Agent Lee" but the token value was never copied.

**Cause:** Cloudflare only shows the token value **once** right after creation. If you don't copy it immediately it's gone.

**Fix:** Either:
- Go to `https://dash.cloudflare.com/profile/api-tokens` → **Edit** → **Roll Token** to generate a new value with same permissions
- Or delete and recreate the token entirely

**Lesson:** Always copy your token immediately and save it somewhere safe like Notepad before doing anything else.

---

## Error 5 — Secret Set Before Worker Was Deployed
**Command:** `wrangler secret put ADMIN_TOKEN`

**Error:**
```
There doesn't seem to be a Worker called "image-hosting-worker". 
Do you want to create a new Worker with that name and add secrets to it? (Y/n)
```

**Cause:** Tried to set a secret before the worker was deployed.

**Fix:** Always deploy the worker first, then set secrets:
```
wrangler deploy
wrangler secret put ADMIN_TOKEN
```

---

## Error 6 — Database Unavailable on Ingest
**Command:**
```
curl -X POST https://image-hosting-worker.gretty.workers.dev/ingest \
  -H "Authorization: Bearer token" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://..."}'
```

**Error:**
```json
{"error":"Database unavailable"}
```

**Cause:** Multiple issues combined:
1. D1 table had not been created yet
2. `wrangler.jsonc` bindings used wrong names (`image_hosting_db` instead of `DB`, `image_hosting_store` instead of `IMAGES`)
3. AI binding was missing entirely from `wrangler.jsonc`

**Fix:** 

First create the table:
```
wrangler d1 execute image-hosting-db --remote --command "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, source_url TEXT UNIQUE, alt_text TEXT, created_at TEXT, updated_at TEXT);"
```

Then fix `wrangler.jsonc` to use the correct binding names that match the code:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "image-hosting-worker",
  "main": "src/index.js",
  "compatibility_date": "2026-02-26",
  "observability": {
    "enabled": true
  },
  "ai": {
    "binding": "AI"
  },
  "r2_buckets": [
    {
      "bucket_name": "image-hosting-store",
      "binding": "IMAGES"
    }
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "image-hosting-db",
      "database_id": "YOUR-D1-ID-HERE"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "RATE_LIMIT",
      "id": "YOUR-RATE-LIMIT-ID-HERE"
    },
    {
      "binding": "AI_QUOTA",
      "id": "YOUR-AI-QUOTA-ID-HERE"
    }
  ]
}
```

Then redeploy:
```
wrangler deploy
```

---

## Error 7 — D1 List Authentication Error
**Command:** `wrangler d1 list`

**Error:**
```
A request to the Cloudflare API (/accounts/.../d1/database) failed.
Authentication error [code: 10000]
```

**Cause:** Token was still missing the `D1: Edit` permission even after fixing R2.

**Fix:** Edit token again at `https://dash.cloudflare.com/profile/api-tokens`, add `D1: Edit`, roll the token, copy the new value and reset it in the terminal.

---

## Key Lessons Learned

**Always copy tokens immediately** — Cloudflare only shows them once.

**Token permissions must be set correctly upfront** — missing even one permission causes authentication errors for that specific service.

**Binding names in `wrangler.jsonc` must exactly match what the code uses** — `env.DB`, `env.IMAGES`, `env.AI`, `env.RATE_LIMIT`, `env.AI_QUOTA`.

**Deploy order matters:**
1. Create R2 bucket
2. Create D1 database
3. Create KV namespaces
4. Configure `wrangler.jsonc`
5. Create D1 table
6. `wrangler deploy`
7. `wrangler secret put ADMIN_TOKEN`
8. Test with curl

**Environment variable vs secret vs `.dev.vars`:**
- `wrangler.jsonc` `"vars"` → non-sensitive config, visible in plain text
- `wrangler secret put` → sensitive values, encrypted, used in deployed worker
- `.dev.vars` → local development only, completely ignored on deploy