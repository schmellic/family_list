// Family wishlist server. Zero dependencies: node:http + node:sqlite.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const FAMILY_CODE = process.env.FAMILY_CODE || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wishlist.db');
const SESSION_DAYS = 30;

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
if (!FAMILY_CODE) console.log('FAMILY_CODE is empty: accounts can only be created from admin invite links.');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT,
    price TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS purchases (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    purchased_by TEXT NOT NULL,
    purchased_at INTEGER NOT NULL
  );
`);

try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch { /* already migrated */ }

// ---------- helpers ----------
const now = () => Date.now();
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
const safeEqual = (a, b) => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.display_name, u.is_admin FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`).get(token, now()) || null;
}
function sessionCookie(token, maxAgeSec) {
  const secure = process.env.INSECURE_COOKIES ? '' : '; Secure';
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}
function startSession(res, userId, status, body) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, now() + SESSION_DAYS * 864e5);
  json(res, status, body, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 50_000) throw fail(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw fail(400, 'Invalid JSON'); }
}

const str = (v, max, label, required = false) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw fail(400, `${label} is required`);
  if (s.length > max) throw fail(400, `${label} is too long (max ${max})`);
  return s;
};
function cleanUrl(v) {
  const s = str(v, 2000, 'Link');
  if (!s) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw fail(400, 'That link does not look valid'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail(400, 'Link must start with http or https');
  return u.href;
}

// naive per-IP throttle for login/register
const attempts = new Map();
function throttle(req) {
  const ip = req.socket.remoteAddress;
  const rec = attempts.get(ip) || { n: 0, reset: now() + 15 * 60e3 };
  if (now() > rec.reset) { rec.n = 0; rec.reset = now() + 15 * 60e3; }
  if (++rec.n > 20) throw fail(429, 'Too many attempts. Try again in a few minutes.');
  attempts.set(ip, rec);
}

// ---------- API ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

const requireAdmin = (ctx) => { const u = requireUser(ctx); if (!u.is_admin) throw fail(403, 'Admins only'); return u; };
const requireUser = (ctx) => { if (!ctx.user) throw fail(401, 'Please sign in'); return ctx.user; };

route('GET', '/api/me', ({ user }) => ({ user: user && { ...user, is_admin: !!user.is_admin } }));

// Admin overview: every list with purchase details, including the admin's own.
route('GET', '/api/admin/overview', (ctx) => {
  requireAdmin(ctx);
  const people = db.prepare('SELECT id, display_name, username, is_admin FROM users ORDER BY display_name COLLATE NOCASE').all();
  const items = db.prepare(`SELECT i.id, i.user_id, i.title, i.url, i.price, p.purchased_by, p.purchased_at
    FROM items i LEFT JOIN purchases p ON p.item_id = i.id ORDER BY i.created_at DESC, i.id DESC`).all();
  return { people: people.map((p) => ({ ...p, is_admin: !!p.is_admin, items: items.filter((i) => i.user_id === p.id).map(({ user_id, ...it }) => it) })) };
});

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const findInvite = (token) => typeof token === 'string' && token
  ? db.prepare('SELECT id, email FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha(token), now())
  : null;

route('GET', '/api/invite/:token', ({ params }) => {
  const inv = findInvite(params.token);
  if (!inv) throw fail(404, 'This invite link is not valid any more. Ask for a new one.');
  return { email: inv.email };
});

route('POST', '/api/register', async (ctx) => {
  throttle(ctx.req);
  const b = ctx.body;
  const invite = b.invite ? findInvite(b.invite) : null;
  if (b.invite && !invite) throw fail(403, 'This invite link is not valid any more. Ask for a new one.');
  if (!invite && !(FAMILY_CODE && safeEqual(String(b.code || ''), FAMILY_CODE))) throw fail(403, 'That family code is not right');
  const username = str(b.username, 30, 'Username', true);
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw fail(400, 'Username can use letters, numbers, dot, dash and underscore');
  const display = str(b.displayName, 40, 'Name', true);
  const pw = typeof b.password === 'string' ? b.password : '';
  if (pw.length < 8) throw fail(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail(409, 'That username is taken');
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, display_name, pass_hash, created_at) VALUES (?,?,?,?)')
    .run(username, display, hashPassword(pw), now());
  if (invite) db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(now(), invite.id);
  ctx.startSession(Number(lastInsertRowid), 201, { user: { id: Number(lastInsertRowid), username, display_name: display, is_admin: false } });
});

route('POST', '/api/login', async (ctx) => {
  throttle(ctx.req);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(ctx.body.username || ''));
  const ok = row && checkPassword(String(ctx.body.password || ''), row.pass_hash);
  if (!ok) throw fail(401, 'Username or password is wrong');
  ctx.startSession(row.id, 200, { user: { id: row.id, username: row.username, display_name: row.display_name, is_admin: !!row.is_admin } });
});

route('POST', '/api/logout', (ctx) => {
  const token = parseCookies(ctx.req).session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  ctx.headers['Set-Cookie'] = sessionCookie('', 0);
  return { ok: true };
});

// Everyone can browse. Owners never see purchase info on their own list.
route('GET', '/api/people', ({ user }) => {
  const people = db.prepare(`SELECT u.id, u.display_name, COUNT(i.id) AS item_count,
      COUNT(p.item_id) AS bought_count
    FROM users u LEFT JOIN items i ON i.user_id = u.id LEFT JOIN purchases p ON p.item_id = i.id
    GROUP BY u.id ORDER BY u.display_name COLLATE NOCASE`).all();
  return { people: people.map((p) => ({
    id: p.id, display_name: p.display_name, item_count: p.item_count,
    remaining: user?.id === p.id ? null : p.item_count - p.bought_count,
  })) };
});

route('GET', '/api/people/:id', ({ user, params }) => {
  const person = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(params.id);
  if (!person) throw fail(404, 'No such person');
  const isOwner = user?.id === person.id;
  const items = db.prepare(`SELECT i.id, i.title, i.url, i.price, i.notes, p.purchased_by, p.purchased_at
    FROM items i LEFT JOIN purchases p ON p.item_id = i.id
    WHERE i.user_id = ? ORDER BY i.created_at DESC, i.id DESC`).all(person.id);
  return {
    person, isOwner,
    items: items.map(({ purchased_by, purchased_at, ...it }) =>
      isOwner ? it : { ...it, purchased: purchased_by ? { by: purchased_by, at: purchased_at } : null }),
  };
});

// Admin maintenance: remove users/items, clear purchases, change roles, reset passwords.
route('DELETE', '/api/admin/users/:id', (ctx) => {
  const admin = requireAdmin(ctx);
  if (Number(ctx.params.id) === admin.id) throw fail(400, 'You can not delete your own account');
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(ctx.params.id); // cascades to items, purchases, sessions
  if (!r.changes) throw fail(404, 'User not found');
  return { ok: true };
});

route('POST', '/api/admin/users/:id/admin', (ctx) => {
  const admin = requireAdmin(ctx);
  const makeAdmin = !!ctx.body.admin;
  if (!makeAdmin && Number(ctx.params.id) === admin.id) throw fail(400, 'You can not remove your own admin rights');
  const r = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, ctx.params.id);
  if (!r.changes) throw fail(404, 'User not found');
  return { ok: true };
});

