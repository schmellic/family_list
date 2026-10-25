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
const show = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));
const guard = (fn) => async (e) => { try { await fn(e); } catch (err) { toast(err.message); } };

function renderNav() {
  nav.replaceChildren(...(me ? [
    me.is_admin && h('a', { class: 'btn', href: '#/admin' }, 'Admin'),
    h('a', { class: 'btn', href: `#/u/${me.id}` }, 'My list'),
    h('button', { onclick: guard(async () => { await api('POST', '/api/logout'); me = null; renderNav(); location.hash = '#/'; toast('Signed out'); }) }, 'Sign out'),
  ] : [h('a', { class: 'btn', href: '#/login' }, 'Family sign in')]).filter(Boolean));
}

function heart() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'heart'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M12 20.5s-8-4.6-8-10.4A4.6 4.6 0 0 1 12 7.3a4.6 4.6 0 0 1 8 2.8c0 5.8-8 10.4-8 10.4z');
  svg.append(p); return svg;
}
const avatar = (p) => h('span', { class: `avatar c${p.avatar_color ?? p.id % 6}`, 'aria-hidden': 'true' }, p.avatar_emoji || (p.display_name || '?').trim().charAt(0).toUpperCase());

// ---------- views ----------
async function home() {
  const { people } = await api('GET', '/api/people');
  show(
    h('div', {}, h('h1', {}, 'Whose list are you shopping for?'),
      h('p', { class: 'sub' }, 'Pick a person, open a link, and mark it bought so nobody doubles up.')),
    people.length
      ? h('ul', { class: 'people' }, people.map((p) => h('li', {}, h('a', { href: `#/u/${p.id}` },
          avatar(p),
          h('span', { class: 'who' }, h('span', { class: 'name' }, p.display_name),
            h('span', { class: 'count' }, `${p.item_count} ${p.item_count === 1 ? 'wish' : 'wishes'}`)),
          p.remaining == null ? h('span', { class: 'pill' }, 'You') : p.item_count ? h('span', { class: p.remaining ? 'pill gold' : 'pill' }, p.remaining ? `${p.remaining} to buy` : 'All bought') : null))))
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
    h('div', {}, f('image_url', 'Photo link (optional)', { placeholder: 'https://', maxLength: 2000 }),
      h('p', { class: 'hint' }, 'On the shop page, right-click the product photo and choose "Copy image address", then paste it here.')),
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
      h('div', { class: 'hero' }, h('a', { class: 'back', href: '#/' }, 'Home / Wishlist'), h('div', { class: 'hero-avatar' }, avatar(person)),
        h('h1', {}, isOwner ? 'My Wishlist' : `${person.display_name}'s Wishlist`),
        isOwner && h('a', { href: '#/avatar' }, 'Change my avatar'),
        isOwner && h('p', { class: 'sub' }, 'Others can see this list and mark things bought. You will not see which ones, so gifts stay a surprise.')),
      isOwner && itemForm(null, () => list(id)),
      cards.length ? h('div', { class: 'items-wrap' }, !editing && h('div', { class: 'colhead', 'aria-hidden': 'true' }, h('span'), h('span', {}, 'Item'), h('span', {}, 'Price'), h('span', {}, 'Status')),
        h('ul', { class: 'items' }, cards.map((c) => h('li', {}, c))))
        : h('div', { class: 'empty' }, isOwner ? 'Nothing here yet. Add your first wish above.' : `${person.display_name} has not added anything yet.`),
    );
  };
  const thumb = (it) => {
    const tile = h('span', { class: `thumb tile c${it.id % 6}`, 'aria-hidden': 'true' }, it.title.trim().charAt(0).toUpperCase());
    if (!it.image_url) return tile;
    const img = h('img', { class: 'thumb', src: it.image_url, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(tile));
    return img;
  };
  const added = (t) => `Added ${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const itemCard = (it) => {
    const bought = !isOwner && it.purchased;
    return h('article', { class: 'item row-item' + (bought ? ' bought' : '') },
      thumb(it),
      h('div', { class: 'info' }, h('h2', {}, it.title),
        it.url && h('a', { class: 'shop', href: it.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'View at ' + new URL(it.url).hostname.replace(/^www\./, '') + ' ↗'),
        it.notes && h('p', { class: 'notes' }, it.notes)),
      h('div', { class: 'cost' }, it.price && h('span', { class: 'price' }, it.price)),
      h('div', { class: 'act' }, h('span', { class: 'added' }, added(it.created_at)),
        isOwner ? h('div', { class: 'actions' },
          h('button', { class: 'link', onclick: () => { editing = it.id; render(); } }, 'Edit'),
          h('button', { class: 'link danger', onclick: guard(async (e) => {
            if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Tap again to delete'; return; }
            await api('DELETE', `/api/items/${it.id}`); list(id);
          }) }, 'Delete'))
        : bought
          ? h('div', { class: 'actions' }, h('span', { class: 'bought-by' }, `Bought by ${it.purchased.by}`),
              h('button', { class: 'link', onclick: guard(async () => { await api('DELETE', `/api/items/${it.id}/purchase`); list(id); }) }, 'Undo'))
          : buyForm(it)));
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

// Two-tap confirm for destructive buttons.
function dangerBtn(label, confirmLabel, action) {
  return h('button', { class: 'link danger', onclick: guard(async (e) => {
    if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = confirmLabel; return; }
    await action();
  }) }, label);
}

async function avatarView() {
  if (!me) { location.hash = '#/login'; return; }
  const [{ user }, { emojis, colors }] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/avatar-options')]);
  let emoji = user.avatar_emoji || '', color = user.avatar_color ?? user.id % 6;
  const preview = h('div', { class: 'hero-avatar' });
  const grid = h('div', { class: 'pick-grid', role: 'group', 'aria-label': 'Avatar' });
  const swatches = h('div', { class: 'pick-grid colors', role: 'group', 'aria-label': 'Colour' });
  const paint = () => {
    preview.replaceChildren(avatar({ ...user, display_name: user.display_name, avatar_emoji: emoji, avatar_color: color }));
    grid.replaceChildren(...['', ...emojis].map((e) => h('button', { type: 'button', class: 'pick' + (e === emoji ? ' on' : ''), 'aria-pressed': String(e === emoji), 'aria-label': e || 'My initial', onclick: () => { emoji = e; paint(); } }, e || user.display_name.trim().charAt(0).toUpperCase())));
    swatches.replaceChildren(...Array.from({ length: colors }, (_, i) => h('button', { type: 'button', class: `pick swatch c${i}` + (i === color ? ' on' : ''), 'aria-pressed': String(i === color), 'aria-label': `Colour ${i + 1}`, onclick: () => { color = i; paint(); } })));
  };
  paint();
  show(h('div', { class: 'auth' }, h('a', { class: 'back', href: `#/u/${user.id}` }, '← My list'), h('h1', {}, 'Your avatar'), preview,
    h('form', { class: 'card', onsubmit: guard(async (e) => { e.preventDefault(); await api('PUT', '/api/me/avatar', { emoji, color }); toast('Avatar saved'); location.hash = `#/u/${user.id}`; }) },
      h('h2', {}, 'Pick a picture'), grid, h('h2', {}, 'Pick a colour'), swatches,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save avatar')))));
}

async function admin() {
  const { people } = await api('GET', '/api/admin/overview');
  const total = people.reduce((n, p) => n + p.items.length, 0);
  const bought = people.reduce((n, p) => n + p.items.filter((i) => i.purchased_by).length, 0);
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const act = (fn, msg) => guard(async () => { await fn(); toast(msg); admin(); });
  const { invites } = await api('GET', '/api/admin/invites');
  const result = h('div', { class: 'invite-result', hidden: true });
  const emailIn = h('input', { id: 'invite-email', type: 'email', required: true, placeholder: 'name@example.com', 'aria-label': 'Email address to invite' });
  const copy = async (text, input) => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { input.select(); toast('Press Ctrl+C to copy'); } };
  const inviteBox = h('section', { class: 'admin-person' },
    h('h2', {}, 'Invite someone'),
    h('p', { class: 'hint' }, 'Enter their email and I will draft a message in Gmail for you to send. The link works once and expires in 7 days.'),
    h('form', { class: 'buy-form', onsubmit: guard(async (e) => {
      e.preventDefault();
      const r = await api('POST', '/api/admin/invites', { email: emailIn.value });
      const subject = `${me.display_name} invited you to the Schmellic Family Wishlists`;
      const body = `Hi,\n\nI've set up the Schmellic Family Wishlists so we can all see what everyone wants and avoid doubling up on presents. Create your account here (the link works once and expires in 7 days):\n\n${r.link}\n\nOnce you're in, add things you'd like, with links to where to buy them.\n\n${me.display_name}`;
      const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(r.email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      const link = h('input', { readOnly: true, value: r.link, 'aria-label': 'Invite link', onfocus: (ev) => ev.target.select() });
      result.replaceChildren(
        h('p', { class: 'hint' }, `Invite created for ${r.email}. Nothing has been sent yet.`),
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: gmail, target: '_blank', rel: 'noopener noreferrer' }, 'Open draft in Gmail'),
          h('button', { type: 'button', onclick: () => copy(body, link) }, 'Copy message')),
        h('div', { class: 'buy-form' }, link, h('button', { type: 'button', onclick: () => copy(r.link, link) }, 'Copy link')));
      result.hidden = false; emailIn.value = '';
    }) }, emailIn, h('button', { class: 'primary', type: 'submit' }, 'Create invite')),
    result,
    invites.length ? h('div', { class: 'pending' }, h('p', { class: 'hint' }, 'Waiting to be used:'),
      h('ul', { class: 'items' }, invites.map((i) => h('li', { class: 'row' }, h('span', {}, `${i.email} (expires ${fmt(i.expires_at)})`),
        h('button', { class: 'link danger', onclick: act(() => api('DELETE', `/api/admin/invites/${i.id}`), 'Invite cancelled') }, 'Cancel'))))) : null);
  const pwBox = (p) => {
    const input = h('input', { type: 'password', minLength: 8, placeholder: 'New password (8+ characters)', 'aria-label': `New password for ${p.display_name}` });
    return h('form', { class: 'buy-form', onsubmit: act(async (e) => { e.preventDefault(); await api('POST', `/api/admin/users/${p.id}/password`, { password: input.value }); }, 'Password changed') },
      input, h('button', { type: 'submit' }, 'Set password'));
  };
  const personBlock = (p) => {
    const isMe = p.id === me.id;
    const pwForm = pwBox(p); pwForm.hidden = true;
    return h('section', { class: 'admin-person' },
      h('div', { class: 'row' },
        h('h2', {}, p.display_name, p.is_admin && h('span', { class: 'pill admin-pill' }, 'Admin')),
        h('span', { class: 'pill' }, `${p.items.filter((i) => i.purchased_by).length} of ${p.items.length} bought`)),
      h('p', { class: 'hint' }, `Username: ${p.username}`),
      h('div', { class: 'actions' },
        !isMe && h('button', { class: 'link', onclick: act(() => api('POST', `/api/admin/users/${p.id}/admin`, { admin: !p.is_admin }), p.is_admin ? 'Admin removed' : 'Now an admin') }, p.is_admin ? 'Remove admin' : 'Make admin'),
        h('button', { class: 'link', onclick: () => { pwForm.hidden = !pwForm.hidden; } }, 'Reset password'),
        !isMe && dangerBtn('Delete user', 'Tap again: deletes them and their list', act(() => api('DELETE', `/api/admin/users/${p.id}`), 'User deleted'))),
      pwForm,
      p.items.length ? h('ul', { class: 'items' }, p.items.map((it) => h('li', {}, h('article', { class: 'item' + (it.purchased_by ? ' bought' : '') },
        h('h2', {}, it.title),
        h('div', { class: 'meta' }, it.price && h('span', {}, it.price),
          it.purchased_by ? h('span', {}, `Bought by ${it.purchased_by} on ${fmt(it.purchased_at)}`) : h('span', {}, 'Not bought yet'),
          it.url && h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, new URL(it.url).hostname.replace(/^www\./, '') + ' ↗')),
        h('div', { class: 'actions' },
          it.purchased_by && h('button', { class: 'link', onclick: act(() => api('DELETE', `/api/admin/items/${it.id}/purchase`), 'Purchase cleared') }, 'Clear purchase'),
          dangerBtn('Delete item', 'Tap again to delete', act(() => api('DELETE', `/api/admin/items/${it.id}`), 'Item deleted')))))))
        : h('div', { class: 'empty' }, 'No wishes yet.'));
  };
  show(
    h('div', {}, h('a', { class: 'back', href: '#/' }, '← Everyone'), h('h1', {}, 'Admin'),
      h('p', { class: 'sub' }, `${people.length} people, ${total} wishes, ${bought} bought. This shows purchases on every list, including yours, so avoid scrolling past your own if you want a surprise.`)),
    inviteBox,
    ...people.map(personBlock));
}

