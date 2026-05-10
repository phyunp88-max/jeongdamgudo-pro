/**
 * JEONGDAMGUDO Groupware — API Worker
 * Cloudflare Worker + D1 + JWT auth.
 *
 * Routes:
 *   POST   /api/init                    one-time bootstrap (creates first admin)
 *   POST   /api/auth/login              { username, password }   → { token, user }
 *   GET    /api/auth/me                                           → current user + perms
 *
 *   GET    /api/users                  (admin)
 *   POST   /api/users                  (admin)
 *   PATCH  /api/users/:id              (admin)
 *   DELETE /api/users/:id              (admin)
 *
 *   GET    /api/depts
 *   POST   /api/depts                  (admin)
 *   PATCH  /api/depts/:id              (admin)
 *   DELETE /api/depts/:id              (admin)
 *
 *   GET    /api/permissions            (admin)
 *   PATCH  /api/permissions            (admin)  body: [{role,feature,op,allowed}]
 *
 *   GET    /api/documents?category=ALL
 *   POST   /api/documents              (write)  metadata; file upload itself goes via NAS Worker
 *   DELETE /api/documents/:id          (delete)
 *
 *   GET    /api/messages?folder=inbox
 *   POST   /api/messages               { to_id, subject, body }
 *   PATCH  /api/messages/:id/read
 *   DELETE /api/messages/:id
 *
 *   GET    /api/logs                   (admin)
 *   GET    /api/stats                  (counts for dashboard)
 */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

const corsHeaders = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
});

/* ============================================================
   PASSWORD HASHING — PBKDF2 SHA-256
============================================================ */
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToHex(b) {
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i*2, 2), 16);
  return out;
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return bytesToHex(salt) + ':' + bytesToHex(bits);
}
async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex] = stored.split(':');
  const computed = await hashPassword(password, saltHex);
  return computed === stored;
}

/* ============================================================
   JWT — HS256, 7 day
============================================================ */
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64uStr = (s) => b64u(enc.encode(s));
const b64uDecode = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
};

async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + 7*24*3600 };
  const data = b64uStr(JSON.stringify(header)) + '.' + b64uStr(JSON.stringify(full));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + b64u(sig);
}

async function verifyJWT(token, secret) {
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['verify']
  );
  const sigBytes = Uint8Array.from(b64uDecode(s), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(h + '.' + p));
  if (!ok) return null;
  const payload = JSON.parse(b64uDecode(p));
  if (payload.exp && Math.floor(Date.now()/1000) > payload.exp) return null;
  return payload;
}

/* ============================================================
   AUTH HELPERS
============================================================ */
async function requireUser(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  const user = await env.DB.prepare(
    'SELECT id, username, name, email, phone, dept, role, status FROM users WHERE id = ?'
  ).bind(payload.uid).first();
  if (!user || user.status !== 'active') return null;
  return user;
}

async function loadPerms(env) {
  const rs = await env.DB.prepare('SELECT role, feature, op, allowed FROM permissions').all();
  const map = { admin: {}, manager: {}, staff: {} };
  for (const r of (rs.results || [])) {
    if (!map[r.role]) map[r.role] = {};
    if (!map[r.role][r.feature]) map[r.role][r.feature] = {};
    map[r.role][r.feature][r.op] = r.allowed ? 1 : 0;
  }
  return map;
}

function checkPerm(perms, role, feature, op) {
  return !!(perms[role] && perms[role][feature] && perms[role][feature][op]);
}

async function logEvent(env, user, action, kind, detail) {
  await env.DB.prepare(
    'INSERT INTO logs (user_id, username, action, kind, detail) VALUES (?, ?, ?, ?, ?)'
  ).bind(user?.id || null, user?.username || 'system', action, kind, detail || null).run();
}