route('POST', '/api/admin/users/:id/password', (ctx) => {
  requireAdmin(ctx);
  const pw = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  if (pw.length < 8) throw fail(400, 'Password must be at least 8 characters');
  const r = db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), ctx.params.id);
  if (!r.changes) throw fail(404, 'User not found');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(ctx.params.id); // sign them out everywhere
  return { ok: true };
});

route('DELETE', '/api/admin/items/:id', (ctx) => {
  requireAdmin(ctx);
  const r = db.prepare('DELETE FROM items WHERE id = ?').run(ctx.params.id);
  if (!r.changes) throw fail(404, 'Item not found');
  return { ok: true };
});

route('DELETE', '/api/admin/items/:id/purchase', (ctx) => {
  requireAdmin(ctx);
  db.prepare('DELETE FROM purchases WHERE item_id = ?').run(ctx.params.id);
  return { ok: true };
});

// Invites: single-use links, valid 7 days. The admin sends them from their own email.
route('POST', '/api/admin/invites', async (ctx) => {
  requireAdmin(ctx);
  const email = str(ctx.body.email, 200, 'Email', true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'That email address does not look right');
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO invites (token_hash, email, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), email, now(), now() + 7 * 864e5);
  const base = PUBLIC_URL || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`;
  const link = `${base}/#/join/${token}`;
  ctx.status = 201;
  return { link, email };
});