function authView(mode, invite) {
  const err = h('p', { class: 'error', hidden: true });
  const reg = mode === 'register';
  const inviteEmail = invite && invite.email;
  const field = (name, label, props = {}) => h('label', {}, label, h('input', { name, required: true, ...props }));
  show(h('div', { class: 'auth' },
    h('h1', {}, reg ? 'Join the family' : 'Family sign in'),
    inviteEmail && h('p', { class: 'sub' }, `You were invited as ${inviteEmail}. Choose a username and password.`),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        ({ user: me } = await api('POST', reg ? '/api/register' : '/api/login', { ...Object.fromEntries(new FormData(e.target)), invite: invite && invite.token }));
        renderNav(); location.hash = `#/u/${me.id}`;
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    } },
      reg && !invite && field('code', 'Family code', { autocomplete: 'off' }),
      reg && field('displayName', 'Your name', { maxLength: 40, autocomplete: 'name' }),
      field('username', 'Username', { autocomplete: 'username', maxLength: 30 }),
      field('password', 'Password', { type: 'password', minLength: reg ? 8 : 1, autocomplete: reg ? 'new-password' : 'current-password' }),
      reg && h('p', { class: 'hint' }, invite ? 'At least 8 characters.' : 'At least 8 characters. Ask a family member for the code or an invite link.'),
      err,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, reg ? 'Create account' : 'Sign in'),
        h('a', { href: reg ? '#/login' : '#/register' }, reg ? 'I already have an account' : 'Create an account')))));
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/';
  try {
    if (hash.startsWith('#/u/')) await list(hash.slice(4));
    else if (hash.startsWith('#/join/')) {
      const token = hash.slice(7);
      authView('register', { token, ...(await api('GET', `/api/invite/${encodeURIComponent(token)}`)) });
    }
    else if (hash === '#/avatar') await avatarView();
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
