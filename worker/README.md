# JEONGDAMGUDO — NAS Proxy Worker

Cloudflare Worker that bridges the JEONGDAMGUDO frontend (Cloudflare Pages) to a Synology NAS via the **File Station API**.

```
Browser  ──HTTPS──▶  Cloudflare Worker  ──HTTPS──▶  Synology NAS
                     (this folder)                  (DSM 7.x · File Station)
```

NAS credentials live only inside the Worker as secrets — they never reach the browser.

## Prerequisites on the NAS side

1. **External access** — DDNS / QuickConnect / public IP. The Worker runs on Cloudflare's edge, so the NAS must be reachable from the public internet.
2. **HTTPS with a valid certificate** — Let's Encrypt (DSM → Control Panel → Security → Certificate). Self-signed certs will fail the Worker's TLS verification.
3. **A dedicated DSM user** for the API (recommended, not your admin account). Give it read/write to a **shared folder** (e.g. `/jeongdamgudo`).
4. **2FA disabled for that user** — Cloudflare Worker can't pass an OTP.
5. **DSM → Control Panel → File Services → SMB**: not required for this. Just **File Station** package needs to be installed.

## Setup

### 1. Install Wrangler & log in

```bash
cd worker
npm install
npx wrangler login
```

### 2. Set Worker secrets

```bash
npx wrangler secret put NAS_URL          # e.g. https://your-nas.synology.me:5001
npx wrangler secret put NAS_USER         # DSM username for the dedicated account
npx wrangler secret put NAS_PASS         # DSM password
npx wrangler secret put API_KEY          # any random string; the frontend uses it
```

Optional: edit `wrangler.toml` to set:
- `NAS_BASE_PATH` — root folder on NAS (default `/jeongdamgudo`)
- `ALLOWED_ORIGIN` — e.g. `https://jeongdamgudo-pro.pages.dev` (lock CORS to your Pages domain)

### 3. Deploy

```bash
npx wrangler deploy
```

You'll get a URL like `https://jeongdamgudo-nas.YOURSUB.workers.dev`.

### 4. One-time folder setup

Create the category subfolders on the NAS:

```bash
curl -X POST https://jeongdamgudo-nas.YOURSUB.workers.dev/init \
     -H "X-API-Key: YOUR_API_KEY"
```

This creates `/jeongdamgudo/DRAWINGS`, `/SPECIFICATIONS`, `/MINUTES`, `/CONTRACTS`, `/OTHERS`.

### 5. Wire the frontend

In the project root `index.html`, find the `NAS_API_BASE` block near the top of the `<script>` and set:

```js
const NAS_API_BASE = "https://jeongdamgudo-nas.YOURSUB.workers.dev";
const NAS_API_KEY  = "YOUR_API_KEY";
```

Commit, push, redeploy Pages.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Status check (no auth) |
| GET | `/list?category=ALL` | List files (or by category) |
| POST | `/upload` | multipart: `file`, `category` |
| GET | `/download?path=<full-path>` | Stream a file to the browser |
| DELETE | `/delete?path=<full-path>` | Delete a file |
| POST | `/init` | Create category folders (idempotent) |

All endpoints (except `/health`) require `X-API-Key` header if `API_KEY` is set.

## Local development

```bash
npx wrangler dev
# Worker runs on http://localhost:8787
# Frontend can point NAS_API_BASE to http://localhost:8787 for testing
```

## Caveats

- Cloudflare Worker free plan: 100 MB request body, 10 ms CPU. Big CAD files near the limit may need a paid plan or direct browser → NAS upload via signed URL.
- The sid cache lives in-process (per Worker isolate). Cold isolates re-login transparently.
- DSM 7.2+ may require `version=7` for some APIs. If you hit unexpected errors, try bumping the `version` query parameter in `src/index.js`.
- If the NAS is on a non-standard port (e.g. 5001), include it in `NAS_URL`.
