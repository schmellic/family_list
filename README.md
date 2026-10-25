# Schmellic Family Wishlists

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

Back up the `.db` file and the `uploads` folder next to it to back up everything.

## Docker / Unraid

Unraid has no `docker compose`, so use plain docker from the project folder:

    docker build -t family-wishlist .
    docker rm -f family-wishlist
    docker run -d --name family-wishlist --restart unless-stopped -p 8095:3000 \
      -e FAMILY_CODE="your-family-code" -e INSECURE_COOKIES=1 \
      -v /mnt/user/appdata/family-wishlist:/data family-wishlist

The site is on host port 8095 (the left number in `-p`). The database and uploaded photos live in the mounted
`/data` folder, so map it to persistent storage (owned by uid 1000, or `chmod 777`). Plain-http LAN use needs
`INSECURE_COOKIES=1`; if you put it behind HTTPS (Nginx Proxy Manager, Cloudflare Tunnel, Tailscale Funnel),
remove that variable. `docker-compose.yml` is there for hosts that do have compose (`docker compose up -d --build`).

To update: `git pull`, then run the three commands above again. Your data is not touched.

## Admin

Create the account on the site first, then promote it (the container must be running):

    docker exec family-wishlist node make-admin.js <username>

Admins get an **Admin** button showing every list and who bought what. Use `--remove` to demote.

## Product lookup and photos

Pasting a shop link on the add/edit form fetches the page and pre-fills the name, photo and price. It is best effort.
Amazon links fill in the name and photo (not the price). Some shops, such as Argos, LEGO and Currys, refuse automated
requests; the form then says so, keeps the link, and you type the name and price yourself.
The server refuses to fetch private or local network addresses, so it can not be used to probe your LAN.

Any wish can have a photo: tap **Add a photo** to pick one from your phone or computer. The browser shrinks it
(max 1000px) before uploading, and it is stored in the `uploads` folder next to the database
(`/data/uploads` in Docker). Back that folder up along with the `.db` file. Deleting a wish removes its photo.
