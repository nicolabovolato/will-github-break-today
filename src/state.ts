import { UNLISTED, type LiveState } from "./sync";
import { addDays, utcDay, type Env } from "./util";

interface DayRow {
  day: string;
  verdict: "open" | "broke" | "held";
  severity: number;
  broke_at: string | null;
}

interface IncidentRow {
  id: string;
  name: string;
  impact: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  shortlink: string | null;
  components: string;
  inferred: number;
}

interface RoundRow {
  id: number;
  opened_at: string;
  settled_at: string | null;
  winners: string | null;
  incident_name: string | null;
  incident_created_at: string | null;
  incident_shortlink: string | null;
  incident_impact: string | null;
}

type Incident = Omit<IncidentRow, "components"> & { components: string[] };

const DAY_MS = 86_400_000;

const parseIncidents = (rows: IncidentRow[]): Incident[] =>
  rows.map((i) => ({ ...i, components: JSON.parse(i.components) as string[] }));

/** Incidents bucketed by every UTC day they were open on (an incident can span days). */
function byDay(incidents: Incident[], now: Date) {
  const map = new Map<string, Incident[]>();
  for (const i of incidents) {
    const end = utcDay(i.resolved_at ? new Date(i.resolved_at) : now);
    for (let d = utcDay(new Date(i.created_at)); d <= end; d = addDays(d, 1)) {
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(i);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return map;
}

/**
 * The small, fast-changing payload the page polls: today, the last week, live component status
 * and the market. Every query is bounded, so its cost stays flat as history grows.
 */
export async function buildLive(env: Env, now = new Date()) {
  const today = utcDay(now);
  const weekStart = addDays(today, -6);
  const [daysRes, incidentsRes, metaRes, roundsRes, tallyRes, lastBrokeRes] = await env.DB.batch([
    env.DB.prepare("SELECT day, verdict, severity, broke_at FROM days WHERE day >= ? ORDER BY day").bind(weekStart),
    env.DB.prepare(
      `SELECT id, name, impact, status, created_at, resolved_at, shortlink, components, inferred FROM incidents
       WHERE created_at >= ? OR resolved_at IS NULL OR resolved_at >= ?`,
    ).bind(`${weekStart}T00:00:00.000Z`, `${weekStart}T00:00:00.000Z`),
    env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('live', 'synced_at')"),
    // The open round and the most recent played one, with the incident that settled it.
    env.DB.prepare(
      `SELECT r.id, r.opened_at, r.settled_at, r.winners, i.name AS incident_name, i.created_at AS incident_created_at,
              i.shortlink AS incident_shortlink, i.impact AS incident_impact
       FROM rounds r LEFT JOIN incidents i ON i.id = r.incident_id
       WHERE r.settled_at IS NULL
          OR r.id = (SELECT MAX(round_id) FROM picks WHERE round_id IN (SELECT id FROM rounds WHERE settled_at IS NOT NULL))
       ORDER BY r.id DESC`,
    ),
    env.DB.prepare(
      `SELECT round_id, component, COUNT(*) AS n FROM picks
       WHERE round_id IN (SELECT id FROM rounds WHERE settled_at IS NULL)
          OR round_id = (SELECT MAX(round_id) FROM picks WHERE round_id IN (SELECT id FROM rounds WHERE settled_at IS NOT NULL))
       GROUP BY round_id, component`,
    ),
    env.DB.prepare("SELECT MAX(day) AS day FROM days WHERE verdict = 'broke'"),
  ]);
  const days = daysRes.results as DayRow[];
  const incidents = parseIncidents(incidentsRes.results as IncidentRow[]);
  const meta = new Map((metaRes.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const live: LiveState | null = meta.has("live") ? JSON.parse(meta.get("live")!) : null;
  const perDay = byDay(incidents, now);

  const todayRow: DayRow = days.find((d) => d.day === today) ?? { day: today, verdict: "open", severity: 0, broke_at: null };

  // ---------- the "next to break" market ----------
  const tallies = new Map<number, { component: string; n: number }[]>();
  for (const t of tallyRes.results as { round_id: number; component: string; n: number }[]) {
    if (!tallies.has(t.round_id)) tallies.set(t.round_id, []);
    tallies.get(t.round_id)!.push({ component: t.component, n: t.n });
  }
  const rounds = (roundsRes.results as RoundRow[]).map((r) => {
    const tally = (tallies.get(r.id) ?? []).sort((a, b) => b.n - a.n);
    const winners = r.winners ? (JSON.parse(r.winners) as string[]) : null;
    return {
      id: r.id,
      opened_at: r.opened_at,
      settled_at: r.settled_at,
      total: tally.reduce((s, t) => s + t.n, 0),
      tally,
      winners,
      // How many picks landed on a region that actually broke.
      called: winners ? tally.filter((t) => winners.includes(t.component)).reduce((s, t) => s + t.n, 0) : 0,
      incident: r.incident_name
        ? { name: r.incident_name, created_at: r.incident_created_at, shortlink: r.incident_shortlink, impact: r.incident_impact }
        : null,
    };
  });

  // Days since last incident: 0 while anything is open or anything happened today.
  const lastBroke = (lastBrokeRes.results[0] as { day: string | null } | undefined)?.day ?? null;
  const daysSince =
    incidents.some((i) => !i.resolved_at) || todayRow.verdict === "broke"
      ? 0
      : lastBroke
        ? Math.round((Date.parse(today) - Date.parse(lastBroke)) / DAY_MS)
        : null;

  // Everything hit on a day, in the order it broke; incidents naming no component count as Unlisted.
  const hitOn = (day: string) => [...new Set((perDay.get(day) ?? []).flatMap((i) => (i.components.length ? i.components : [UNLISTED])))];

  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = addDays(today, -i);
    const d = days.find((x) => x.day === day) ?? { day, verdict: day === today ? "open" : "held", severity: 0, broke_at: null };
    week.push({ ...d, hit: d.verdict === "broke" ? hitOn(day) : [] });
  }

  return {
    now: now.toISOString(),
    syncedAt: meta.get("synced_at") ?? null,
    today: { ...todayRow, incidents: perDay.get(today) ?? [] },
    live,
    round: rounds.find((r) => !r.settled_at) ?? null,
    lastRound: rounds.find((r) => r.settled_at && r.total > 0) ?? null,
    week,
    daysSince,
  };
}

/** The slow-changing payload: every tracked day and the record. Fetched once per visit. */
export async function buildHistory(env: Env, now = new Date()) {
  const today = utcDay(now);
  const [daysRes, incidentsRes] = await env.DB.batch([
    env.DB.prepare("SELECT day, verdict, severity, broke_at FROM days ORDER BY day"),
    env.DB.prepare(
      "SELECT id, name, impact, status, created_at, resolved_at, shortlink, components, inferred FROM incidents ORDER BY created_at",
    ),
  ]);
  const days = daysRes.results as DayRow[];
  const perDay = byDay(parseIncidents(incidentsRes.results as IncidentRow[]), now);

  // Longest run of settled 'held' days.
  let longest = { length: 0, from: "", to: "" };
  let run = { length: 0, from: "" };
  for (const d of days) {
    if (d.verdict === "held") {
      run = run.length ? { length: run.length + 1, from: run.from } : { length: 1, from: d.day };
      if (run.length > longest.length) longest = { length: run.length, from: run.from, to: d.day };
    } else run = { length: 0, from: "" };
  }

  // Yearly figures cover the current calendar year only (Jan 1 to today).
  const year = today.slice(0, 4);
  const yearDays = days.filter((d) => d.day.startsWith(year));
  const componentDays = new Map<string, number>();
  for (const d of yearDays) {
    if (d.verdict !== "broke") continue;
    for (const c of new Set((perDay.get(d.day) ?? []).flatMap((i) => i.components))) {
      componentDays.set(c, (componentDays.get(c) ?? 0) + 1);
    }
  }
  const stormCapital = [...componentDays.entries()].map(([name, n]) => ({ name, days: n })).sort((a, b) => b.days - a.days)[0] ?? null;

  return {
    almanac: days.map((d) => ({
      day: d.day,
      verdict: d.verdict,
      severity: d.severity,
      incidents:
        d.verdict === "broke"
          ? (perDay.get(d.day) ?? []).map((i) => ({ name: i.name, shortlink: i.shortlink }))
          : [],
    })),
    stats: {
      longestDry: longest.length ? longest : null,
      stormCapital,
      year: Number(year),
      tracked: yearDays.length,
      broke: yearDays.filter((d) => d.verdict === "broke").length,
    },
  };
}
