# JEONGDAMGUDO Mail Proxy

Stateless Node.js HTTP proxy that lets the JEONGDAMGUDO frontend speak to **any IMAP/SMTP mail server** — including ECOUNT mail. Runs as a Docker container on the Synology NAS (or any host with outbound TCP to the mail server).

```
Browser ─HTTPS─▶ this container ─IMAP/SMTP─▶ ECOUNT mail server
```

## Why this exists
Cloudflare Workers can't open raw TCP, so IMAP/SMTP must be wrapped in HTTP somewhere. The cleanest place is the NAS: low cost, on-prem, can also serve `mail-api.jdgd.co.kr` via DSM Reverse Proxy.

## Endpoints

All endpoints (except `/health`) require headers:
- `X-Mail-User: <imap username, usually email>`
- `X-Mail-Pass: <imap password>`

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Status |
| POST | `/mail/login` | Verify creds (no payload) |
| GET | `/mail/folders` | IMAP folder tree |
| GET | `/mail/inbox?folder=INBOX&limit=50&offset=0` | Message list |
| GET | `/mail/message/:uid?folder=INBOX` | Full parsed body + attachments |
| POST | `/mail/send` | `{ to, cc?, bcc?, subject, body, html?, replyTo? }` |
| PATCH | `/mail/message/:uid/read?folder=INBOX` | Mark seen |
| DELETE | `/mail/message/:uid?folder=INBOX` | Move to Trash (or flag-delete) |

The proxy is **stateless** — credentials are passed per request, never stored. Each call opens a fresh IMAP/SMTP session and closes it.

## Running locally

```bash
cd nas-mail
cp .env.example .env             # edit IMAP/SMTP host etc.
npm install
node --env-file .env src/server.js
# → http://localhost:3000/health
```

Smoke test:
```bash
curl -X POST http://localhost:3000/mail/login \
  -H "X-Mail-User: you@jdgd.co.kr" \
  -H "X-Mail-Pass: yourpass"
```

## Deploying on Synology NAS (Container Manager)

### 1. Push code to NAS
- DSM → File Station → upload the `nas-mail/` folder, e.g. to `/docker/jdgd-mail`

### 2. Build & run via Container Manager
- DSM → Container Manager → **Project** → Create
- Path: `/docker/jdgd-mail`
- Source: **docker-compose.yml**
- Environment file: paste from `.env.example`, fill in real values
- Build & start

The container exposes `:3000` on the NAS LAN.

### 3. Reverse proxy + HTTPS
DSM → **Login Portal → Application Portal → Reverse Proxy → Create**:
- Source: `mail-api.jdgd.co.kr` · HTTPS · Port 443
- Destination: `localhost` · HTTP · Port 3000
- (Custom header — Recommended) **WebSocket** off
- Certificate: Let's Encrypt for `mail-api.jdgd.co.kr`

DNS:
- `A` record for `mail-api.jdgd.co.kr` → NAS public IP (or DDNS CNAME)

### 4. Lock down
- DSM → 보안 → 방화벽: 3000 포트는 LAN 내부만, 443은 모두 허용
- ALLOWED_ORIGIN in `.env` to your Pages URL only — kills cross-site abuse

### 5. Wire to JEONGDAMGUDO

In project root `index.html`:
```js
const MAIL_API_BASE = "https://mail-api.jdgd.co.kr";
```
Push, redeploy Pages. The Mail screen's "External" tab now talks to ECOUNT through this proxy.

## Configuration reference

| Env var | Default | Notes |
|---|---|---|
| `IMAP_HOST` | (required) | e.g. `imap.ecounterp.com` |
| `IMAP_PORT` | `993` | TLS implicit when 993 |
| `SMTP_HOST` | (required) | e.g. `smtp.ecounterp.com` |
| `SMTP_PORT` | `587` | TLS via STARTTLS |
| `PORT` | `3000` | container internal port |
| `ALLOWED_ORIGIN` | `*` | CORS — set to Pages URL |
| `IMAP_TLS` | `strict` | `lax` to skip cert verify (testing only) |
| `SMTP_TLS` | `strict` | same |

## ECOUNT specifics (verify with ECOUNT support)

Confirm with ECOUNT:
- Exact IMAP host (often `imap.ecounterp.com`) and port (993)
- Exact SMTP host and port (587 STARTTLS or 465 SSL)
- Whether **app-specific password** is required (some services force it; if so, each user generates one in ECOUNT settings)
- Whether 2FA is forced — if yes, app password is the workaround

## Security model

- **No credential storage on the proxy.** Frontend stores them in browser localStorage; user can wipe by signing out.
- **HTTPS-only** — never run this without TLS in front.
- **CORS lock** — only the groupware origin should be allowed.
- **Rate limiting** — consider adding `@fastify/rate-limit` for production.
- **Audit logging** — Fastify logs every request to stdout; pipe to NAS log volume if needed.

## Limits

- Message bodies are buffered in memory while parsing — keep individual mail size sane (most providers cap 25–50 MB).
- Streaming download for large attachments is not implemented; v1 returns parsed JSON. Add `/mail/attachment/:uid/:cid` later.
- Folder names with non-ASCII are returned as IMAP UTF-7; JEONGDAMGUDO handles display.

## Troubleshooting

- **`AUTHENTICATIONFAILED`** → wrong creds or app-specific password required
- **`ETIMEDOUT`** → NAS can't reach the mail server (firewall / VPN / DNS)
- **CORS blocked in browser** → set `ALLOWED_ORIGIN` correctly and rebuild container
- **TLS cert error** → use `IMAP_TLS=lax` to confirm, then fix the underlying cert issue

```bash
# Tail logs
docker compose logs -f mail-proxy
```
