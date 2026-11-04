import { inferComponents } from "./infer";
import { addDays, utcDay, type Env } from "./util";

const STATUS_API = "https://www.githubstatus.com/api/v2";

// Statuspage's catch-all component, not a real service.
const IGNORED_COMPONENTS = new Set(["Visit www.githubstatus.com for more information"]);

interface SpIncident {
  id: string;
  name: string;
  impact: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  shortlink: string;
  components: { name: string }[];
}

interface SpSummary {
  status: { indicator: string; description: string };
  components: { name: string; status: string; group: boolean }[];
}

export interface LiveState {
  indicator: string;
  description: string;
  components: { name: string; status: string }[];
  updated_at: string;
}

export function severityOf(impact: string): number {
  if (impact === "critical") return 3;
  if (impact === "major") return 2;
  return 1; // "minor" and "none" both count as a hiccup
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${STATUS_API}/${path}`, {
    headers: { "user-agent": "will-github-break-today (+https://will-github-break-today.bovolato.dev)" },
  });
  if (!res.ok) throw new Error(`githubstatus ${path}: ${res.status}`);
  return res.json<T>();
}

/** Pull GitHub's status page into D1 and settle every day it touches. */
export async function sync(env: Env, now = new Date()): Promise<void> {
  const [{ incidents }, summary] = await Promise.all([
    fetchJson<{ incidents: SpIncident[] }>("incidents.json"),
    fetchJson<SpSummary>("summary.json"),
  ]);
  const today = utcDay(now);
  const db = env.DB;
  const writes: D1PreparedStatement[] = [];

  const meta = await db.prepare("SELECT key, value FROM meta").all<{ key: string; value: string }>();
  const metaMap = new Map(meta.results.map((r) => [r.key, r.value]));
  if (!metaMap.has("launched_on")) {
    writes.push(db.prepare("INSERT INTO meta (key, value) VALUES ('launched_on', ?)").bind(today));
  }

  const live: LiveState = {
    indicator: summary.status.indicator,
    description: summary.status.description,
    components: summary.components
      .filter((c) => !c.group && !IGNORED_COMPONENTS.has(c.name))
      .map((c) => ({ name: c.name, status: c.status })),
    updated_at: now.toISOString(),
  };
  const liveKey = JSON.stringify({ ...live, updated_at: undefined });
  if (metaMap.get("live_key") !== liveKey) {
    writes.push(
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('live', ?), ('live_key', ?)").bind(JSON.stringify(live), liveKey),
    );
  }
  writes.push(db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('synced_at', ?)").bind(now.toISOString()));

  for (const i of incidents) {
    // GitHub leaves about a third of incidents untagged; place those from the title where we can.
    const tagged = i.components.map((c) => c.name).filter((n) => !IGNORED_COMPONENTS.has(n));
    const guessed = tagged.length ? [] : inferComponents(i.name);
    const components = JSON.stringify(tagged.length ? tagged : guessed);
    const inferred = guessed.length ? 1 : 0;
    writes.push(
      db
        .prepare(
          `INSERT INTO incidents (id, name, impact, status, created_at, resolved_at, shortlink, components, inferred)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, impact = excluded.impact, status = excluded.status,
             resolved_at = excluded.resolved_at, shortlink = excluded.shortlink, components = excluded.components,
             inferred = excluded.inferred
           WHERE incidents.status IS NOT excluded.status OR incidents.impact IS NOT excluded.impact
             OR incidents.resolved_at IS NOT excluded.resolved_at OR incidents.components IS NOT excluded.components
             OR incidents.name IS NOT excluded.name`,
        )
        .bind(i.id, i.name, i.impact, i.status, i.created_at, i.resolved_at, i.shortlink, components, inferred),
    );
  }
  await db.batch(writes);

  // Only re-grade days the fetched incidents can touch, unless a backfill asked for a full pass.
  const fetchedFrom = incidents.reduce((min, i) => (i.created_at < min ? i.created_at : min), now.toISOString());
  const requested = metaMap.get("settle_from");
  const from = utcDay(new Date(requested && requested < fetchedFrom ? requested : fetchedFrom));
  await settle(env, today, from);
  if (requested) await db.prepare("DELETE FROM meta WHERE key = 'settle_from'").run();
  await settleRounds(env, now);
}

export const UNLISTED = "Unlisted";

/**
 * Settle the "next to break" market. The open round ends at the first incident that
 * started after it opened; the incident's components win (or Unlisted if it names none),
 * and a new round opens at that moment. Picks filed after the incident started, before
 * the sync noticed it, roll into the new round.
 */
export async function settleRounds(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  let round: { id: number; opened_at: string } | null = await db
    .prepare("SELECT id, opened_at FROM rounds WHERE settled_at IS NULL ORDER BY id DESC LIMIT 1")
    .first<{ id: number; opened_at: string }>();
  if (!round) {
    const opened = now.toISOString();
    const res = await db.prepare("INSERT INTO rounds (opened_at) VALUES (?)").bind(opened).run();
    round = { id: Number(res.meta.last_row_id), opened_at: opened };
  }
  // Settle as many rounds as incidents have started since (usually zero or one).
  for (let guard = 0; guard < 20; guard++) {
    const next: { id: string; created_at: string; components: string } | null = await db
      .prepare("SELECT id, created_at, components FROM incidents WHERE created_at > ? ORDER BY created_at LIMIT 1")
      .bind(round.opened_at)
      .first<{ id: string; created_at: string; components: string }>();
    if (!next) return;
    const named = JSON.parse(next.components) as string[];
    const winners = JSON.stringify(named.length ? named : [UNLISTED]);
    const opened: D1Result = await db.prepare("INSERT INTO rounds (opened_at) VALUES (?)").bind(next.created_at).run();
    const newId: number = Number(opened.meta.last_row_id);
    await db.batch([
      db.prepare("UPDATE rounds SET settled_at = ?, incident_id = ?, winners = ? WHERE id = ?").bind(
        now.toISOString(),
        next.id,
        winners,
        round.id,
      ),
      db.prepare("UPDATE picks SET round_id = ? WHERE round_id = ? AND created_at >= ?").bind(newId, round.id, next.created_at),
    ]);
    round = { id: newId, opened_at: next.created_at };
  }
}

/**
 * Recompute verdicts from stored incidents for days from `from` to today. An incident counts for
 * every UTC day it was open, so one that started last night and is still burning breaks today too.
 */
export async function settle(env: Env, today: string, from: string): Promise<void> {
  const db = env.DB;
  const since = `${from}T00:00:00.000Z`;
  const [{ results: incidents }, { results: days }] = await Promise.all([
    db
      .prepare("SELECT impact, created_at, resolved_at FROM incidents WHERE created_at >= ? OR resolved_at IS NULL OR resolved_at >= ?")
      .bind(since, since)
      .all<{
      impact: string;
      created_at: string;
      resolved_at: string | null;
    }>(),
    db.prepare("SELECT day, verdict, severity, broke_at FROM days WHERE day >= ?").bind(from).all<{
      day: string;
      verdict: string;
      severity: number;
      broke_at: string | null;
    }>(),
  ]);

  const broken = new Map<string, { severity: number; broke_at: string }>();
  const first = from;
  for (const i of incidents) {
    const start = utcDay(new Date(i.created_at));
    const end = i.resolved_at ? utcDay(new Date(i.resolved_at)) : today;
    for (let d = start; d <= end && d <= today; d = addDays(d, 1)) {
      const prev = broken.get(d);
      // The day "broke at" the first moment anything was down that day.
      const at = d === start ? i.created_at : `${d}T00:00:00.000Z`;
      broken.set(d, {
        severity: Math.max(prev?.severity ?? 0, severityOf(i.impact)),
        broke_at: prev && prev.broke_at < at ? prev.broke_at : at,
      });
    }
  }

  const existing = new Map(days.map((d) => [d.day, d]));
  const writes: D1PreparedStatement[] = [];
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const b = broken.get(d);
    const verdict = b ? "broke" : d < today ? "held" : "open";
    const severity = b?.severity ?? 0;
    const broke_at = b?.broke_at ?? null;
    const cur = existing.get(d);
    if (cur && cur.verdict === verdict && cur.severity === severity && cur.broke_at === broke_at) continue;
    writes.push(
      db
        .prepare(
          `INSERT INTO days (day, verdict, severity, broke_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (day) DO UPDATE SET verdict = excluded.verdict, severity = excluded.severity, broke_at = excluded.broke_at`,
        )
        .bind(d, verdict, severity, broke_at),
    );
  }
  if (writes.length) await db.batch(writes);
}
