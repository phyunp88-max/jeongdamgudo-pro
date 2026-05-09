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

---
© 2026