/* ============================================================
   ROUTES
============================================================ */
async function handleInit(req, env) {
  // One-time bootstrap. Creates first admin user if none exist.
  const adminExists = await env.DB.prepare(
    "SELECT id FROM users WHERE role='admin' LIMIT 1"
  ).first();
  if (adminExists) return json({ error: 'already initialized' }, 409);
  if (!env.ADMIN_PASS) return json({ error: 'ADMIN_PASS secret not set' }, 500);
  const hash = await hashPassword(env.ADMIN_PASS);
  const r = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role, dept, status)
     VALUES ('admin', ?, '관리자', 'admin', 'Admin Team', 'active') RETURNING id`
  ).bind(hash).first();
  return json({ ok: true, message: 'Initial admin created', id: r.id });
}

async function handleLogin(req, env) {
  const body = await req.json().catch(() => ({}));
  const { username, password } = body || {};
  if (!username || !password) return json({ error: 'missing fields' }, 400);
  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE username = ?'
  ).bind(username).first();
  if (!user) return json({ error: 'invalid credentials' }, 401);
  if (user.status !== 'active') return json({ error: 'account inactive' }, 403);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return json({ error: 'invalid credentials' }, 401);
  const token = await signJWT({ uid: user.id, role: user.role }, env.JWT_SECRET);
  await env.DB.prepare(
    "UPDATE users SET last_login = datetime('now') WHERE id = ?"
  ).bind(user.id).run();
  await logEvent(env, user, '시스템 로그인', 'login');
  delete user.password_hash;
  return json({ token, user });
}

async function handleMe(req, env, user) {
  const perms = await loadPerms(env);
  return json({ user, perms });
}

/* ----- USERS ----- */
async function handleUsersList(env) {
  const rs = await env.DB.prepare(
    'SELECT id, username, name, email, phone, dept, role, status, created_at, last_login FROM users ORDER BY id'
  ).all();
  return json({ users: rs.results || [] });
}
async function handleUserCreate(req, env, actor) {
  const body = await req.json();
  const { username, password, name, email, phone, dept, role, status } = body;
  if (!username || !name || !password || !role) return json({ error: 'missing fields' }, 400);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE username=?').bind(username).first();
  if (exists) return json({ error: 'username taken' }, 409);
  const hash = await hashPassword(password);
  const r = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, email, phone, dept, role, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(username, hash, name, email||null, phone||null, dept||null, role, status||'active').first();
  await logEvent(env, actor, `계정 생성 — ${username}`, 'write');
  return json({ ok: true, id: r.id });
}
async function handleUserUpdate(req, env, actor, id) {
  const body = await req.json();
  const fields = ['name','email','phone','dept','role','status'];
  const sets = [], vals = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(body[f]); }
  }
  if (body.password) {
    sets.push('password_hash=?'); vals.push(await hashPassword(body.password));
  }
  if (sets.length === 0) return json({ error: 'nothing to update' }, 400);
  vals.push(id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  await logEvent(env, actor, `계정 수정 — id=${id}`, 'write');
  return json({ ok: true });
}
async function handleUserDelete(env, actor, id) {
  if (id === actor.id) return json({ error: 'cannot delete self' }, 400);
  const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(id).first();
  await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run();
  await logEvent(env, actor, `계정 삭제 — ${u?.username || id}`, 'delete');
  return json({ ok: true });
}

/* ----- DEPTS ----- */
async function handleDeptsList(env) {
  const rs = await env.DB.prepare('SELECT * FROM depts ORDER BY id').all();
  return json({ depts: rs.results || [] });
}
async function handleDeptCreate(req, env, actor) {
  const { name, code, description } = await req.json();
  if (!name) return json({ error: 'name required' }, 400);
  const r = await env.DB.prepare(
    'INSERT INTO depts (name, code, description) VALUES (?, ?, ?) RETURNING id'
  ).bind(name, code||null, description||null).first();
  await logEvent(env, actor, `부서 생성 — ${name}`, 'write');
  return json({ ok: true, id: r.id });
}
async function handleDeptUpdate(req, env, actor, id) {
  const body = await req.json();
  const fields = ['name','code','description'];
  const sets = [], vals = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(body[f]); }
  }
  if (sets.length === 0) return json({ error: 'nothing to update' }, 400);
  // If renaming, sync users.dept
  if (body.name) {
    const old = await env.DB.prepare('SELECT name FROM depts WHERE id=?').bind(id).first();
    if (old && old.name !== body.name) {
      await env.DB.prepare('UPDATE users SET dept=? WHERE dept=?').bind(body.name, old.name).run();
    }
  }
  vals.push(id);
  await env.DB.prepare(`UPDATE depts SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  await logEvent(env, actor, `부서 수정 — id=${id}`, 'write');
  return json({ ok: true });
}
async function handleDeptDelete(env, actor, id) {
  const d = await env.DB.prepare('SELECT name FROM depts WHERE id=?').bind(id).first();
  if (!d) return json({ error: 'not found' }, 404);
  const c = await env.DB.prepare('SELECT COUNT(*) as n FROM users WHERE dept=?').bind(d.name).first();
  if (c.n > 0) return json({ error: `still ${c.n} members` }, 400);
  await env.DB.prepare('DELETE FROM depts WHERE id=?').bind(id).run();
  await logEvent(env, actor, `부서 삭제 — ${d.name}`, 'delete');
  return json({ ok: true });
}