route('GET', '/api/admin/invites', (ctx) => {
  requireAdmin(ctx);
  return { invites: db.prepare('SELECT id, email, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now()) };
});

route('DELETE', '/api/admin/invites/:id', (ctx) => {
  requireAdmin(ctx);
  db.prepare('DELETE FROM invites WHERE id = ?').run(ctx.params.id);
  return { ok: true };
});

const itemFields = (b) => ({
  title: str(b.title, 200, 'Item name', true),
  url: cleanUrl(b.url),
  price: str(b.price, 40, 'Price') || null,
  notes: str(b.notes, 1000, 'Notes') || null,
});

route('POST', '/api/items', (ctx) => {
  const user = requireUser(ctx);
  const f = itemFields(ctx.body);
  const { lastInsertRowid } = db.prepare('INSERT INTO items (user_id, title, url, price, notes, created_at) VALUES (?,?,?,?,?,?)')
    .run(user.id, f.title, f.url, f.price, f.notes, now());
  ctx.status = 201;
  return { id: Number(lastInsertRowid) };
});

route('PUT', '/api/items/:id', (ctx) => {
  const user = requireUser(ctx);
  const f = itemFields(ctx.body);
  const r = db.prepare('UPDATE items SET title=?, url=?, price=?, notes=? WHERE id=? AND user_id=?')
    .run(f.title, f.url, f.price, f.notes, ctx.params.id, user.id);
  if (!r.changes) throw fail(404, 'Item not found');
  return { ok: true };
});

route('DELETE', '/api/items/:id', (ctx) => {
  const user = requireUser(ctx);
  const r = db.prepare('DELETE FROM items WHERE id=? AND user_id=?').run(ctx.params.id, user.id);
  if (!r.changes) throw fail(404, 'Item not found');
  return { ok: true };
});

// Anyone (signed in or not) can mark an item bought, except its owner.
route('POST', '/api/items/:id/purchase', (ctx) => {
  const item = db.prepare('SELECT user_id FROM items WHERE id = ?').get(ctx.params.id);
  if (!item) throw fail(404, 'Item not found');
  if (ctx.user?.id === item.user_id) throw fail(403, 'You can not mark your own wishes');
  const by = str(ctx.body.name, 40, 'Name') || ctx.user?.display_name || 'Someone';
  const r = db.prepare('INSERT OR IGNORE INTO purchases (item_id, purchased_by, purchased_at) VALUES (?,?,?)')
    .run(ctx.params.id, by, now());
  if (!r.changes) throw fail(409, 'Someone just marked this as bought');
  return { ok: true };
});

route('DELETE', '/api/items/:id/purchase', (ctx) => {
  const item = db.prepare('SELECT user_id FROM items WHERE id = ?').get(ctx.params.id);
  if (!item) throw fail(404, 'Item not found');
  if (ctx.user?.id === item.user_id) throw fail(403, 'Not allowed');
  db.prepare('DELETE FROM purchases WHERE item_id = ?').run(ctx.params.id);
  return { ok: true };
});

// ---------- static + dispatch ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      // CSRF defence: state-changing requests must be same-origin JSON
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw fail(403, 'Bad origin');
        if (!(req.headers['content-type'] || '').startsWith('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length']) throw fail(415, 'JSON only');
      }
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const ctx = { req, params: m.groups || {}, user: currentUser(req), status: 200, headers: {},
          body: req.method === 'GET' ? {} : await readBody(req) };
        ctx.startSession = (uid, st, body) => startSession(res, uid, st, body);
        const out = await r.handler(ctx);
        if (!res.headersSent && out !== undefined) json(res, ctx.status, out, ctx.headers);
        return;
      }
      throw fail(404, 'Not found');
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, SEC); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (!e.status) console.error(e);
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
}).listen(PORT, () => console.log(`Wishlist running on http://localhost:${PORT}`));

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 36e5).unref();
