# Family Wishlists

Family members sign in and keep a wishlist of items with buy links. Anyone with the site URL can browse
lists and mark items as bought. List owners never see which of their own items were bought.

## Run

    FAMILY_CODE=choose-a-secret-phrase npm start

Needs Node 22.13+ (uses the built-in SQLite, no `npm install`). Open http://localhost:3000, click
"Family sign in", then "Create an account" and enter the family code.

Environment variables:

- `FAMILY_CODE` (required): invite code needed to create an account.
- `PORT` (default 3000), `DB_PATH` (default `./wishlist.db`; put this on persistent storage).
- `INSECURE_COOKIES=1`: only for local http testing. In production serve over HTTPS.

Back up the `.db` file to back up everything.

## Docker / Unraid

    docker compose up -d --build

The site is served on host port 8095 (left side of the port mapping in `docker-compose.yml`). Edit `FAMILY_CODE` in `docker-compose.yml` first. The database lives in the mounted `/data` folder, so
map it to persistent storage (on Unraid, `/mnt/user/appdata/family-wishlist`, owned by uid 1000
or `chmod 777`). Plain-http LAN use needs `INSECURE_COOKIES=1`; if you put it behind HTTPS
(Nginx Proxy Manager, Cloudflare Tunnel, Tailscale Funnel), remove that variable.
