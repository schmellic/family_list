// Fetches a product page and pulls out a name, photo and price (best effort).
// The server runs inside the home network, so it must never fetch private addresses.
'use strict';
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;

// ---------- address safety ----------
function v4Private([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return v4Private(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return true;
  const l = ip.toLowerCase();
  let m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return v4Private(m[1].split('.').map(Number));
  m = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); return v4Private([hi >> 8, hi & 255, lo >> 8]); }
  if (l === '::' || l === '::1' || l.startsWith('64:ff9b:') || l.startsWith('2002:')) return true;
  const first = parseInt(l.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

// ---------- fetching ----------
function request(u, allowPrivate) {
  return new Promise((resolve, reject) => {
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('bad protocol'));
    if (!allowPrivate && u.port && !['80', '443'].includes(u.port)) return reject(new Error('bad port'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(new Error('blocked'));
    // Resolve and check in the same step the socket uses, so DNS tricks can not swap the address afterwards.
    const lookup = (hostname, opts, cb) => dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('blocked'));
      return opts && opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    });
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(deadline); fn(v); } };
    const req = lib.request(u, {
      method: 'GET', lookup, timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FamilyWishlistBot/1.0)',
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return finish(resolve, { redirect: new URL(res.headers.location, u).href });
      }
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error(`status ${res.statusCode}`)); }
      const type = String(res.headers['content-type'] || '');
      if (!/html/i.test(type)) { res.resume(); return finish(reject, new Error('not a web page')); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = []; let size = 0;
      const end = () => { res.destroy(); finish(resolve, { body: Buffer.concat(chunks), type }); };
      stream.on('data', (c) => { chunks.push(c); size += c.length; if (size > MAX_BYTES) end(); });
      stream.on('end', end);
      stream.on('error', () => (size ? end() : finish(reject, new Error('read error'))));
    });
    const deadline = setTimeout(() => { req.destroy(); finish(reject, new Error('timeout')); }, TIMEOUT_MS + 2000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

async function fetchHtml(rawUrl, allowPrivate) {
  let url = new URL(rawUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await request(url, allowPrivate);
    if (r.redirect) { url = new URL(r.redirect); continue; }
    const charset = (r.type.match(/charset=["']?([\w-]+)/i) || r.body.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    let html;
    try { html = new TextDecoder(charset || 'utf-8').decode(r.body); } catch { html = r.body.toString('utf8'); }
    return { html, url: url.href };
  }
  throw new Error('too many redirects');
}

// ---------- parsing ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return m; } }
  return ENTITIES[e.toLowerCase()] ?? m;
});
function attrs(s) {
  const out = {}; const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g; let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}
function metaMap(html) {
  const map = {}; const re = /<meta\s+([^>]*?)\/?>/gi; let m;
  while ((m = re.exec(html))) {
    const a = attrs(m[1]); const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in map)) map[key] = decode(a.content).trim();
  }
  return map;
}
function jsonLdProducts(html) {
  const found = []; const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  const walk = (n, depth = 0) => {
    if (!n || typeof n !== 'object' || depth > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    if ([].concat(n['@type'] || []).some((t) => /^(Product|ProductGroup)$/.test(t))) found.push(n);
    if (n['@graph']) walk(n['@graph'], depth + 1);
  };
  while ((m = re.exec(html))) { try { walk(JSON.parse(m[1].trim())); } catch { /* ignore bad JSON */ } }
  return found;
}
const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', JPY: '¥', INR: '₹' };
function formatPrice(amount, currency) {
  if (amount == null) return null;
  const n = parseFloat(String(amount).replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 1e7) return null;
  const cur = String(currency || '').toUpperCase();
  const num = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return cur ? (SYMBOLS[cur] ? `${SYMBOLS[cur]}${num}` : `${cur} ${num}`) : num;
}
// When a page gives a price but no currency, guess from the shop's domain.
function currencyFromUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (/\.(co\.uk|uk|gb)$/.test(h)) return 'GBP';
    if (/\.(com\.au|au)$/.test(h)) return 'AUD';
    if (/\.(ca)$/.test(h)) return 'CAD';
    if (/\.(nz)$/.test(h)) return 'NZD';
    if (/\.(de|fr|es|it|nl|ie|be|at|pt|fi)$/.test(h)) return 'EUR';
    if (/\.(in)$/.test(h)) return 'INR';
    if (/\.(com|us)$/.test(h)) return 'USD';
  } catch { /* ignore */ }
  return '';
}
const clean = (s, max) => (s ? decode(s).replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Shops that block bots send back a generic page: site name as title, logo as image.
const JUNK_TITLE = /^(robot check|captcha|access denied|just a moment|attention required|sign[- ]?in|log ?in|page not found|404|403|error|service unavailable|verify you are human)\b/i;
const JUNK_IMAGE = /(share-icons|previewdoh|logo|favicon|sprite|placeholder|default[-_]?image|blank\.)/i;
function isJunkTitle(title, pageUrl) {
  if (!title || JUNK_TITLE.test(title)) return true;
  const brand = new URL(pageUrl).hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const plain = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  return plain === brand || plain === brand + 'com' || plain === brand + 'couk';
}

// Product name guessed from the link, e.g. /Grand-Theft-Auto-VI-PlayStation/dp/B0H25M... on Amazon.
function titleFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const dp = segs.findIndex((s) => /^(dp|gp|product|p)$/i.test(s));
    const slug = (dp > 0 ? segs[dp - 1] : segs.filter((s) => /^[\w%.-]+$/.test(s) && (s.match(/[-_]/g) || []).length >= 2).sort((a, b) => b.length - a.length)[0]) || '';
    const words = slug.replace(/\.(html?|php|aspx?)$/i, '').split(/[-_+]+/).filter(Boolean);
    if (words.length < 2 || words.some((w) => w.length > 30) || words.every((w) => /^\d+$/.test(w))) return '';
    return words.join(' ').slice(0, 200);
  } catch { return ''; }
}