/* ----- PERMISSIONS ----- */
async function handlePermsList(env) {
  const perms = await loadPerms(env);
  return json({ perms });
}
async function handlePermsUpdate(req, env, actor) {
  const updates = await req.json(); // [{role, feature, op, allowed}]
  if (!Array.isArray(updates)) return json({ error: 'array required' }, 400);
  const stmts = updates.map(u =>
    env.DB.prepare(
      `INSERT INTO permissions (role, feature, op, allowed) VALUES (?, ?, ?, ?)
       ON CONFLICT(role, feature, op) DO UPDATE SET allowed=excluded.allowed`
    ).bind(u.role, u.feature, u.op, u.allowed ? 1 : 0)
  );
  await env.DB.batch(stmts);
  await logEvent(env, actor, `권한 변경 (${updates.length}건)`, 'write');
  return json({ ok: true });
}

/* ----- DOCUMENTS (metadata) ----- */
async function handleDocsList(req, env) {
  const url = new URL(req.url);
  const cat = url.searchParams.get('category') || 'ALL';
  const where = cat === 'ALL' ? '' : 'WHERE category = ?';
  const stmt = env.DB.prepare(`SELECT * FROM documents ${where} ORDER BY created_at DESC`);
  const rs = await (cat === 'ALL' ? stmt.all() : stmt.bind(cat).all());
  const docs = (rs.results || []).map(d => ({
    ...d,
    tags: d.tags ? JSON.parse(d.tags) : [],
  }));
  return json({ docs });
}
async function handleDocCreate(req, env, actor) {
  const body = await req.json();
  const { name, category, nas_path, size, tags } = body;
  if (!name || !category) return json({ error: 'name and category required' }, 400);
  const r = await env.DB.prepare(
    `INSERT INTO documents (name, category, nas_path, size, owner_id, owner_name, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    name, category, nas_path || null, size || null,
    actor.id, actor.name, JSON.stringify(tags || [])
  ).first();
  await logEvent(env, actor, `자료 등록 — ${name}`, 'write');
  return json({ ok: true, id: r.id });
}
async function handleDocDelete(req, env, actor, id) {
  const d = await env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(id).first();
  if (!d) return json({ error: 'not found' }, 404);
  // Optionally also delete on NAS via NAS_WORKER_URL
  if (env.NAS_WORKER_URL && d.nas_path) {
    try {
      const headers = {};
      if (env.NAS_API_KEY) headers['X-API-Key'] = env.NAS_API_KEY;
      await fetch(`${env.NAS_WORKER_URL}/delete?path=${encodeURIComponent(d.nas_path)}`, {
        method: 'DELETE', headers
      });
    } catch (e) { /* ignore — DB delete proceeds */ }
  }
  await env.DB.prepare('DELETE FROM documents WHERE id=?').bind(id).run();
  await logEvent(env, actor, `자료 삭제 — ${d.name}`, 'delete');
  return json({ ok: true });
}

/* ----- MESSAGES ----- */
async function handleMsgList(req, env, user) {
  const url = new URL(req.url);
  const folder = url.searchParams.get('folder') || 'inbox';
  let stmt;
  if (folder === 'inbox') {
    stmt = env.DB.prepare(
      `SELECT m.*, u.name as from_name, u.dept as from_dept
       FROM messages m LEFT JOIN users u ON m.from_id = u.id
       WHERE m.to_id = ? AND m.folder = 'inbox' ORDER BY m.created_at DESC`
    ).bind(user.id);
  } else if (folder === 'sent') {
    stmt = env.DB.prepare(
      `SELECT m.*, u.name as to_name, u.dept as to_dept
       FROM messages m LEFT JOIN users u ON m.to_id = u.id
       WHERE m.from_id = ? AND m.folder = 'sent' ORDER BY m.created_at DESC`
    ).bind(user.id);
  } else {
    return json({ messages: [] });
  }
  const rs = await stmt.all();
  return json({ messages: rs.results || [] });
}
async function handleMsgCreate(req, env, actor) {
  const { to_id, to_username, subject, body, tag } = await req.json();
  if (!subject) return json({ error: 'subject required' }, 400);
  let toId = to_id;
  if (!toId && to_username) {
    const t = await env.DB.prepare('SELECT id FROM users WHERE username=?').bind(to_username).first();
    if (!t) return json({ error: 'recipient not found' }, 404);
    toId = t.id;
  }
  // Insert into recipient's inbox
  if (toId) {
    await env.DB.prepare(
      `INSERT INTO messages (from_id, to_id, subject, body, tag, folder)
       VALUES (?, ?, ?, ?, ?, 'inbox')`
    ).bind(actor.id, toId, subject, body || '', tag || actor.dept || null).run();
  }
  // Also save in sender's sent
  await env.DB.prepare(
    `INSERT INTO messages (from_id, to_id, subject, body, tag, folder)
     VALUES (?, ?, ?, ?, ?, 'sent')`
  ).bind(actor.id, toId || null, subject, body || '', tag || actor.dept || null).run();
  await logEvent(env, actor, `메일 발송 — ${subject}`, 'write');
  return json({ ok: true });
}
async function handleMsgRead(env, actor, id) {
  await env.DB.prepare(
    `UPDATE messages SET read_at = datetime('now') WHERE id = ? AND to_id = ? AND read_at IS NULL`
  ).bind(id, actor.id).run();
  return json({ ok: true });
}
async function handleMsgDelete(env, actor, id) {
  await env.DB.prepare(
    `DELETE FROM messages WHERE id = ? AND (to_id = ? OR from_id = ?)`
  ).bind(id, actor.id, actor.id).run();
  return json({ ok: true });
}

/* ----- LOGS ----- */
async function handleLogsList(req, env) {
  const url = new URL(req.url);
  const limit = Math.min(+url.searchParams.get('limit') || 80, 200);
  const rs = await env.DB.prepare(
    'SELECT * FROM logs ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();
  return json({ logs: rs.results || [] });
}

/* ----- STATS ----- */
async function handleStats(env, user) {
  const [u, d, m, l] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE status='active'").first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM documents').first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM messages WHERE to_id=? AND folder='inbox' AND read_at IS NULL").bind(user.id).first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM logs').first(),
  ]);
  return json({
    activeUsers: u.n,
    documents: d.n,
    newMail: m.n,
    logs: l.n,
  });
}

/* ============================================================
   ROUTER
============================================================ */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = corsHeaders(env);

    if (req.method === 'OPTIONS') return new Response(null, { headers });

    try {
      const p = url.pathname;
      const m = req.method;
      const rsp = (r) => {
        // Add CORS headers to every response
        const merged = new Headers(r.headers);
        for (const [k, v] of Object.entries(headers)) merged.set(k, v);
        return new Response(r.body, { status: r.status, headers: merged });
      };

      // Public endpoints
      if (p === '/api/init' && m === 'POST') return rsp(await handleInit(req, env));
      if (p === '/api/auth/login' && m === 'POST') return rsp(await handleLogin(req, env));
      if (p === '/api/health' && m === 'GET') return rsp(json({ ok: true }));

      // Authenticated below
      const user = await requireUser(req, env);
      if (!user) return rsp(json({ error: 'unauthorized' }, 401));
      const perms = await loadPerms(env);
      const can = (f, o) => checkPerm(perms, user.role, f, o);

      if (p === '/api/auth/me' && m === 'GET') return rsp(await handleMe(req, env, user));

      // USERS (admin)
      if (p === '/api/users' && m === 'GET') {
        if (!can('admin', 'r')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleUsersList(env));
      }
      if (p === '/api/users' && m === 'POST') {
        if (!can('admin', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleUserCreate(req, env, user));
      }
      const userIdMatch = p.match(/^\/api\/users\/(\d+)$/);
      if (userIdMatch) {
        if (!can('admin', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        const id = +userIdMatch[1];
        if (m === 'PATCH') return rsp(await handleUserUpdate(req, env, user, id));
        if (m === 'DELETE') return rsp(await handleUserDelete(env, user, id));
      }

      // DEPTS
      if (p === '/api/depts' && m === 'GET') return rsp(await handleDeptsList(env));
      if (p === '/api/depts' && m === 'POST') {
        if (!can('admin', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleDeptCreate(req, env, user));
      }
      const deptIdMatch = p.match(/^\/api\/depts\/(\d+)$/);
      if (deptIdMatch) {
        if (!can('admin', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        const id = +deptIdMatch[1];
        if (m === 'PATCH') return rsp(await handleDeptUpdate(req, env, user, id));
        if (m === 'DELETE') return rsp(await handleDeptDelete(env, user, id));
      }

      // PERMISSIONS (admin)
      if (p === '/api/permissions' && m === 'GET') return rsp(await handlePermsList(env));
      if (p === '/api/permissions' && m === 'PATCH') {
        if (!can('admin', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handlePermsUpdate(req, env, user));
      }

      // DOCUMENTS
      if (p === '/api/documents' && m === 'GET') {
        if (!can('library', 'r')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleDocsList(req, env));
      }
      if (p === '/api/documents' && m === 'POST') {
        if (!can('library', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleDocCreate(req, env, user));
      }
      const docIdMatch = p.match(/^\/api\/documents\/(\d+)$/);
      if (docIdMatch) {
        const id = +docIdMatch[1];
        if (m === 'DELETE') {
          // owners can delete their own; admins/perm-d can delete anything
          const d = await env.DB.prepare('SELECT owner_id FROM documents WHERE id=?').bind(id).first();
          const allow = can('library', 'd') || (d && d.owner_id === user.id);
          if (!allow) return rsp(json({ error: 'forbidden' }, 403));
          return rsp(await handleDocDelete(req, env, user, id));
        }
      }

      // MESSAGES
      if (p === '/api/messages' && m === 'GET') {
        if (!can('mail', 'r')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleMsgList(req, env, user));
      }
      if (p === '/api/messages' && m === 'POST') {
        if (!can('mail', 'w')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleMsgCreate(req, env, user));
      }
      const msgIdMatch = p.match(/^\/api\/messages\/(\d+)(?:\/(\w+))?$/);
      if (msgIdMatch) {
        const id = +msgIdMatch[1];
        const sub = msgIdMatch[2];
        if (m === 'PATCH' && sub === 'read') return rsp(await handleMsgRead(env, user, id));
        if (m === 'DELETE') return rsp(await handleMsgDelete(env, user, id));
      }

      // LOGS (admin)
      if (p === '/api/logs' && m === 'GET') {
        if (!can('admin', 'r')) return rsp(json({ error: 'forbidden' }, 403));
        return rsp(await handleLogsList(req, env));
      }

      // STATS
      if (p === '/api/stats' && m === 'GET') return rsp(await handleStats(env, user));

      return rsp(json({ error: 'not found', path: p }, 404));
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: e.message || 'internal' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
