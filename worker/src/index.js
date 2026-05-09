/**
 * JEONGDAMGUDO — Synology NAS Proxy Worker
 *
 * Browser → this Worker → Synology File Station API
 *
 * Required Worker secrets (set with `wrangler secret put <NAME>`):
 *   NAS_URL          e.g. https://your-nas.synology.me:5001
 *   NAS_USER         DSM account name
 *   NAS_PASS         DSM account password
 *   NAS_BASE_PATH    e.g. /jeongdamgudo  (DSM shared folder + sub path)
 *   ALLOWED_ORIGIN   e.g. https://jeongdamgudo-pro.pages.dev
 *   API_KEY          (optional) shared secret the frontend sends as X-API-Key
 *
 * Endpoints:
 *   GET    /list?folder=/path                → list files in folder
 *   POST   /upload   (multipart: file, path) → upload a file
 *   GET    /download?path=/path/to/file      → stream file to browser
 *   DELETE /delete?path=/path/to/file        → delete a file
 *   GET    /health                           → quick status check
 */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const CATEGORIES = ["DRAWINGS", "SPECIFICATIONS", "MINUTES", "CONTRACTS", "OTHERS"];

/* In-memory sid cache (best-effort; isolate-scoped) */
let cachedSid = null;
let cachedSidExp = 0;

async function login(env) {
  if (cachedSid && Date.now() < cachedSidExp) return cachedSid;
  const url =
    `${env.NAS_URL}/webapi/auth.cgi?` +
    new URLSearchParams({
      api: "SYNO.API.Auth",
      version: "6",
      method: "login",
      account: env.NAS_USER,
      passwd: env.NAS_PASS,
      session: "FileStation",
      format: "sid",
    });
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  const j = await r.json();
  if (!j.success) {
    throw new Error("NAS login failed: " + JSON.stringify(j.error || j));
  }
  cachedSid = j.data.sid;
  cachedSidExp = Date.now() + 9 * 60 * 1000; // 9 min
  return cachedSid;
}

