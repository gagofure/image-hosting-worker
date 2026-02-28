/**
 * Cloudflare Worker: AI-Powered Image Hosting
 * ─────────────────────────────────────────────────────────────────────────────
 * Stack: R2 (private image storage) · D1 (metadata persistence) ·
 *        Workers AI / Llama-3.2-11B-Vision (alt-text generation) ·
 *        Cache API (edge caching) · Workers KV (rate-limit + AI dedupe)
 *
 * Design principle: LAZY AI generation
 *   Neurons are only spent when an image is actually requested.
 *   D1 acts as the gate (skip AI if alt-text exists),
 *   KV acts as the concurrent-request guard (dedupe lock),
 *   Cache API acts as the global performance layer (zero compute on repeat hits).
 *
 * Routes:
 *   GET  /             → embedded frontend dashboard
 *   GET  /images/:uuid → serve image + X-Alt-Text header
 *   POST /upload       → upload image from external URL (auth required)
 *   GET  /audit        → paginated JSON inventory (auth required)
 *
 * NOTE: On first deploy, you must accept Meta's license for the vision model.
 *   Send one request to Workers AI with { prompt: "agree" } before normal use.
 *   See: https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
 *
 * Author: Ogaga Agofure
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_TTL = 75;
const AI_DEDUPE_TTL = 300;
const CACHE_MAX_AGE = 3600;
const CACHE_PENDING_AGE = 60;
const ALT_TEXT_MAX_LEN = 500;
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const ALLOWED_TYPES = new Set([
	'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── CORS ───────────────────────────────────────────────────────────────────
// Shared headers applied to every API response so browsers can read the body
// and custom headers cross-origin.
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*', // Restrict to your deployed origin in production
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	// Expose custom and cache headers to browser JS
	'Access-Control-Expose-Headers': 'X-Alt-Text, X-Image-Id, CF-Cache-Status, Cache-Control',
};

/** Inject CORS headers into any existing Response without touching its body. */
function withCors(response) {
	const r = new Response(response.body, response);
	for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
	return r;
}

// ─── Alt-text sanitisation ──────────────────────────────────────────────────
// Strips HTML tags and encodes special characters from AI output before storage.
// Prevents malicious model responses from injecting markup into the database or UI.
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function sanitiseAltText(raw) {
	return String(raw ?? '')
		.trim()
		.replace(/<[^>]*>/g, '')                        // Remove any HTML tags
		.replace(/[&<>"'`]/g, c => HTML_ESCAPE_MAP[c])  // Encode special characters
		.slice(0, ALT_TEXT_MAX_LEN);
}


// ─── Entry point ──────────────────────────────────────────────────────────────
export default {
	async fetch(request, env, ctx) {
		try {
			return await router(request, env, ctx);
		} catch (err) {
			console.error('Unhandled error:', err);
			return jsonError('Internal server error', 500);
		}
	},
};

async function router(request, env, ctx) {
	// Respond to CORS preflight requests before any other processing.
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	const { pathname } = new URL(request.url);

	// Health check endpoint — used by uptime monitors and deployment pipelines.
	if (pathname === '/health') {
		return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
			status: 200,
			headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
		});
	}

	// Apply rate limiting only to API endpoints, not the dashboard or static routes.
	const rateLimitResponse = await rateLimit(request, env);
	if (rateLimitResponse) return rateLimitResponse;

	if (pathname === '/') return handleRoot();
	if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
	if (pathname === '/audit') return handleAudit(request, env);
	if (pathname === '/upload') return handleUpload(request, env);

	const imageId = pathname.replace(/^\/images\/+/, '');
	if (pathname.startsWith('/images/') && UUID_RE.test(imageId)) {
		return handleImage(imageId, request, env, ctx);
	}

	return Response.json(
		{ error: 'Not found', routes: ['GET /images/:uuid', 'POST /upload', 'GET /audit'] },
		{ status: 404 }
	);
}

