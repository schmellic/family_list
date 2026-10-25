// Usage: node make-admin.js <username> [--remove]
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [username, flag] = process.argv.slice(2);
if (!username) { console.error('Usage: node make-admin.js <username> [--remove]'); process.exit(1); }
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'wishlist.db'));
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch {}
const r = db.prepare('UPDATE users SET is_admin = ? WHERE username = ?').run(flag === '--remove' ? 0 : 1, username);
console.log(r.changes ? `${username} is ${flag === '--remove' ? 'no longer' : 'now'} an admin.` : `No user named "${username}". Create the account on the site first.`);
