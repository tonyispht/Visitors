# Visitors

Personal Feedjit-style live visitor widget for my games and apps: real-time counter, "who just arrived" feed, synthesized join sound, and an embed-code generator. Runs on one Cloudflare Worker + a SQLite Durable Object per site ID (fits the free plan for personal use). No IPs are stored — only country/city from Cloudflare, page name, referrer host and device type.

## Deploy
```bash
npm install
npx wrangler login      # once
npx wrangler deploy
```
Open `https://visitors.<your-subdomain>.workers.dev/` for the generator, pick a site ID, copy the embed code into your game.

Or connect this repo in the Cloudflare dashboard: Workers & Pages → Create → Import a repository.

## Embed
```html
<script async src="https://visitors.<you>.workers.dev/widget.js" data-site="my-game"></script>
```
Options (all optional): `data-name`, `data-label`, `data-position` (bottom-right|bottom-left|top-right|top-left), `data-theme` (neon|dark|light|glass), `data-accent`, `data-panel` (collapsed|open|hidden), `data-show` (both|online|total|none), `data-feed`, `data-sound` (on|off), `data-sound-type` (chime|ding|bell|coin|blip|pop), `data-volume` (0-1), `data-leave-sound`, `data-show-to` (everyone|owner).

## Owner mode
Open any page that has the widget once with `?visitors=owner`. That browser is never counted, and with `data-show-to="owner"` only you see the panel and hear sounds while players are tracked silently. Undo with `?visitors=forget`.

## Lock it down (optional)
Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to the hostnames your games are served from (e.g. `"yourdomain.com,itch.zone"`). It is a soft lock (Origin headers can be forged by non-browser clients). Games opened from `file://` send no usable origin and will be blocked once the list is set.

## API
`GET /api/stats?site=my-game` → `{ "online": 3, "total": 1204 }`
`WS  /ws?site=my-game` → messages: `hello`, `join`, `count`, `leave`
