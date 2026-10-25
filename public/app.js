'use strict';
const app = document.getElementById('app');
const nav = document.getElementById('nav');
let me = null;

// ---------- helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2800);
}
const show = (...nodes) => app.replaceChildren(...nodes);
const guard = (fn) => async (e) => { try { await fn(e); } catch (err) { toast(err.message); } };

function renderNav() {
  nav.replaceChildren(...(me ? [
    me.is_admin && h('a', { class: 'btn', href: '#/admin' }, 'Admin'),
    h('a', { class: 'btn', href: `#/u/${me.id}` }, 'My list'),
    h('button', { onclick: guard(async () => { await api('POST', '/api/logout'); me = null; renderNav(); location.hash = '#/'; toast('Signed out'); }) }, 'Sign out'),
  ] : [h('a', { class: 'btn', href: '#/login' }, 'Family sign in')]));
}

// ---------- views ----------
async function home() {
  const { people } = await api('GET', '/api/people');
  show(
    h('div', {}, h('h1', {}, 'Whose list are you shopping for?'),
      h('p', { class: 'sub' }, 'Pick a person, open a link, and mark it bought so nobody doubles up.')),
    people.length
      ? h('ul', { class: 'people' }, people.map((p) => h('li', {}, h('a', { href: `#/u/${p.id}` },
          h('span', { class: 'name' }, p.display_name),
          h('span', { class: 'pill' }, p.remaining == null ? `${p.item_count} wishes` : `${p.remaining} of ${p.item_count} still wanted`)))))
      : h('div', { class: 'empty' }, 'No lists yet. A family member can sign up to start one.'),
  );
}

function itemForm(item, onDone) {
  const err = h('p', { class: 'error', hidden: true });
  const f = (name, label, props = {}) => h('label', {}, label, h(props.area ? 'textarea' : 'input', { name, value: item?.[name] || '', ...props }));
  return h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      await (item ? api('PUT', `/api/items/${item.id}`, body) : api('POST', '/api/items', body));
      onDone();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  } },
    h('h2', {}, item ? 'Edit wish' : 'Add a wish'),
    f('title', 'What is it?', { required: true, maxLength: 200 }),
    f('url', 'Link to buy it', { placeholder: 'https://', maxLength: 2000 }),
    h('div', { class: 'two' }, f('price', 'Price (approx.)', { maxLength: 40 }), h('span')),
    f('notes', 'Size, colour, anything else', { area: true, maxLength: 1000 }),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, item ? 'Save' : 'Add to list'),
      item && h('button', { type: 'button', onclick: onDone }, 'Cancel')));
}

async function list(id) {
  const { person, isOwner, items } = await api('GET', `/api/people/${id}`);
  let editing = null;
  const render = () => {
    const cards = items.map((it) => editing === it.id ? itemForm(it, () => { editing = null; list(id); }) : itemCard(it));
    show(
      h('div', {}, h('a', { href: '#/' }, '← Everyone'), h('h1', {}, isOwner ? 'Your wishlist' : `${person.display_name}'s wishlist`),
        isOwner && h('p', { class: 'sub' }, 'Others can see this list and mark things bought. You will not see which ones, so gifts stay a surprise.')),
      isOwner && itemForm(null, () => list(id)),
      cards.length ? h('ul', { class: 'items' }, cards.map((c) => h('li', {}, c)))
        : h('div', { class: 'empty' }, isOwner ? 'Nothing here yet. Add your first wish above.' : `${person.display_name} has not added anything yet.`),
    );
  };
  const itemCard = (it) => {
    const bought = !isOwner && it.purchased;
    return h('article', { class: 'item' + (bought ? ' bought' : '') },
      h('h2', {}, it.title),
      (it.price || it.url) && h('div', { class: 'meta' }, it.price && h('span', {}, it.price),
        it.url && h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, new URL(it.url).hostname.replace(/^www\./, '') + ' ↗')),
      it.notes && h('p', { class: 'notes' }, it.notes),
      isOwner ? h('div', { class: 'actions' },
        h('button', { class: 'link', onclick: () => { editing = it.id; render(); } }, 'Edit'),
        h('button', { class: 'link danger', onclick: guard(async (e) => {
          if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Tap again to delete'; return; }
          await api('DELETE', `/api/items/${it.id}`); list(id);
        }) }, 'Delete'))
      : bought
        ? h('div', { class: 'actions' }, h('span', { class: 'bought-by' }, `Bought by ${it.purchased.by}`),
            h('button', { class: 'link', onclick: guard(async () => { await api('DELETE', `/api/items/${it.id}/purchase`); list(id); }) }, 'Undo'))
        : buyForm(it));
  };
  const buyForm = (it) => {
    const name = h('input', { name: 'name', placeholder: me ? me.display_name : 'Your name (optional)', maxLength: 40, 'aria-label': 'Your name' });
    return h('form', { class: 'buy-form', onsubmit: guard(async (e) => {
      e.preventDefault();
      await api('POST', `/api/items/${it.id}/purchase`, { name: name.value });
      toast('Marked as bought'); list(id);
    }) }, name, h('button', { class: 'primary', type: 'submit' }, 'I bought this'));
  };
  render();
}