// ─── Frontend dashboard ───────────────────────────────────────────────────────
function handleRoot() {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ImageWorker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700&family=Inconsolata:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:       #0a0a09;
      --surface:  #111110;
      --border:   #222220;
      --accent:   #e8f44d;
      --accent2:  #4df4a0;
      --text:     #ede8df;
      --muted:    #6b6860;
      --error:    #f4604d;
      --sans:     'Syne', sans-serif;
      --mono:     'Inconsolata', monospace;
    }

    html, body { height: 100%; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      min-height: 100vh;
    }

    /* ── AUTH GATE ── */
    #auth-gate {
      position: fixed; inset: 0;
      background: var(--bg);
      display: flex; align-items: center; justify-content: center;
      z-index: 100;
      animation: fadeIn 0.3s ease;
    }

    .auth-box {
      width: 100%; max-width: 380px;
      padding: 2.5rem;
      border: 1px solid var(--border);
      background: var(--surface);
    }

    .auth-box h2 {
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 0.4rem;
      color: var(--accent);
    }

    .auth-box p {
      font-family: var(--mono);
      font-size: 0.78rem;
      color: var(--muted);
      margin-bottom: 1.5rem;
    }

    .auth-error {
      font-family: var(--mono);
      font-size: 0.75rem;
      color: var(--error);
      margin-top: 0.75rem;
      display: none;
    }

    /* ── INPUTS & BUTTONS ── */
    input[type="text"], input[type="password"], input[type="url"] {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--mono);
      font-size: 0.85rem;
      padding: 0.65rem 0.9rem;
      outline: none;
      transition: border-color 0.2s;
    }

    input:focus { border-color: var(--accent); }

    button {
      cursor: pointer;
      font-family: var(--sans);
      font-weight: 600;
      font-size: 0.8rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: none;
      padding: 0.65rem 1.4rem;
      transition: opacity 0.15s, background 0.15s;
    }

    .btn-primary {
      background: var(--accent);
      color: #000;
      width: 100%;
      margin-top: 0.75rem;
    }

    .btn-primary:hover { opacity: 0.85; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-sm {
      background: var(--border);
      color: var(--text);
      font-size: 0.72rem;
      padding: 0.4rem 0.9rem;
    }

    .btn-sm:hover { background: #2a2a28; }

    /* ── APP SHELL ── */
    #app { display: none; flex-direction: column; min-height: 100vh; }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.1rem 2rem;
      border-bottom: 1px solid var(--border);
      position: sticky; top: 0;
      background: var(--bg);
      z-index: 10;
    }

    .logo {
      font-weight: 700;
      font-size: 1rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .neuron-badge {
      font-family: var(--mono);
      font-size: 0.72rem;
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 0.25rem 0.7rem;
      border-radius: 2rem;
    }

    /* ── TABS ── */
    .tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      padding: 0 2rem;
      background: var(--bg);
    }

    .tab {
      font-family: var(--sans);
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 0.85rem 1.25rem;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
      transition: color 0.15s, border-color 0.15s;
    }

    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab:hover:not(.active) { color: var(--text); }

    /* ── MAIN CONTENT ── */
    main { flex: 1; padding: 2rem; max-width: 1400px; width: 100%; margin: 0 auto; }

    .panel { display: none; }
    .panel.active { display: block; animation: fadeUp 0.25s ease; }

    /* ── INGEST PANEL ── */
    .upload-card {
      max-width: 560px;
      border: 1px solid var(--border);
      padding: 2rem;
      background: var(--surface);
    }

    .upload-card h2 {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 0.35rem;
    }

    .upload-card p {
      font-family: var(--mono);
      font-size: 0.78rem;
      color: var(--muted);
      margin-bottom: 1.5rem;
      line-height: 1.6;
    }

    .upload-result {
      margin-top: 1rem;
      font-family: var(--mono);
      font-size: 0.78rem;
      padding: 0.75rem 1rem;
      border-left: 3px solid var(--accent2);
      background: #0d1a12;
      display: none;
      word-break: break-all;
      line-height: 1.6;
    }

    .upload-result.error { border-color: var(--error); background: #1a0d0d; }

    /* ── IMAGE GRID ── */
    .grid-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
    }

    .grid-header h2 {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .grid-count {
      font-family: var(--mono);
      font-size: 0.75rem;
      color: var(--muted);
    }

    .image-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
    }

    .image-card {
      background: var(--surface);
      cursor: pointer;
      overflow: hidden;
      position: relative;
      aspect-ratio: 1;
      transition: background 0.2s;
    }

    .image-card:hover { background: #1a1a18; }

    .image-card img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.3s ease;
    }

    .image-card:hover img { transform: scale(1.04); }

    .image-card-overlay {
      position: absolute; inset: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 50%);
      padding: 1rem;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .image-card:hover .image-card-overlay { opacity: 1; }

    .image-card-alt {
      font-family: var(--mono);
      font-size: 0.7rem;
      color: #fff;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .image-card-pending {
      font-family: var(--mono);
      font-size: 0.68rem;
      color: var(--accent);
      margin-top: 0.3rem;
    }

    .image-placeholder {
      width: 100%; height: 100%;
      background: var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 0.7rem;
      color: var(--muted);
    }

    /* ── AUDIT TABLE ── */
    .audit-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .audit-header h2 {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .audit-pagination {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-family: var(--mono);
      font-size: 0.75rem;
      color: var(--muted);
    }

    .table-wrap { overflow-x: auto; border: 1px solid var(--border); }

    table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--mono);
      font-size: 0.78rem;
    }

    thead { background: var(--surface); }

    th {
      text-align: left;
      padding: 0.75rem 1rem;
      font-family: var(--sans);
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }

    td {
      padding: 0.7rem 1rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      color: var(--text);
    }

    tr:last-child td { border-bottom: none; }

    tr:hover td { background: var(--surface); }

    .td-id { color: var(--muted); font-size: 0.7rem; }

    .td-url {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
    }

    .td-alt {
      max-width: 300px;
      line-height: 1.5;
      color: var(--text);
    }

    .badge-pending {
      display: inline-block;
      font-size: 0.65rem;
      padding: 0.15rem 0.5rem;
      background: #1a1a0d;
      border: 1px solid #3a3a10;
      color: var(--accent);
      border-radius: 2rem;
    }

    .badge-done {
      display: inline-block;
      font-size: 0.65rem;
      padding: 0.15rem 0.5rem;
      background: #0d1a12;
      border: 1px solid #103a20;
      color: var(--accent2);
      border-radius: 2rem;
    }

    /* ── MODAL ── */
    #modal {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.85);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 50;
      padding: 2rem;
      backdrop-filter: blur(4px);
    }

    #modal.open { display: flex; animation: fadeIn 0.2s ease; }

    .modal-box {
      background: var(--surface);
      border: 1px solid var(--border);
      max-width: 860px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    @media (max-width: 640px) {
      .modal-box { grid-template-columns: 1fr; }
    }

    .modal-img-wrap {
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 280px;
    }

    .modal-img-wrap img {
      width: 100%; height: 100%;
      object-fit: contain;
      max-height: 500px;
    }

    .modal-info {
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .modal-close {
      position: absolute;
      top: 1rem; right: 1rem;
      background: var(--border);
      color: var(--text);
      border: none;
      width: 32px; height: 32px;
      cursor: pointer;
      font-size: 1rem;
      display: flex; align-items: center; justify-content: center;
    }

    .modal-close:hover { background: #333; }

    .info-label {
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.35rem;
    }

    .info-value {
      font-family: var(--mono);
      font-size: 0.82rem;
      line-height: 1.6;
      color: var(--text);
      word-break: break-all;
    }

    .info-value a {
      color: var(--accent);
      text-decoration: none;
    }

    .info-value a:hover { text-decoration: underline; }

    .modal-alt-text {
      font-family: var(--mono);
      font-size: 0.85rem;
      line-height: 1.7;
      color: var(--text);
      background: var(--bg);
      padding: 1rem;
      border-left: 3px solid var(--accent);
    }

    /* ── EMPTY / LOADING ── */
    .empty-state {
      text-align: center;
      padding: 5rem 2rem;
      font-family: var(--mono);
      color: var(--muted);
      font-size: 0.85rem;
      line-height: 1.8;
    }

    .spinner {
      width: 20px; height: 20px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      display: inline-block;
      vertical-align: middle;
      margin-right: 0.5rem;
    }

    /* ── ANIMATIONS ── */
    @keyframes fadeIn  { from { opacity: 0 } to { opacity: 1 } }
    @keyframes fadeUp  { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
    @keyframes spin    { to { transform: rotate(360deg) } }
  </style>
</head>
<body>

<!-- ── AUTH GATE ── -->
<div id="auth-gate">
  <div class="auth-box">
    <h2>ImageWorker</h2>
    <p>Enter your admin token to access the dashboard.</p>
    <input type="password" id="token-input" placeholder="Bearer token..." autocomplete="off" />
    <button class="btn-primary" id="auth-btn">Unlock Dashboard</button>
    <p class="auth-error" id="auth-error">Invalid token — unauthorized.</p>
  </div>
</div>

<!-- ── APP ── -->
<div id="app">
  <header>
    <span class="logo">ImageWorker</span>
    <div class="header-right">
      <span class="neuron-badge" id="model-badge">llama-3.2-11b-vision</span>
      <button class="btn-sm" id="logout-btn">Logout</button>
    </div>
  </header>

  <div class="tabs">
    <button class="tab active" data-tab="upload">Upload</button>
    <button class="tab" data-tab="gallery">Gallery</button>
    <button class="tab" data-tab="audit">Audit</button>
  </div>

  <main>
    <!-- INGEST -->
    <div class="panel active" id="panel-upload">
      <div class="upload-card">
        <h2>Upload Image</h2>
        <p>Paste a public image URL. It'll be stored in R2 and alt-text generated lazily on first view.</p>
        <input type="url" id="upload-url" placeholder="https://example.com/image.jpg" />
        <button class="btn-primary" id="upload-btn">Upload Image</button>
        <div class="upload-result" id="upload-result"></div>
      </div>
    </div>

    <!-- GALLERY -->
    <div class="panel" id="panel-gallery">
      <div class="grid-header">
        <h2>Gallery</h2>
        <span class="grid-count" id="gallery-count"></span>
      </div>
      <div class="image-grid" id="image-grid"></div>
      <div class="empty-state" id="gallery-empty" style="display:none">No images uploaded yet.<br/>Use the Upload tab to add some.</div>
    </div>

    <!-- AUDIT -->
    <div class="panel" id="panel-audit">
      <div class="audit-header">
        <h2>Audit Log</h2>
        <div class="audit-pagination">
          <button class="btn-sm" id="prev-btn" disabled>← Prev</button>
          <span id="page-info">—</span>
          <button class="btn-sm" id="next-btn" disabled>Next →</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Source URL</th>
              <th>Alt Text</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="audit-body"></tbody>
        </table>
      </div>
      <div class="empty-state" id="audit-empty" style="display:none">No records found.</div>
    </div>
  </main>
</div>

<!-- ── IMAGE MODAL ── -->
<div id="modal">
  <div class="modal-box" style="position:relative">
    <button class="modal-close" id="modal-close">✕</button>
    <div class="modal-img-wrap">
      <img id="modal-img" src="" alt="" />
    </div>
    <div class="modal-info">
      <div>
        <div class="info-label">Image ID</div>
        <div class="info-value" id="modal-id"></div>
      </div>
      <div>
        <div class="info-label">Source URL</div>
        <div class="info-value" id="modal-url"></div>
      </div>
      <div>
        <div class="info-label">Alt Text</div>
        <div class="modal-alt-text" id="modal-alt"></div>
      </div>
      <div>
        <div class="info-label">Uploaded</div>
        <div class="info-value" id="modal-date"></div>
      </div>
    </div>
  </div>
</div>

<script>
  // ── State ──
  let TOKEN = '';
  let auditPage = 1;
  const LIMIT = 20;

  // ── Auth ──
  const authGate = document.getElementById('auth-gate');
  const app      = document.getElementById('app');
  const authBtn  = document.getElementById('auth-btn');
  const authErr  = document.getElementById('auth-error');
  const tokenIn  = document.getElementById('token-input');

  // Restore session on page load. sessionStorage survives a refresh but is cleared
  // when the tab closes — appropriate for an admin token that should not persist indefinitely.
  const _saved = sessionStorage.getItem('iw_token');
  if (_saved) {
    TOKEN = _saved;
    authGate.style.display = 'none';
    app.style.display      = 'flex';
    loadGallery();
  }

  tokenIn.addEventListener('keydown', e => { if (e.key === 'Enter') attemptAuth(); });
  authBtn.addEventListener('click', attemptAuth);

  async function attemptAuth() {
    const t = tokenIn.value.trim();
    if (!t) return;
    authBtn.disabled = true;
    authBtn.textContent = 'Checking...';
    try {
      const res = await fetch('/audit?limit=1', {
        headers: { Authorization: 'Bearer ' + t }
      });
      if (res.status === 401) {
        authErr.style.display = 'block';
        authBtn.disabled = false;
        authBtn.textContent = 'Unlock Dashboard';
        return;
      }
      TOKEN = t;
      sessionStorage.setItem('iw_token', t);
      authGate.style.display = 'none';
      app.style.display = 'flex';
      loadGallery();
    } catch {
      authErr.textContent = 'Network error — is the worker running?';
      authErr.style.display = 'block';
      authBtn.disabled = false;
      authBtn.textContent = 'Unlock Dashboard';
    }
  }

  document.getElementById('logout-btn').addEventListener('click', () => {
    TOKEN = '';
    sessionStorage.removeItem('iw_token');
    tokenIn.value = '';
    authErr.style.display = 'none';
    authBtn.disabled = false;
    authBtn.textContent = 'Unlock Dashboard';
    authGate.style.display = 'flex';
    app.style.display = 'none';
  });

  // ── Tabs ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById('panel-' + tab.dataset.tab);
      panel.classList.add('active');
      if (tab.dataset.tab === 'gallery') loadGallery();
      if (tab.dataset.tab === 'audit')   loadAudit(1);
    });
  });

  // ── Upload ──
  const uploadBtn    = document.getElementById('upload-btn');
  const uploadUrl    = document.getElementById('upload-url');
  const uploadResult = document.getElementById('upload-result');

  uploadUrl.addEventListener('keydown', e => { if (e.key === 'Enter') doUpload(); });
  uploadBtn.addEventListener('click', doUpload);

  async function doUpload() {
    const url = uploadUrl.value.trim();
    if (!url) return;
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<span class="spinner"></span>Uploading...';
    uploadResult.style.display = 'none';
    uploadResult.className = 'upload-result';

    try {
      const res  = await fetch('/upload', {
        method:  'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url }),
      });
      const data = await res.json();

      if (!res.ok) {
        uploadResult.classList.add('error');
        uploadResult.textContent = 'Error ' + res.status + ': ' + (data.error ?? 'Unknown error');
      } else {
        uploadResult.textContent =
          (data.message ?? 'Uploaded') + '\\n' +
          'ID: ' + data.imageId + '\\n' +
          'URL: ' + window.location.origin + data.url;
        uploadUrl.value = '';
      }
    } catch (err) {
      uploadResult.classList.add('error');
      uploadResult.textContent = 'Network error: ' + err.message;
    }

    uploadResult.style.display = 'block';
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload Image';
  }

  // ── Gallery ──
  async function loadGallery() {
    const grid  = document.getElementById('image-grid');
    const empty = document.getElementById('gallery-empty');
    const count = document.getElementById('gallery-count');
    grid.innerHTML = '<div style="padding:3rem;font-family:var(--mono);font-size:0.78rem;color:var(--muted);background:var(--surface)"><span class="spinner"></span>Loading...</div>';
    empty.style.display = 'none';

    try {
      const res  = await fetch('/audit?limit=100', { headers: { Authorization: 'Bearer ' + TOKEN } });
      const data = await res.json();

      grid.innerHTML = '';

      if (!data.data || data.data.length === 0) {
        grid.style.display = 'none';
        empty.style.display = 'block';
        return;
      }

      grid.style.display = 'grid';
      count.textContent = data.total + ' image' + (data.total !== 1 ? 's' : '');

      data.data.forEach(row => {
        const card = document.createElement('div');
        card.className  = 'image-card';
        card.dataset.id = row.id;

        // Build card using DOM methods so database values are never parsed as HTML.
        const img = document.createElement('img');
        img.src     = '/images/' + row.id;
        img.alt     = row.alt_text ?? '';
        img.loading = 'lazy';
        img.onerror = function () {
          const ph = document.createElement('div');
          ph.className   = 'image-placeholder';
          ph.textContent = 'Failed to load';
          this.parentNode.replaceChild(ph, this);
        };

        const overlay = document.createElement('div');
        overlay.className = 'image-card-overlay';

        const altDiv = document.createElement('div');
        altDiv.className   = 'image-card-alt';
        altDiv.textContent = row.alt_text ?? '';
        overlay.appendChild(altDiv);

        if (!row.alt_text) {
          const pending = document.createElement('div');
          pending.className   = 'image-card-pending';
          pending.textContent = '⏳ Generating alt-text...';
          overlay.appendChild(pending);
        }

        card.appendChild(img);
        card.appendChild(overlay);
        card.addEventListener('click', () => openModal(row));
        grid.appendChild(card);
      });
    } catch (err) {
      grid.innerHTML = '<div style="padding:2rem;font-family:var(--mono);font-size:0.78rem;color:var(--error)">Failed to load: ' + err.message + '</div>';
    }
  }

  // ── Audit ──
  async function loadAudit(page) {
    auditPage = page;
    const body  = document.getElementById('audit-body');
    const empty = document.getElementById('audit-empty');
    const info  = document.getElementById('page-info');
    body.innerHTML = '<tr><td colspan="5" style="padding:2rem;font-family:var(--mono);font-size:0.78rem;color:var(--muted)"><span class="spinner"></span>Loading...</td></tr>';
    empty.style.display = 'none';

    try {
      const offset = (page - 1) * LIMIT;
      const res    = await fetch(\`/audit?limit=\${LIMIT}&page=\${page}\`, {
        headers: { Authorization: 'Bearer ' + TOKEN }
      });
      const data = await res.json();

      body.innerHTML = '';

      if (!data.data || data.data.length === 0) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }

      const totalPages = Math.ceil(data.total / LIMIT);
      info.textContent = 'Page ' + page + ' of ' + totalPages + ' (' + data.total + ' total)';

      document.getElementById('prev-btn').disabled = page <= 1;
      document.getElementById('next-btn').disabled = page >= totalPages;

      data.data.forEach(row => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';

        // Populate table cells using textContent so database values render as plain text.
        const tdId = document.createElement('td');
        tdId.className   = 'td-id';
        tdId.textContent = row.id.slice(0, 8) + '…';

        const tdUrl = document.createElement('td');
        tdUrl.className   = 'td-url';
        tdUrl.title       = row.source_url ?? '';
        tdUrl.textContent = row.source_url ?? '—';

        const tdAlt = document.createElement('td');
        tdAlt.className   = 'td-alt';
        tdAlt.textContent = row.alt_text
          ? row.alt_text.slice(0, 80) + (row.alt_text.length > 80 ? '…' : '')
          : '—';

        const tdStatus = document.createElement('td');
        const badge = document.createElement('span');
        badge.className   = row.alt_text ? 'badge-done' : 'badge-pending';
        badge.textContent = row.alt_text ? 'Done' : 'Pending';
        tdStatus.appendChild(badge);

        const tdDate = document.createElement('td');
        tdDate.style.whiteSpace = 'nowrap';
        tdDate.style.color      = 'var(--muted)';
        tdDate.textContent      = row.created_at ? row.created_at.slice(0, 10) : '—';

        tr.append(tdId, tdUrl, tdAlt, tdStatus, tdDate);
        tr.addEventListener('click', () => openModal(row));
        body.appendChild(tr);
      });

    } catch (err) {
      body.innerHTML = '<tr><td colspan="5" style="color:var(--error);padding:1rem;font-family:var(--mono);font-size:0.78rem">Failed to load: ' + err.message + '</td></tr>';
    }
  }

  document.getElementById('prev-btn').addEventListener('click', () => loadAudit(auditPage - 1));
  document.getElementById('next-btn').addEventListener('click', () => loadAudit(auditPage + 1));

  // ── Modal ──
  function openModal(row) {
    document.getElementById('modal-img').src  = '/images/' + row.id;
    document.getElementById('modal-img').alt  = row.alt_text ?? '';
    document.getElementById('modal-id').textContent   = row.id;
    document.getElementById('modal-date').textContent = row.created_at ?? '—';
    document.getElementById('modal-alt').textContent  = row.alt_text
      ?? 'Generating alt-text… this updates automatically.';

    const urlEl = document.getElementById('modal-url');
    // Build the anchor element via DOM so the URL is never interpreted as markup.
    if (row.source_url) {
      const a = document.createElement('a');
      a.href        = row.source_url;
      a.target      = '_blank';
      a.rel         = 'noopener';
      a.textContent = row.source_url;
      urlEl.innerHTML = '';
      urlEl.appendChild(a);
    } else {
      urlEl.textContent = '—';
    }

    document.getElementById('modal').classList.add('open');

    // If alt-text is already present there is nothing more to do.
    // Otherwise the GET /images/:uuid fired by the <img> tag has already triggered
    // background AI generation — poll just this one record until the text is ready.
    if (!row.alt_text) {
      pollSingleCard(row.id);
    }
  }

  // Polls /audit?id= for a single image until its alt-text has been generated.
  // Stops automatically once the text is available or the modal is closed.
  // Fetches only one record per request — no over-fetching.
  async function pollSingleCard(imageId) {
    if (!document.getElementById('modal').classList.contains('open')) return;

    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!document.getElementById('modal').classList.contains('open')) return;

    try {
      const res    = await fetch('/audit?limit=1&id=' + imageId, {
        headers: { Authorization: 'Bearer ' + TOKEN }
      });
      const data   = await res.json();
      const record = data.data?.[0];

      if (record?.alt_text) {
        // Update the modal.
        document.getElementById('modal-alt').textContent = record.alt_text;
        document.getElementById('modal-img').alt         = record.alt_text;

        // Update the matching gallery card without a page reload.
        const card = document.querySelector('[data-id="' + imageId + '"]');
        if (card) {
          const altDiv  = card.querySelector('.image-card-alt');
          const pending = card.querySelector('.image-card-pending');
          if (altDiv)  altDiv.textContent = record.alt_text;
          if (pending) pending.remove();
        }
        return;
      }

      // Alt-text not ready yet — check again after another interval.
      pollSingleCard(imageId);

    } catch (err) {
      // Non-critical — a failed poll attempt is silently skipped.
      console.warn('Alt-text poll error:', err.message);
    }
  }

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) closeModal();
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  function closeModal() {
    document.getElementById('modal').classList.remove('open');
    document.getElementById('modal-img').src = '';
  }
</script>
</body>
</html>`;

	return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ─── Rate limiting (best-effort, fail-open) ───────────────────────────────────
async function rateLimit(request, env) {
	// Only apply rate limiting to API endpoints.
	const { pathname } = new URL(request.url);
	const isApiPath = pathname.startsWith('/images/') || pathname === '/upload' || pathname === '/audit';
	if (!isApiPath) return null;

	if (!env.RATE_LIMIT) return null;

	const ip = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	const win = Math.floor(Date.now() / 60_000);
	const key = `rl:${ip}:${win}`;

	try {
		const count = Number(await env.RATE_LIMIT.get(key) ?? 0);
		if (count >= RATE_LIMIT_MAX) {
			return new Response('Too Many Requests', {
				status: 429,
				headers: { 'Retry-After': '60', 'Content-Type': 'text/plain' },
			});
		}
		await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL });
	} catch (err) {
		console.error('Rate-limit KV error:', err);
	}

	return null;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────
function requireBearer(request, env) {
	if (!env.ADMIN_TOKEN) {
		return jsonError('Server misconfiguration: ADMIN_TOKEN not set', 500);
	}
	/*
	 * Production hardening (out of scope for this assignment):
	 * - Rotate via `wrangler secret put ADMIN_TOKEN` — zero redeploy needed.
	 * - For per-session tokens, store { token, expiresAt } in KV and verify on each request.
	 * - Consider short-lived JWTs signed with a rotating KV-stored secret.
	 */
	const auth = request.headers.get('Authorization') ?? '';
	if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
		return new Response('Unauthorized', {
			status: 401,
			headers: { 'WWW-Authenticate': 'Bearer realm="image-worker"' },
		});
	}
	return null;
}

// ─── Image serve ──────────────────────────────────────────────────────────────
async function handleImage(imageId, request, env, ctx) {
	if (request.method !== 'GET') {
		return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
	}

	const cache = caches.default;
	const cacheKey = new Request(request.url, { method: 'GET' });

	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const [d1Result, r2Result] = await Promise.allSettled([
		env.DB.prepare('SELECT alt_text FROM images WHERE id = ?').bind(imageId).first(),
		env.IMAGES.get(imageId),
	]);

	if (r2Result.status === 'rejected') {
		console.error('R2 error:', r2Result.reason);
		return jsonError('Storage unavailable', 503);
	}

	const obj = r2Result.value;
	if (!obj) return jsonError('Image not found', 404);

	if (d1Result.status === 'rejected') {
		console.error('D1 read error (continuing without alt-text):', d1Result.reason);
	}

	const altText = d1Result.status === 'fulfilled' ? (d1Result.value?.alt_text ?? '') : '';
	const imageBytes = await obj.arrayBuffer();
	const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';

	const headers = new Headers({
		'Content-Type': contentType,
		'X-Alt-Text': altText || 'Pending — description being generated',
		'Cache-Control': altText
			? `public, max-age=${CACHE_MAX_AGE}`
			: `public, max-age=${CACHE_PENDING_AGE}, stale-while-revalidate=300`,
		'X-Image-Id': imageId,
		// Expose headers that the dashboard JS needs to read.
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'X-Alt-Text, X-Image-Id, CF-Cache-Status, Cache-Control',
	});

	const response = new Response(imageBytes, { status: 200, headers });

	if (altText) {
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
	} else {
		ctx.waitUntil(
			generateAndCache(imageId, imageBytes, cacheKey, response.clone(), env, cache)
		);
	}

	return response;
}

// ─── Background: AI generation → cache rebuild ───────────────────────────────
async function generateAndCache(imageId, imageBytes, cacheKey, response, env, cache) {
	await generateAltTextOnce(imageId, imageBytes, env);

	try {
		const row = await env.DB
			.prepare('SELECT alt_text FROM images WHERE id = ?')
			.bind(imageId)
			.first();

		if (row?.alt_text) {
			const enrichedHeaders = new Headers(response.headers);
			enrichedHeaders.set('X-Alt-Text', row.alt_text);
			enrichedHeaders.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}`);

			const body = await response.arrayBuffer();
			await cache.put(cacheKey,
				new Response(body, { status: 200, headers: enrichedHeaders })
			);
			return;
		}
	} catch (err) {
		console.error('Post-AI cache rebuild failed:', err);
	}

	await cache.put(cacheKey, response);
}

// ─── AI generation (idempotent, compute-efficient) ────────────────────────────
async function generateAltTextOnce(imageId, imageBytes, env) {
	if (env.AI_QUOTA) {
		try {
			const lockKey = `ai:${imageId}`;
			const locked = await env.AI_QUOTA.get(lockKey);
			if (locked) return;
			await env.AI_QUOTA.put(lockKey, '1', { expirationTtl: AI_DEDUPE_TTL });
		} catch (err) {
			console.error('AI dedupe KV error:', err);
		}
	}

	try {
		const result = await env.AI.run(VISION_MODEL, {
			messages: [
				{
					role: 'system',
					content: 'You are an accessibility assistant. Describe images concisely for use as alt-text.',
				},
				{
					role: 'user',
					content: 'Describe this image in one concise sentence suitable for use as alt-text.',
				},
			],
			image: [...new Uint8Array(imageBytes)],
		});

		// Sanitise the model response before writing to the database.
		const altText = sanitiseAltText(String(result?.response ?? '').trim());

		if (!altText) {
			console.warn('AI returned empty description for:', imageId);
			return;
		}

		await env.DB
			.prepare(`
        INSERT INTO images (id, alt_text, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          alt_text   = excluded.alt_text,
          updated_at = excluded.updated_at
      `)
			.bind(imageId, altText)
			.run();

	} catch (err) {
		console.error('AI/D1 write failed for:', imageId, err);
	}
}

// ─── Audit endpoint ───────────────────────────────────────────────────────────
async function handleAudit(request, env) {
	if (request.method !== 'GET') {
		return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
	}

	const authError = requireBearer(request, env);
	if (authError) return authError;

	try {
		const url    = new URL(request.url);
		const id     = url.searchParams.get('id') ?? null;
		const limit  = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
		const page   = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
		const offset = (page - 1) * limit;

		// Single-record lookup used by the dashboard when polling for alt-text completion.
		// Returns one row by ID rather than fetching a full page of results.
		if (id) {
			if (!UUID_RE.test(id)) return withCors(jsonError('Invalid id', 400));
			const row = await env.DB
				.prepare('SELECT id, source_url, alt_text, created_at, updated_at FROM images WHERE id = ?')
				.bind(id)
				.first();
			return withCors(Response.json({
				total: row ? 1 : 0,
				page:  1,
				limit: 1,
				count: row ? 1 : 0,
				data:  row ? [row] : [],
			}));
		}

		const [rows, total] = await Promise.all([
			env.DB.prepare(`
        SELECT id, source_url, alt_text, created_at, updated_at
        FROM   images
        ORDER  BY created_at DESC
        LIMIT  ? OFFSET ?
      `).bind(limit, offset).all(),
			env.DB.prepare('SELECT COUNT(*) AS n FROM images').first(),
		]);

		return withCors(Response.json({
			total: total?.n ?? 0,
			page,
			limit,
			count: rows.results.length,
			data:  rows.results,
		}));
	} catch (err) {
		console.error('Audit query failed:', err);
		return withCors(jsonError('Database unavailable', 503));
	}
}

// ─── Upload endpoint ──────────────────────────────────────────────────────────
async function handleUpload(request, env) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
	}

	const authError = requireBearer(request, env);
	if (authError) return authError;

	let body;
	try {
		body = await request.json();
	} catch {
		return jsonError('Invalid JSON — expected: {"url":"https://..."}', 400);
	}

	const sourceUrl = String(body?.url ?? '').trim();
	if (!/^https?:\/\/.+/.test(sourceUrl)) {
		return jsonError('Valid https URL required', 400);
	}

	if (!isSafeUrl(sourceUrl)) {
		return withCors(jsonError('URL resolves to a disallowed network range', 400));
	}

	try {
		const existing = await env.DB
			.prepare('SELECT id FROM images WHERE source_url = ?')
			.bind(sourceUrl)
			.first();

		if (existing) {
			return withCors(Response.json(
				{ imageId: existing.id, url: `/images/${existing.id}`, message: 'Already uploaded' },
				{ status: 200 }
			));
		}
	} catch (err) {
		console.error('D1 dedupe check failed:', err);
		return jsonError('Database unavailable', 503);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	let imgResponse;

	try {
		imgResponse = await fetch(sourceUrl, {
			signal: controller.signal,
			headers: { 'User-Agent': 'Cloudflare-Worker-ImageUploador/1.0' },
		});
	} catch (err) {
		return withCors(jsonError(`Failed to fetch source URL: ${err.message}`, 502));
	} finally {
		clearTimeout(timer);
	}

	if (!imgResponse.ok) {
		return withCors(jsonError(`Source URL returned ${imgResponse.status}`, 502));
	}

	const mimeType = (imgResponse.headers.get('content-type') ?? '')
		.split(';')[0].trim().toLowerCase();
	if (!ALLOWED_TYPES.has(mimeType)) {
		return withCors(jsonError(
			`Unsupported media type: ${mimeType}. Allowed: ${[...ALLOWED_TYPES].join(', ')}`,
			415
		));
	}

	const bytes = await imgResponse.arrayBuffer();
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		return withCors(jsonError(
			`Image exceeds 10 MB limit (got ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`,
			413
		));
	}

	const imageId = crypto.randomUUID();

	try {
		await env.IMAGES.put(imageId, bytes, {
			httpMetadata: { contentType: mimeType },
			customMetadata: { sourceUrl, uploadedAt: new Date().toISOString() },
		});
	} catch (err) {
		console.error('R2 put failed:', err);
		return jsonError('Storage unavailable', 503);
	}

	try {
		await env.DB
			.prepare(`
        INSERT INTO images (id, source_url, created_at)
        VALUES (?, ?, datetime('now'))
      `)
			.bind(imageId, sourceUrl)
			.run();
	} catch (err) {
		console.error('D1 insert failed — rolling back R2:', err);
		env.IMAGES.delete(imageId).catch(e => console.error('R2 rollback failed:', e));
		return jsonError('Database unavailable', 503);
	}

	return withCors(Response.json(
		{ imageId, url: `/images/${imageId}`, message: 'Image uploaded — alt-text will generate on first access' },
		{ status: 201 }
	));
}

// ─── SSRF protection ──────────────────────────────────────────────────────────
// Blocks requests to loopback, link-local, and RFC1918 private ranges before any
// outbound fetch is made. Cloudflare's infrastructure enforces similar restrictions
// at the network level; this check makes the policy explicit in application code.
function isSafeUrl(urlStr) {
	try {
		const { hostname } = new URL(urlStr);
		if (/^(localhost|127\.|0\.0\.0\.0|::1)/i.test(hostname))  return false; // loopback
		if (/^169\.254\./i.test(hostname))                          return false; // link-local / cloud metadata
		if (/^10\./i.test(hostname))                                 return false; // RFC1918 class A
		if (/^172\.(1[6-9]|2\d|3[01])\./i.test(hostname))          return false; // RFC1918 class B
		if (/^192\.168\./i.test(hostname))                          return false; // RFC1918 class C
		return true;
	} catch {
		return false;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonError(message, status) {
	return Response.json({ error: message }, { status });
}
