// Backfills the last year of GitHub incidents into D1, beyond the 50 the live API returns.
// Usage: node scripts/backfill.mjs [--remote] [--days 365]
//
// Reads githubstatus.com/history.json (one quarter per page) for incident codes, fetches each
// incident's JSON for exact times and components, and loads them. Incidents already stored keep
// their data, except title guesses, which are refreshed so rule fixes apply to history. The next sync grades every day.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { inferComponents } from "../src/infer.ts";

const STATUS = "https://www.githubstatus.com";
const IGNORED_COMPONENTS = new Set(["Visit www.githubstatus.com for more information"]);
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const days = Number(args[args.indexOf("--days") + 1]) || 365;
const since = new Date(Date.now() - days * 86_400_000);

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "will-github-break-today backfill" } });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

// 1. Collect incident codes, newest quarter first, until we pass the cutoff.
const codes = [];
for (let page = 1; ; page++) {
  const { months } = await getJson(`${STATUS}/history.json?page=${page}`);
  if (!months?.length) break;
  for (const m of months) for (const i of m.incidents) codes.push(i.code);
  const oldest = months.at(-1);
  if (new Date(Date.UTC(oldest.year, new Date(`${oldest.name} 1, 2000`).getMonth(), 1)) < since) break;
}
console.log(`found ${codes.length} incidents in the history pages`);

// 2. Fetch each incident's details, a few at a time.
const incidents = [];
for (let i = 0; i < codes.length; i += CONCURRENCY) {
  const batch = await Promise.all(codes.slice(i, i + CONCURRENCY).map((c) => getJson(`${STATUS}/api/v2/incidents/${c}.json`)));
  for (const data of batch) {
    const inc = data.incident ?? data;
    if (new Date(inc.created_at) >= since) incidents.push(inc);
  }
  process.stdout.write(`\rfetched ${Math.min(i + CONCURRENCY, codes.length)}/${codes.length}`);
}
console.log(`\nkeeping ${incidents.length} incidents since ${since.toISOString().slice(0, 10)}`);

// 3. Write SQL and load it.
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
const rows = incidents.map((i) => {
  const tagged = (i.components ?? []).map((c) => c.name).filter((n) => !IGNORED_COMPONENTS.has(n));
  const guessed = tagged.length ? [] : inferComponents(i.name);
  const components = JSON.stringify(tagged.length ? tagged : guessed);
  return `INSERT INTO incidents (id, name, impact, status, created_at, resolved_at, shortlink, components, inferred) VALUES (${[
    q(i.id), q(i.name), q(i.impact), q(i.status), q(i.created_at), q(i.resolved_at), q(i.shortlink), q(components), guessed.length ? 1 : 0,
  ].join(", ")}) ON CONFLICT (id) DO UPDATE SET components = excluded.components, inferred = excluded.inferred WHERE incidents.inferred = 1 OR incidents.components = '[]';`;
});
mkdirSync(".wrangler", { recursive: true });
// Ask the next sync to grade every day from the oldest backfilled incident (it normally only
// re-grades the window its own fetch touches).
const oldest = incidents.reduce((min, i) => (i.created_at < min ? i.created_at : min), new Date().toISOString());
rows.push(`INSERT INTO meta (key, value) VALUES ('settle_from', ${q(oldest)}) ON CONFLICT (key) DO UPDATE SET value = MIN(value, excluded.value);`);
writeFileSync(".wrangler/backfill.sql", rows.join("\n") + "\n");
execFileSync("npx", ["wrangler", "d1", "execute", "will-github-break-today", remote ? "--remote" : "--local", "--file", ".wrangler/backfill.sql"], {
  stdio: "inherit",
});
console.log("done: the next sync (cron, or any page load) grades the new days");
