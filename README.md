# JEONGDAMGUDO · Groupware

靜談求道 — 사내 그룹웨어 프론트엔드 (Single-page, localStorage backed).

## Features
- **Sign-in** with role-based access
- **Mail** — Inbox / Sent / Drafts / Trash
- **Library** — Drawings · Specifications · Minutes · Contracts · Others
- **Admin** — Users · Roles · Departments · Logs · Overview

## Demo Accounts
| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Admin |
| `park`  | `park123`  | Manager |
| `kim`   | `kim123`   | Staff |
| `lee`   | `lee123`   | Manager |
| `choi`  | `choi123`  | Staff |
| `jung`  | `jung123`  | Staff (inactive) |

## Run Locally

Open `index.html` directly, or serve it:

```bash
python3 -m http.server 8080
# → http://localhost:8080
```

## Run on GitHub Codespaces

This repo includes `.devcontainer/devcontainer.json`. When you open the repo in Codespaces it will:
- Use Node 20 base image
- Auto-install Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Auto-start a static web server on port **8080** (Web Preview tab)
- Forward `ANTHROPIC_API_KEY` from your Codespaces Secrets

### Setting your API key for Claude Code in Codespaces
**GitHub → Settings → Codespaces → Secrets** → add `ANTHROPIC_API_KEY`. It will be injected into every codespace automatically.

## Reset Demo Data
In the browser console:
```js
localStorage.clear(); location.reload();
```

## Production Backend (Cloudflare Worker + D1)

For real multi-user use, the frontend can run against a centralized backend that stores users, departments, permissions, messages, and logs in Cloudflare D1 — see [`api/README.md`](api/README.md).

**To enable:**
1. Deploy the API Worker (see `api/README.md`)
2. Run `POST /api/init` once to create the first admin
3. In `index.html` set:
   ```js
   const API_BASE = 'https://jeongdamgudo-api.YOURSUB.workers.dev';
   ```
4. Commit & redeploy

The frontend then uses JWT auth and all data syncs across users in real time. Demo mode (API_BASE empty) keeps everything in localStorage.

## External Mail (Phase 4)

Two paths for connecting external mail (ECOUNT, Naver Works, MailPlus, etc.) to the groupware:

### A. iframe embed (fastest — for any provider that allows iframing)
```js
const MAILPLUS_URL = "https://mail.worksmobile.com/";
```
"External" tab embeds the full webmail UI.

### B. Custom UI via IMAP/SMTP proxy (works with ECOUNT and any IMAP server)
Deploy [`nas-mail/`](nas-mail/) as a Docker container on the NAS, then:
```js
const MAIL_API_BASE = "https://mail-api.jdgd.co.kr";
```
The "External" tab now uses the groupware's own minimal UI to read/send mail through the proxy. Each user sets their mail credentials once (browser-only, never stored on server).

## Synology NAS Integration (Library)

The Library section can be backed by a real Synology NAS instead of localStorage.

Architecture:
```
Browser → Cloudflare Worker (worker/) → Synology File Station API
```

NAS credentials live only inside the Worker as secrets — never in the browser.

**To enable:**
1. Deploy the Worker — see [`worker/README.md`](worker/README.md) for setup.
2. Edit `index.html` and set:
   ```js
   const NAS_API_BASE = 'https://jeongdamgudo-nas.YOURSUB.workers.dev';
   const NAS_API_KEY  = 'your-shared-secret';
   ```
3. Commit & redeploy. The Library will switch automatically — uploads pick a real file, downloads stream from the NAS, listings show real files.

Demo mode (NAS_API_BASE empty) keeps everything in localStorage as before.

---
© 2026