async function admin() {
  const { people } = await api('GET', '/api/admin/overview');
  const total = people.reduce((n, p) => n + p.items.length, 0);
  const bought = people.reduce((n, p) => n + p.items.filter((i) => i.purchased_by).length, 0);
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  show(
    h('div', {}, h('a', { href: '#/' }, '← Everyone'), h('h1', {}, 'Admin overview'),
      h('p', { class: 'sub' }, `${people.length} people, ${total} wishes, ${bought} bought. This shows purchases on every list, including yours, so avoid scrolling past your own if you want a surprise.`)),
    ...people.map((p) => h('section', { class: 'admin-person' },
      h('div', { class: 'row' }, h('h2', {}, p.display_name), h('span', { class: 'pill' }, `${p.items.filter((i) => i.purchased_by).length} of ${p.items.length} bought`)),
      p.items.length ? h('ul', { class: 'items' }, p.items.map((it) => h('li', {}, h('article', { class: 'item' + (it.purchased_by ? ' bought' : '') },
        h('h2', {}, it.title),
        h('div', { class: 'meta' }, it.price && h('span', {}, it.price),
          it.purchased_by ? h('span', {}, `Bought by ${it.purchased_by} on ${fmt(it.purchased_at)}`) : h('span', {}, 'Not bought yet'),
          it.url && h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, new URL(it.url).hostname.replace(/^www\./, '') + ' ↗'))))))
        : h('div', { class: 'empty' }, 'No wishes yet.'))));
}

function authView(mode) {
  const err = h('p', { class: 'error', hidden: true });
  const reg = mode === 'register';
  const field = (name, label, props = {}) => h('label', {}, label, h('input', { name, required: true, ...props }));
  show(
    h('h1', {}, reg ? 'Join the family' : 'Family sign in'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        ({ user: me } = await api('POST', reg ? '/api/register' : '/api/login', Object.fromEntries(new FormData(e.target))));
        renderNav(); location.hash = `#/u/${me.id}`;
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    } },
      reg && field('code', 'Family code', { autocomplete: 'off' }),
      reg && field('displayName', 'Your name', { maxLength: 40, autocomplete: 'name' }),
      field('username', 'Username', { autocomplete: 'username', maxLength: 30 }),
      field('password', 'Password', { type: 'password', minLength: reg ? 8 : 1, autocomplete: reg ? 'new-password' : 'current-password' }),
      reg && h('p', { class: 'hint' }, 'At least 8 characters. Ask a family member for the code.'),
      err,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, reg ? 'Create account' : 'Sign in'),
        h('a', { href: reg ? '#/login' : '#/register' }, reg ? 'I already have an account' : 'Create an account'))));
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/';
  try {
    if (hash.startsWith('#/u/')) await list(hash.slice(4));
    else if (hash === '#/admin') await admin();
    else if (hash === '#/login') authView('login');
    else if (hash === '#/register') authView('register');
    else await home();
  } catch (e) {
    show(h('div', { class: 'empty' }, e.message), h('a', { href: '#/' }, '← Back to everyone'));
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
(async () => {
  try { me = (await api('GET', '/api/me')).user; } catch {}
  renderNav(); route();
})();
