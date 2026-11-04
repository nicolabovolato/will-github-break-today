import { buildHistory, buildLive } from "./state";
import { sync, UNLISTED, type LiveState } from "./sync";
import { json, sha256, type Env } from "./util";

const LIVE_TTL = 10; // seconds the edge may serve a cached /api/live
const HISTORY_TTL = 300; // /api/history changes at most once a minute and matters far less
const STALE_SYNC_MS = 60_000; // refresh opportunistically if cron is late
const MAX_PICKS_PER_NETWORK = 100; // per round: generous, since offices and mobile carriers share one IP
const MAX_PICKS_PER_MINUTE = 5; // per network: people never hit this, scripts do
const VOTER_COOKIE = "wgbt_voter";

/** Serve from this data centre's cache, rebuilding at most once per TTL however many visitors there are. */
async function cached<T>(
  req: Request,
  ctx: ExecutionContext,
  ttl: number,
  build: () => Promise<T>,
  cacheable: (body: T) => boolean = () => true,
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL(new URL(req.url).pathname, req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const body = await build();
  // Never pin an empty, not-yet-synced response for a whole TTL (e.g. right after a deploy).
  if (!cacheable(body)) return json(body, { headers: { "cache-control": "no-store" } });
  const res = json(body, { headers: { "cache-control": `public, max-age=${ttl}` } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function getLive(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cached(
    req,
    ctx,
    LIVE_TTL,
    async () => {
      const live = await buildLive(env);
      if (!live.syncedAt || Date.now() - Date.parse(live.syncedAt) > STALE_SYNC_MS) {
        ctx.waitUntil(sync(env).catch((e) => console.error("sync failed", e)));
      }
      return live;
    },
    (live) => !!live.syncedAt,
  );
}

function readCookie(req: Request, name: string): string | null {
  const match = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** The unit a limit applies to: the IPv4 address, or the /64 block for IPv6 (one customer's allocation). */
export function networkOf(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

async function postPick(req: Request, env: Env): Promise<Response> {
  // Only this site may file calls: a JSON body (which forces a CORS preflight cross-site)
  // from a same-origin page. Stops other sites making visitors' browsers vote.
  const origin = req.headers.get("origin");
  if (!req.headers.get("content-type")?.startsWith("application/json") || (origin && origin !== new URL(req.url).origin)) {
    return json({ error: "forbidden", message: "Calls can only be made from this page." }, { status: 403 });
  }
  let component: unknown;
  try {
    ({ component } = await req.json<{ component?: unknown }>());
  } catch {
    return json({ error: "bad_request", message: 'Send JSON like {"component":"Actions"}.' }, { status: 400 });
  }

  // Only regions on the map: GitHub's live status components, plus Unlisted Territory.
  const [liveRes, roundRes] = await env.DB.batch([
    env.DB.prepare("SELECT value FROM meta WHERE key = 'live'"),
    env.DB.prepare("SELECT id FROM rounds WHERE settled_at IS NULL ORDER BY id DESC LIMIT 1"),
  ]);
  const liveRow = liveRes.results[0] as { value: string } | undefined;
  const known = new Set<string>([UNLISTED, ...((liveRow ? (JSON.parse(liveRow.value) as LiveState).components : []).map((c) => c.name))]);
  if (typeof component !== "string" || !known.has(component)) {
    return json({ error: "bad_component", message: "Pick a region on the map." }, { status: 400 });
  }
  const round = roundRes.results[0] as { id: number } | undefined;
  if (!round) return json({ error: "no_round", message: "The market isn't open yet. Try again in a minute." }, { status: 503 });

  let voter = readCookie(req, VOTER_COOKIE);
  const newVoter = !voter || !/^[0-9a-f-]{36}$/.test(voter);
  if (newVoter) voter = crypto.randomUUID();

  const network = networkOf(req.headers.get("cf-connecting-ip") ?? "unknown");
  const ipHash = await sha256(`${env.SALT ?? "wgbt-dev-salt"}:${round.id}:${network}`);

  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const [existingRes, networkRes] = await env.DB.batch([
    env.DB.prepare("SELECT component FROM picks WHERE round_id = ? AND voter = ?").bind(round.id, voter),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(created_at > ?) AS recent FROM picks WHERE round_id = ? AND ip_hash = ?").bind(
      minuteAgo,
      round.id,
      ipHash,
    ),
  ]);
  const existing = existingRes.results[0] as { component: string } | undefined;
  if (existing) {
    return json(
      { error: "already_picked", message: "You've already made your call this round.", round: round.id, component: existing.component },
      { status: 409 },
    );
  }
  const fromNetwork = networkRes.results[0] as { total: number; recent: number | null } | undefined;
  if ((fromNetwork?.recent ?? 0) >= MAX_PICKS_PER_MINUTE) {
    return json(
      { error: "slow_down", message: "Lots of calls from your network just now. Try again in a minute." },
      { status: 429 },
    );
  }
  if ((fromNetwork?.total ?? 0) >= MAX_PICKS_PER_NETWORK) {
    return json(
      { error: "network_limit", message: "Your network has made plenty of calls this round. Wait for the next one." },
      { status: 429 },
    );
  }

  await env.DB.prepare("INSERT INTO picks (round_id, voter, component, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(round.id, voter, component, ipHash, new Date().toISOString())
    .run();

  const headers = new Headers();
  if (newVoter) {
    headers.append("set-cookie", `${VOTER_COOKIE}=${voter}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  }
  return json({ ok: true, round: round.id, component }, { headers });
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/live" && req.method === "GET") return await getLive(req, env, ctx);
      if (url.pathname === "/api/history" && req.method === "GET") return await cached(req, ctx, HISTORY_TTL, () => buildHistory(env), (h) => h.almanac.length > 0);
      if (url.pathname === "/api/pick" && req.method === "POST") return await postPick(req, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: "server_error", message: "The weather station is down. Ironic." }, { status: 500 });
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sync(env));
  },
} satisfies ExportedHandler<Env>;
