# NAS Mail Backend (Phase 4 — Custom UI Path)

Optional Node.js IMAP/SMTP REST proxy that runs on the **Synology NAS itself** (Docker), letting the groupware speak to MailPlus through HTTP rather than embedding the MailPlus webmail UI.

> If you just want a fast-working external mail screen, use the **iframe embed** option in `index.html` (set `MAILPLUS_URL`). Iframe gives you full mail features instantly. Use this folder only when you want the groupware's own minimal UI to handle external mail too.

```
Browser → Groupware UI ──HTTPS──▶ this Node container (on NAS) ──IMAP/SMTP──▶ MailPlus
```

## What this would do

REST endpoints to wrap IMAP (read) and SMTP (send):

```
GET    /mail/inbox?limit=50
GET    /mail/message/:uid
POST   /mail/send                  { to, subject, body, attachments }
DELETE /mail/message/:uid
```

## Skeleton (not yet implemented)

Suggested stack:
- **Node 20** + **Fastify**
- **node-imap** or **imapflow** for reading
- **nodemailer** for sending (sends through MailPlus SMTP on `localhost:587`)
- **JWT** validated against the API Worker's secret (shared)
- Runs in **Synology Container Manager** (Docker)

## Why not Cloudflare Worker?

IMAP and SMTP are TCP protocols. Cloudflare Workers only speak HTTP/S — they cannot open raw TCP to ports 143/587/993. So this piece must run somewhere that allows outbound IMAP/SMTP — the NAS itself is the natural place.

## Deployment plan (when ready)

1. Build a Docker image with the Fastify app
2. Push to Docker Hub (or load locally on NAS)
3. Synology Container Manager → create container, port 3000 → 3000
4. Reverse proxy: DSM → Login Portal → Application Portal → Reverse Proxy
   - Source: `mail-api.jdgd.co.kr:443`
   - Destination: `localhost:3000`
   - HTTPS via Let's Encrypt
5. Frontend `index.html` sets `MAIL_API_BASE = "https://mail-api.jdgd.co.kr"`

For now, **start with the iframe embed** below.
