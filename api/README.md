# JEONGDAMGUDO API Worker

Cloudflare Worker + D1 backend for the groupware. Provides authentication, users, departments, permissions, documents (metadata), internal messages, logs, and dashboard stats.

```
Browser ──HTTPS──▶ API Worker ──▶ D1 (SQLite)
                          │
                          └────▶ NAS Worker (file proxy, optional)
```

## Setup

### 1. Install & login
```bash
cd api
npm install
npx wrangler login
```

### 2. Create D1 database
```bash
npx wrangler d1 create jeongdamgudo-db
```
Copy the `database_id` from the output and paste into `wrangler.toml` under `[[d1_databases]]`.

### 3. Apply schema (local + remote)
```bash
npm run db:migrate           # local dev DB
npm run db:migrate:remote    # production D1
```

### 4. Set secrets
```bash
npx wrangler secret put JWT_SECRET     # paste a 64-char random string
npx wrangler secret put ADMIN_PASS     # initial admin password (used by /api/init only)
# Optional, only if you wired the NAS Worker:
npx wrangler secret put NAS_API_KEY
```

Generate a random JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 5. Deploy
```bash
npm run deploy
```
Note the URL it prints, e.g. `https://jeongdamgudo-api.YOURSUB.workers.dev`.

### 6. Bootstrap the first admin
One-time call (refuses if any admin already exists):
```bash
curl -X POST https://jeongdamgudo-api.YOURSUB.workers.dev/api/init
```
Returns `{ ok: true, id }`. Now login with username `admin` and the password you set in `ADMIN_PASS`.

### 7. Wire the frontend
In project-root `index.html`, set:
```js
const API_BASE = "https://jeongdamgudo-api.YOURSUB.workers.dev";
```
Re-deploy Pages. The login screen now talks to this Worker; users, depts, messages, etc. all sync centrally.

## Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/init` | none | Create first admin (one-shot) |
| POST | `/api/auth/login` | none | Returns `{ token, user }` |
| GET | `/api/auth/me` | yes | Current user + permissions |
| GET / POST / PATCH / DELETE | `/api/users[/:id]` | admin | Users CRUD |
| GET / POST / PATCH / DELETE | `/api/depts[/:id]` | admin (write) | Departments |
| GET / PATCH | `/api/permissions` | admin | Role × feature × op matrix |
| GET / POST | `/api/documents` | library r/w | List + register metadata |
| DELETE | `/api/documents/:id` | owner or library:d | Delete doc + NAS file |
| GET / POST | `/api/messages` | mail r/w | Inbox/sent + send |
| PATCH | `/api/messages/:id/read` | mail r | Mark read |
| DELETE | `/api/messages/:id` | mail r | Delete |
| GET | `/api/logs` | admin | Activity log |
| GET | `/api/stats` | yes | Counts for dashboard |

## Local development

```bash
npx wrangler dev
# Worker on http://localhost:8787, frontend can point API_BASE there
```

## Backups

D1 export to local SQLite file (run weekly via cron / GitHub Action):
```bash
npx wrangler d1 export jeongdamgudo-db --remote --output=backup-$(date +%Y%m%d).sql
```

## Security notes

- Passwords are PBKDF2-SHA256 (100k iterations, 16-byte salt) — production-grade.
- JWT HS256, 7-day expiry. Rotate `JWT_SECRET` to invalidate all tokens.
- Permission checks happen on every request server-side; client-side checks are UX only.
- Set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages URL once deployed.
