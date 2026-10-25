# Schmellic Family Wishlists

Family wishlist site. Family sign in and keep lists with buy links; anyone with the URL can browse and mark items bought.
Owners never see purchase info on their own list. Runs in Docker on the owner's Unraid server (LAN, plain http).

## Stack
- Zero npm dependencies. Node 22.13+ (`node:http`, built-in `node:sqlite`), vanilla JS front end. No build step.
- `server.js`: API, auth (scrypt, session cookie), static files, SQLite schema + migrations (ALTER TABLE in try/catch).
- `lookup.js`: fetches a shop page and extracts title/photo/price. Blocks private/local addresses (SSRF). Tests live outside the repo; re-create if you change it.
- `make-admin.js`: `docker exec family-wishlist node make-admin.js <username>` promotes a user to admin.
- `public/`: `index.html`, `app.js` (hash router, DOM built with `h()` helper, no innerHTML), `style.css` (light/dark tokens).

## Run locally
    FAMILY_CODE=test INSECURE_COOKIES=1 DB_PATH=/tmp/dev.db PORT=3000 node server.js
`INSECURE_COOKIES=1` is needed on plain http. Empty `FAMILY_CODE` means invite-link-only sign-up.
`LOOKUP_ALLOW_PRIVATE_FOR_TESTS=1` lets the lookup hit localhost for testing only; never set it in production.

## Deploy (Unraid has no `docker compose`; use plain docker)
    docker build -t family-wishlist .
    docker rm -f family-wishlist
    docker run -d --name family-wishlist --restart unless-stopped -p 8095:3000 \
      -e FAMILY_CODE="..." -e INSECURE_COOKIES=1 -v /mnt/user/appdata/family-wishlist:/data family-wishlist
Site is on host port 8095 (3000 is taken by Grafana). Data is the SQLite file in the mounted `/data`.

## Decisions and gotchas
- CSP is strict: no inline scripts/styles. Images allowed from `self` and any https host (product photos are hotlinked).
- Admin: view all lists and purchases, delete users/items, clear purchases, change roles, reset passwords, create single-use 7-day invite links.
  Invites are emailed by the admin from their own Gmail via a prefilled compose link; the server sends no email.
- Avatars are an allowlisted emoji plus one of 6 colours (server validates).
- Amazon and some other shops block automated lookups; the lookup then falls back to a title guessed from the URL.
- Bare numeric prices get a default currency symbol (`DEFAULT_CURRENCY_SYMBOL`, default £).
- Do not put the real family code in committed files.