function parseProduct(html, baseUrl) {
  const meta = metaMap(html);
  const products = jsonLdProducts(html);
  const ld = products[0] || {};
  const offer = [].concat(ld.offers || [])[0] || {};
  const spec = [].concat(offer.priceSpecification || [])[0] || {};

  let title = clean(ld.name || meta['og:title'] || meta['twitter:title'] || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], 200);
  if (isJunkTitle(title, baseUrl)) title = '';

  const ldImage = [].concat(ld.image || [])[0];
  let image = meta['og:image:secure_url'] || meta['og:image'] || (typeof ldImage === 'string' ? ldImage : ldImage && ldImage.url) || meta['twitter:image'];
  try {
    if (image && JUNK_IMAGE.test(image) && !ldImage) image = '';
    if (image) { const iu = new URL(decode(image), baseUrl); if (iu.protocol === 'http:') iu.protocol = 'https:'; image = ['http:', 'https:'].includes(iu.protocol) && iu.href.length <= 2000 ? iu.href : ''; }
  } catch { image = ''; }

  let amount = offer.price ?? offer.lowPrice ?? spec.price ?? meta['product:price:amount'] ?? meta['og:price:amount'];
  let currency = offer.priceCurrency || spec.priceCurrency || meta['product:price:currency'] || meta['og:price:currency'];
  if (amount == null) {
    const tag = (html.match(/<[^>]+itemprop=["']price["'][^>]*>/i) || [])[0];
    if (tag) { const a = attrs(tag); amount = a.content; currency = currency || a.pricecurrency; }
  }
  const price = formatPrice(amount, currency || currencyFromUrl(baseUrl));

  const out = {};
  if (title) out.title = title;
  if (image) out.image_url = image;
  if (price) out.price = price;
  return out;
}

async function fetchProductInfo(rawUrl, { allowPrivate = false } = {}) {
  const { html, url } = await fetchHtml(rawUrl, allowPrivate);
  const info = parseProduct(html, url);
  if (!info.title) { const guess = titleFromUrl(rawUrl); if (guess) info.title = guess; }
  return info;
}

module.exports = { fetchProductInfo, parseProduct, isPrivateIp, formatPrice, titleFromUrl };
