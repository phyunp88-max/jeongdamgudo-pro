/**
 * JEONGDAMGUDO Mail Proxy
 * --------------------------------------------------------------
 * Fastify HTTP server that wraps IMAP / SMTP for the groupware
 * frontend. Stateless — each request carries the user's mail
 * credentials in headers (X-Mail-User / X-Mail-Pass over HTTPS).
 *
 * Designed to run as a Docker container on the Synology NAS.
 *
 * Required env vars:
 *   IMAP_HOST          (e.g. imap.ecounterp.com)
 *   IMAP_PORT          (default 993)
 *   SMTP_HOST          (e.g. smtp.ecounterp.com)
 *   SMTP_PORT          (default 587)
 *
 * Optional:
 *   PORT               (default 3000)
 *   ALLOWED_ORIGIN     (CORS, default '*')
 *   IMAP_TLS           ('strict' / 'lax', default 'strict')
 *   SMTP_TLS           ('strict' / 'lax', default 'strict')
 *
 * REST endpoints:
 *   GET    /health
 *   POST   /mail/login                     verify creds only
 *   GET    /mail/folders                   list IMAP folders
 *   GET    /mail/inbox?folder=&limit=&offset=
 *   GET    /mail/message/:uid?folder=
 *   POST   /mail/send                      { to, cc, bcc, subject, body, html }
 *   PATCH  /mail/message/:uid/read?folder=
 *   DELETE /mail/message/:uid?folder=
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

const PORT = parseInt(process.env.PORT || '3000');
const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const IMAP_TLS = process.env.IMAP_TLS || 'strict';
const SMTP_TLS = process.env.SMTP_TLS || 'strict';

if (!IMAP_HOST || !SMTP_HOST) {
  console.error('FATAL: IMAP_HOST and SMTP_HOST env vars are required.');
  process.exit(1);
}

const fastify = Fastify({ logger: { level: 'info' } });

await fastify.register(cors, {
  origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(','),
  credentials: false,
  exposedHeaders: ['Content-Disposition'],
});

/* ----------------------------- helpers ----------------------------- */

function getCreds(req) {
  const user = req.headers['x-mail-user'];
  const pass = req.headers['x-mail-pass'];
  if (!user || !pass) {
    const e = new Error('missing X-Mail-User / X-Mail-Pass headers');
    e.statusCode = 401;
    throw e;
  }
  return { user: String(user), pass: String(pass) };
}

async function withImap(creds, fn) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_PORT === 993,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    tls: IMAP_TLS === 'lax' ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

function makeTransport(creds) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: creds.user, pass: creds.pass },
    tls: SMTP_TLS === 'lax' ? { rejectUnauthorized: false } : undefined,
  });
}

function summarizeFlags(flags) {
  if (!flags) return [];
  return Array.from(flags);
}

/* ----------------------------- routes ----------------------------- */

fastify.get('/health', async () => ({
  ok: true,
  imap: `${IMAP_HOST}:${IMAP_PORT}`,
  smtp: `${SMTP_HOST}:${SMTP_PORT}`,
  time: new Date().toISOString(),
}));

// Verify credentials by attempting an IMAP connect
fastify.post('/mail/login', async (req, reply) => {
  const creds = getCreds(req);
  try {
    await withImap(creds, async () => {});
    return { ok: true, user: creds.user };
  } catch (e) {
    reply.code(401);
    return { error: 'login failed: ' + (e.message || 'unknown') };
  }
});

// List folders
fastify.get('/mail/folders', async (req) => {
  const creds = getCreds(req);
  return withImap(creds, async (client) => {
    const list = await client.list();
    return {
      folders: list.map(f => ({
        path: f.path,
        name: f.name,
        delimiter: f.delimiter,
        flags: Array.from(f.flags || []),
        specialUse: f.specialUse || null,
      })),
    };
  });
});

