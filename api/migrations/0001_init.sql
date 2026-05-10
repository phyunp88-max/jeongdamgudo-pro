-- ===== JEONGDAMGUDO Groupware — D1 schema =====

PRAGMA foreign_keys = ON;

-- Departments
CREATE TABLE IF NOT EXISTS depts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  code        TEXT,
  description TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  dept          TEXT,                                             -- denormalized dept name
  role          TEXT NOT NULL CHECK(role IN ('admin','manager','staff')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login    TEXT
);

-- Permissions matrix (role x feature x op)
CREATE TABLE IF NOT EXISTS permissions (
  role     TEXT NOT NULL,
  feature  TEXT NOT NULL,
  op       TEXT NOT NULL,
  allowed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role, feature, op)
);

-- Documents (metadata only — actual files live on NAS via NAS Worker)
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  nas_path    TEXT,
  size        INTEGER,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_name  TEXT,
  tags        TEXT,                                               -- JSON array string
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_doc_cat ON documents(category, created_at DESC);

-- Internal messages (NOT external email — that's MailPlus)
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject    TEXT NOT NULL,
  body       TEXT,
  read_at    TEXT,
  folder     TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','sent','draft','trash')),
  tag        TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id, folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_id, folder, created_at DESC);

-- Activity log
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT,
  action     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('login','write','delete','read')),
  detail     TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_log_created ON logs(created_at DESC);

-- ===== Seed: default departments =====
INSERT OR IGNORE INTO depts (name, code, description) VALUES
  ('Design Team', 'DESIGN', '설계 · 도면 · 인허가'),
  ('Site Team',   'SITE',   '시공 관리 · 현장 감독'),
  ('Admin Team',  'ADMIN',  '재무 · 인사 · 계약');

-- ===== Seed: default permissions =====
INSERT OR IGNORE INTO permissions (role, feature, op, allowed) VALUES
  ('admin',   'mail',    'r', 1),
  ('admin',   'mail',    'w', 1),
  ('admin',   'library', 'r', 1),
  ('admin',   'library', 'w', 1),
  ('admin',   'library', 'd', 1),
  ('admin',   'admin',   'r', 1),
  ('admin',   'admin',   'w', 1),
  ('manager', 'mail',    'r', 1),
  ('manager', 'mail',    'w', 1),
  ('manager', 'library', 'r', 1),
  ('manager', 'library', 'w', 1),
  ('manager', 'library', 'd', 0),
  ('manager', 'admin',   'r', 0),
  ('manager', 'admin',   'w', 0),
  ('staff',   'mail',    'r', 1),
  ('staff',   'mail',    'w', 1),
  ('staff',   'library', 'r', 1),
  ('staff',   'library', 'w', 0),
  ('staff',   'library', 'd', 0),
  ('staff',   'admin',   'r', 0),
  ('staff',   'admin',   'w', 0);

-- Note: First admin user is created via POST /api/init (one-time, requires ADMIN_PASS secret)