async function nasGet(env, params) {
  const sid = await login(env);
  const url =
    `${env.NAS_URL}/webapi/entry.cgi?` +
    new URLSearchParams({ ...params, _sid: sid });
  const r = await fetch(url);
  return r.json();
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function checkAuth(req, env) {
  if (!env.API_KEY) return true; // optional
  return req.headers.get("X-API-Key") === env.API_KEY;
}

async function ensureCategoryFolders(env) {
  // Create /<base>/<CATEGORY> folders if missing. Idempotent.
  const sid = await login(env);
  for (const cat of CATEGORIES) {
    const url =
      `${env.NAS_URL}/webapi/entry.cgi?` +
      new URLSearchParams({
        api: "SYNO.FileStation.CreateFolder",
        version: "2",
        method: "create",
        folder_path: `["${env.NAS_BASE_PATH}"]`,
        name: `["${cat}"]`,
        force_parent: "true",
        _sid: sid,
      });
    await fetch(url).then((r) => r.json()).catch(() => {});
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = cors(env);

    if (req.method === "OPTIONS") return new Response(null, { headers });

    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() }, 200, headers);
    }

    if (!checkAuth(req, env)) {
      return json({ error: "unauthorized" }, 401, headers);
    }

    if (!env.NAS_URL || !env.NAS_USER || !env.NAS_PASS) {
      return json(
        { error: "Worker secrets NAS_URL/NAS_USER/NAS_PASS not configured" },
        500,
        headers,
      );
    }

    const base = env.NAS_BASE_PATH || "/jeongdamgudo";

    try {
      /* ========== LIST ========== */
      if (url.pathname === "/list" && req.method === "GET") {
        const cat = url.searchParams.get("category"); // ALL or one of CATEGORIES
        const folders = cat && cat !== "ALL" ? [cat] : CATEGORIES;

        const out = [];
        for (const f of folders) {
          const folderPath = `${base}/${f}`;
          const j = await nasGet(env, {
            api: "SYNO.FileStation.List",
            version: "2",
            method: "list",
            folder_path: `"${folderPath}"`,
            additional: '["size","time","type"]',
          });
          if (j.success && j.data?.files) {
            for (const file of j.data.files) {
              if (file.isdir) continue;
              out.push({
                name: file.name,
                path: file.path,
                category: f,
                size: file.additional?.size || 0,
                mtime: file.additional?.time?.mtime || 0,
              });
            }
          }
        }
        out.sort((a, b) => b.mtime - a.mtime);
        return json({ files: out }, 200, headers);
      }

      /* ========== UPLOAD ========== */
      if (url.pathname === "/upload" && req.method === "POST") {
        const sid = await login(env);
        const inForm = await req.formData();
        const file = inForm.get("file");
        const category = (inForm.get("category") || "OTHERS").toString();
        if (!file || typeof file === "string") {
          return json({ error: "no file" }, 400, headers);
        }
        if (!CATEGORIES.includes(category)) {
          return json({ error: "invalid category" }, 400, headers);
        }
        const targetPath = `${base}/${category}`;

        // Make sure the target folder exists (no-op if already there)
        await fetch(
          `${env.NAS_URL}/webapi/entry.cgi?` +
            new URLSearchParams({
              api: "SYNO.FileStation.CreateFolder",
              version: "2",
              method: "create",
              folder_path: `["${base}"]`,
              name: `["${category}"]`,
              force_parent: "true",
              _sid: sid,
            }),
        ).catch(() => {});

        const out = new FormData();
        out.append("path", targetPath);
        out.append("create_parents", "true");
        out.append("overwrite", "overwrite");
        out.append("file", file, file.name);

        const r = await fetch(
          `${env.NAS_URL}/webapi/entry.cgi?` +
            new URLSearchParams({
              api: "SYNO.FileStation.Upload",
              version: "2",
              method: "upload",
              _sid: sid,
            }),
          { method: "POST", body: out },
        );
        const j = await r.json();
        return json(j, j.success ? 200 : 500, headers);
      }

      /* ========== DOWNLOAD ========== */
      if (url.pathname === "/download" && req.method === "GET") {
        const sid = await login(env);
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400, headers);
        const dlUrl =
          `${env.NAS_URL}/webapi/entry.cgi?` +
          new URLSearchParams({
            api: "SYNO.FileStation.Download",
            version: "2",
            method: "download",
            path: `"${path}"`,
            mode: "download",
            _sid: sid,
          });
        const r = await fetch(dlUrl);
        const fname = path.split("/").pop() || "download";
        return new Response(r.body, {
          status: r.status,
          headers: {
            ...headers,
            "Content-Type":
              r.headers.get("Content-Type") || "application/octet-stream",
            "Content-Disposition":
              r.headers.get("Content-Disposition") ||
              `attachment; filename="${encodeURIComponent(fname)}"`,
          },
        });
      }

      /* ========== DELETE ========== */
      if (url.pathname === "/delete" && req.method === "DELETE") {
        const path = url.searchParams.get("path");
        if (!path) return json({ error: "path required" }, 400, headers);
        const j = await nasGet(env, {
          api: "SYNO.FileStation.Delete",
          version: "2",
          method: "start",
          path: `"${path}"`,
          accurate_progress: "true",
        });
        return json(j, j.success ? 200 : 500, headers);
      }

      /* ========== INIT (one-time setup helper) ========== */
      if (url.pathname === "/init" && req.method === "POST") {
        await ensureCategoryFolders(env);
        return json({ ok: true, base, categories: CATEGORIES }, 200, headers);
      }

      return json({ error: "not found", path: url.pathname }, 404, headers);
    } catch (e) {
      return json(
        { error: e.message || "internal error" },
        500,
        cors(env),
      );
    }
  },
};
