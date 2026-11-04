# Will GitHub Break Today?

WGBT Outage Forecast: a parody weather broadcast for GitHub. Visitors call **which part of GitHub breaks next** by tapping a region on a map of a cat-shaped continent; [githubstatus.com](https://www.githubstatus.com) settles each round. Every day is graded and kept on the record.

Live at <https://will-github-break-today.bovolato.dev>.

## How it works

- **One Cloudflare Worker** serves the static page from `public/` and a small API (`src/`).
- **D1** stores days, incidents, rounds, calls and a little metadata (`migrations/`).
- **A Cron Trigger** runs every minute. It pulls `incidents.json` and `summary.json` from GitHub's Statuspage API, and any page load also syncs if the last sync is over a minute old.
  - **Days:** any incident open during a UTC day marks it broke, graded by GitHub's own impact levels (Minor, Major, Critical). A past day with nothing is "No incident".
  - **Untagged incidents:** about a third name no component, so they're placed from their title ("Copilot Code Review…" → Copilot). Ones that can't be placed (Dependabot, billing, "some GitHub services") land on Unlisted Territory.
  - **Rounds:** a round stays open until the next incident starts. That incident's components win, and a new round opens. Calls filed after the incident started roll into the next round.
- **Calls** are anonymous: one per browser per round (a random ID in an HttpOnly cookie). Abuse limits are per network (the IPv4 address or IPv6 /64, stored only as a hash salted per round): 5 calls a minute, 100 per round.
- **The page** polls `GET /api/live` (today, the last week, the market) every 20 seconds while an incident is live and every 90 seconds otherwise, pausing in background tabs. `GET /api/history` (every day and the record) is fetched once per visit. They're edge-cached for 10 seconds and 5 minutes, so each data centre rebuilds them at most that often, however many people are watching.

## Develop

```sh
bun install
cp wrangler.example.jsonc wrangler.jsonc   # placeholders are fine for local dev
npm run types
npm run db:migrate:local
npm run dev
# pull status data once (cron doesn't fire on its own in dev):
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
# optional: load the last year of incidents (the live API only returns 50)
npm run backfill
```

On localhost, `/?simulate=outage` lights up every region to preview the radar.

## History backfill

`scripts/backfill.mjs` walks githubstatus.com's paginated history (one quarter per page), fetches each incident's details, and loads them. Re-running it is safe: stored incidents are left alone, except title guesses, which are refreshed so rule changes apply to history. It runs on your machine, not in the Worker, because a free-plan Worker can only make 50 outbound requests per invocation. `--days 365` sets how far back to go.

## The map

The continent's terrain is pre-rendered, not drawn in the browser:

```sh
node scripts/render-map.mjs
cwebp -q 86 -alpha_q 100 -m 6 public/map/terrain.png -o public/map/terrain.webp && rm public/map/terrain.png
```

Provinces follow the cat's anatomy. Their areas in `scripts/render-map.mjs` must match `REGIONS` (label and echo positions) in `public/app.js`.

## Deploy (Wrangler only)

```sh
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create will-github-break-today   # paste the id into wrangler.jsonc
# set routes[0].pattern in wrangler.jsonc to a hostname on your own Cloudflare zone
npm run db:migrate:remote
npx wrangler secret put SALT                     # any long random string
npm run deploy
npm run backfill:remote                          # load the last year of incidents (one-off)
```

`wrangler.jsonc` is gitignored: it holds your own database id and domain. The `custom_domain` route creates the DNS record on deploy.

Not affiliated with GitHub.