// Inbox (or any folder) listing
fastify.get('/mail/inbox', async (req) => {
  const creds = getCreds(req);
  const folder = String(req.query.folder || 'INBOX');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const status = await client.status(folder, { messages: true, unseen: true });
      const total = status.messages || 0;
      const unseen = status.unseen || 0;
      if (total === 0) return { messages: [], total: 0, unseen: 0, folder };

      const end = total - offset;
      const start = Math.max(1, end - limit + 1);
      if (start > end) return { messages: [], total, unseen, folder };

      const range = `${start}:${end}`;
      const out = [];
      for await (const msg of client.fetch(range, {
        envelope: true,
        flags: true,
        size: true,
        uid: true,
      })) {
        const env = msg.envelope || {};
        out.push({
          uid: msg.uid,
          seq: msg.seq,
          flags: summarizeFlags(msg.flags),
          unread: !(msg.flags && msg.flags.has && msg.flags.has('\\Seen')),
          size: msg.size,
          subject: env.subject || '(no subject)',
          from: env.from?.[0] ? { name: env.from[0].name || '', address: env.from[0].address || '' } : null,
          to: (env.to || []).map(t => ({ name: t.name || '', address: t.address || '' })),
          date: env.date ? new Date(env.date).toISOString() : null,
          messageId: env.messageId || null,
        });
      }
      out.reverse(); // newest first
      return { messages: out, total, unseen, folder };
    } finally {
      lock.release();
    }
  });
});

// Full message body
fastify.get('/mail/message/:uid', async (req, reply) => {
  const creds = getCreds(req);
  const uid = parseInt(req.params.uid);
  const folder = String(req.query.folder || 'INBOX');
  if (!uid) { reply.code(400); return { error: 'invalid uid' }; }

  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const dl = await client.download(uid, undefined, { uid: true });
      if (!dl?.content) { reply.code(404); return { error: 'not found' }; }

      const chunks = [];
      for await (const c of dl.content) chunks.push(c);
      const raw = Buffer.concat(chunks);

      const parsed = await simpleParser(raw);

      // Mark seen
      try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}

      return {
        uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.value?.[0] || null,
        to: (parsed.to?.value || []).map(t => ({ name: t.name || '', address: t.address || '' })),
        cc: (parsed.cc?.value || []).map(t => ({ name: t.name || '', address: t.address || '' })),
        date: parsed.date ? new Date(parsed.date).toISOString() : null,
        text: parsed.text || '',
        html: parsed.html || null,
        attachments: (parsed.attachments || []).map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
          contentId: a.contentId,
          checksum: a.checksum,
        })),
      };
    } finally {
      lock.release();
    }
  });
});

// Send mail
fastify.post('/mail/send', async (req, reply) => {
  const creds = getCreds(req);
  const { to, cc, bcc, subject, body, html, replyTo } = req.body || {};
  if (!to || !subject) { reply.code(400); return { error: 'to and subject required' }; }

  const transport = makeTransport(creds);
  try {
    const info = await transport.sendMail({
      from: creds.user,
      to: Array.isArray(to) ? to.join(', ') : to,
      cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
      bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
      replyTo: replyTo || undefined,
      subject,
      text: body || '',
      html: html || undefined,
    });
    return { ok: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transport.close();
  }
});

// Mark read
fastify.patch('/mail/message/:uid/read', async (req, reply) => {
  const creds = getCreds(req);
  const uid = parseInt(req.params.uid);
  const folder = String(req.query.folder || 'INBOX');
  if (!uid) { reply.code(400); return { error: 'invalid uid' }; }
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
});

// Delete (move to Trash if available, else flag-delete)
fastify.delete('/mail/message/:uid', async (req, reply) => {
  const creds = getCreds(req);
  const uid = parseInt(req.params.uid);
  const folder = String(req.query.folder || 'INBOX');
  if (!uid) { reply.code(400); return { error: 'invalid uid' }; }
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      // Find a trash folder
      const list = await client.list();
      const trash = list.find(f => /trash|deleted|휴지통/i.test(f.path) || f.specialUse === '\\Trash');
      if (trash && trash.path !== folder) {
        await client.messageMove(uid, trash.path, { uid: true });
      } else {
        await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
        await client.expunge();
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  });
});

/* ----------------------------- error & start ----------------------------- */

fastify.setErrorHandler((error, _req, reply) => {
  fastify.log.error(error);
  reply.code(error.statusCode || 500).send({
    error: error.message || 'internal error',
  });
});

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`✓ JEONGDAMGUDO mail proxy on :${PORT}  IMAP=${IMAP_HOST}:${IMAP_PORT}  SMTP=${SMTP_HOST}:${SMTP_PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
