// WGBT Outage Forecast: map, radar, and the daily market.

const W = 1000;
const UNLISTED = "Unlisted";
const H = 520;
// Poll fast only while something is happening; history barely changes.
const LIVE_MS = 20_000;
const QUIET_MS = 90_000;
const HISTORY_MS = 10 * 60_000;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Geography of GitHub country ----------
// The continent: terrain is pre-rendered by scripts/render-map.mjs into /map/terrain.webp
// (1000 x 520 map units). Province seeds here must match SEEDS in that script.
// Provinces follow the cat's anatomy. x/y is where the label's marker sits (on the province);
// text runs right by default, or left for align: "left". ex/ey is where the province's radar
// echo forms, next to its label. Areas must match scripts/render-map.mjs.
const REGIONS = [
  { component: "Copilot", title: "Copilot", name: "Copilot Peak", short: "Copilot", x: 330, y: 80, align: "left", ex: 342, ey: 84 },
  { component: "Copilot AI Model Providers", title: "AI Models", name: "Model Providers Peak", short: "Models", x: 668, y: 100, ex: 670, ey: 98 },
  { component: "Git Operations", title: "Git", name: "Git Operations Highlands", short: "Git", x: 448, y: 64, ex: 520, ey: 70 },
  { component: "API Requests", title: "API", name: "API Requests Coast", short: "API", x: 296, y: 238, align: "left", ex: 312, ey: 232 },
  { component: "Webhooks", title: "Webhooks", name: "Webhooks Fjords", short: "Webhooks", x: 700, y: 214, ex: 704, ey: 222 },
  { component: "Pull Requests", title: "Pull Requests", name: "Pull Requests Dunes", short: "PRs", x: 420, y: 284, ex: 470, ey: 270 },
  { component: "Actions", title: "Actions", name: "Actions Basin", short: "Actions", x: 468, y: 372, ex: 515, ey: 372 },
  { component: "Issues", title: "Issues", name: "Issues Swamp", short: "Issues", x: 236, y: 360, ex: 285, ey: 362 },
  { component: "Codespaces", title: "Codespaces", name: "Codespaces Cove", short: "Codespaces", x: 288, y: 462, ex: 340, ey: 456 },
  { component: "Pages", title: "Pages", name: "Pages Point", short: "Pages", x: 646, y: 448, ex: 690, ey: 444 },
  { component: "Packages", title: "Packages", name: "Packages Bay", short: "Packages", x: 716, y: 362, ex: 765, ey: 364 },
  // Incidents that name no component wash up here.
  { component: UNLISTED, title: "Unlisted", name: "Unlisted Territory", short: "Unlisted", x: 84, y: 150, ex: 120, ey: 150 },
];
const LANDMARKS = [
  { name: "Lake Push", x: 437, y: 185, cls: "lake" },
  { name: "Lake Pull", x: 563, y: 185, cls: "lake" },
  { name: "Mt. Incident", x: 500, y: 258, cls: "landmark" },
];
const NOSE = { x: 500, y: 234 };
const STATION = { x: 500, y: 312 };

const svgNS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function drawMap() {
  const svg = document.getElementById("map-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Graticule on the water, like any honest weather map; the terrain's open sea is transparent.
  const grid = el("g", { stroke: token("--sea-line"), "stroke-width": "1", opacity: "0.55" });
  // Drawn well past the country so wide or tall frames never run out of sea.
  for (let x = -2000; x <= W + 2000; x += 100) grid.append(el("line", { x1: x, y1: -2000, x2: x, y2: H + 2000 }));
  for (let y = -1980; y <= H + 2000; y += 100) grid.append(el("line", { x1: -2000, y1: y, x2: W + 2000, y2: y }));
  svg.append(grid);
  svg.append(el("image", { href: "/map/terrain.webp", x: 0, y: 0, width: W, height: H }));
}

// Map-space → element pixels. The whole country (every province) always fits in the
// part of the frame the lower third does not cover; the sea fills whatever is left.
const BAND = { x0: 55, x1: 945, y0: 0, y1: 505 };
function mapTransform(box) {
  const lower = document.getElementById("lower");
  const overlap = Math.max(0, -parseFloat(getComputedStyle(lower).marginTop) || 0);
  // Keep the ear tips clear of the radar key on phones.
  const top = box.width < 640 ? 34 : 0;
  const usable = box.height - overlap - top;
  const s = Math.min(box.width / (BAND.x1 - BAND.x0), usable / (BAND.y1 - BAND.y0));
  return {
    s,
    ox: box.width / 2 - ((BAND.x0 + BAND.x1) / 2) * s,
    oy: top + usable / 2 - ((BAND.y0 + BAND.y1) / 2) * s,
  };
}
function fitSvg(box) {
  const { s, ox, oy } = mapTransform(box);
  document.getElementById("map-svg").setAttribute("viewBox", `${-ox / s} ${-oy / s} ${box.width / s} ${box.height / s}`);
}

// ---------- Region labels ----------
const STATUS_SEV = { operational: 0, under_maintenance: 0, degraded_performance: 1, partial_outage: 2, major_outage: 3 };
const STATUS_WORD = {
  operational: "operational", under_maintenance: "under maintenance",
  degraded_performance: "degraded performance", partial_outage: "partial outage", major_outage: "major outage",
};
let liveByComponent = new Map();
let selectedRegion = null;

function placeLabels() {
  const map = document.getElementById("map");
  const box = map.getBoundingClientRect();
  const { s, ox, oy } = mapTransform(box);
  const narrow = box.width < 640;
  const layer = document.getElementById("map-labels");
  if (!layer.childElementCount) {
    for (const r of REGIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "region";
      b.dataset.component = r.component;
      b.innerHTML = `<i></i><span class="place"></span>`;
      b.addEventListener("click", () => selectRegion(r));
      layer.append(b);
    }
  }
  if (!layer.querySelector(".landmark-label")) {
    for (const l of LANDMARKS) {
      const span = document.createElement("span");
      span.className = `landmark-label ${l.cls}`;
      span.textContent = l.name;
      span.setAttribute("aria-hidden", "true");
      layer.append(span);
    }
  }
  layer.querySelectorAll(".landmark-label").forEach((span, i) => {
    span.style.left = `${ox + LANDMARKS[i].x * s}px`;
    span.style.top = `${oy + LANDMARKS[i].y * s}px`;
    span.hidden = narrow;
  });
  for (const b of layer.querySelectorAll(".region")) {
    const r = REGIONS.find((x) => x.component === b.dataset.component);
    const x = ox + r.x * s, y = oy + r.y * s;
    const visible = x > 30 && x < box.width - 30 && y > 20 && y < box.height - 20;
    b.hidden = !visible;
    b.dataset.align = r.align ?? "right";
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.querySelector(".place").textContent = narrow ? r.short : r.name;
    const status = liveByComponent.get(r.component) ?? "operational";
    b.dataset.sev = STATUS_SEV[status] ?? 0;
    const mine = myPick() === r.component;
    b.classList.toggle("mine", mine);
    b.setAttribute("aria-label", `${r.name}: ${r.component}, ${STATUS_WORD[status] ?? status}${mine ? ", your call" : ""}`);
    b.setAttribute("aria-pressed", String(selectedRegion === r));
  }
}

// Selecting a region opens its plate on the map: status, crowd share, and the call button.
function selectRegion(r) {
  selectedRegion = selectedRegion === r ? null : r;
  renderCaption();
  placeLabels();
}

function renderCaption() {
  const cap = document.getElementById("map-caption");
  const r = selectedRegion;
  if (!r) {
    cap.hidden = true;
    cap.innerHTML = "";
    return;
  }
  const status = liveByComponent.get(r.component) ?? "operational";
  const round = state?.round;
  const share = round?.total ? Math.round((100 * (round.tally.find((t) => t.component === r.component)?.n ?? 0)) / round.total) : null;
  const mine = myPick();
  let action = "";
  if (!round) action = `<span class="cap-note">The market opens shortly.</span>`;
  else if (mine === r.component) action = `<span class="cap-note">Your call this round.</span>`;
  else if (mine) action = `<span class="cap-note">You already called ${escapeHtml(regionName(mine))} this round.</span>`;
  else action = `<button type="button" class="call-btn" data-component="${escapeHtml(r.component)}">Call it: ${escapeHtml(r.short)} breaks next</button>`;
  cap.hidden = false;
  cap.innerHTML = `<p><b>${escapeHtml(r.name)}</b> · ${STATUS_WORD[status] ?? status}${share !== null ? ` · ${share}% of calls` : ""}</p>${action}`;
}

// ---------- Radar ----------
// Echoes are computed on a coarse grid and quantised to the severity ramp,
// so they read as radar returns rather than soft gradients.
const RAMP = [null, [63, 191, 79], [240, 165, 42], [196, 63, 208]];
const CELL = 7;

function hash(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const radar = {
  canvas: null, ctx: null, echoes: [], t: 0, sweep: 0, last: 0, frame: 0,

  init() {
    this.canvas = document.getElementById("radar");
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    new ResizeObserver(() => { this.resize(); placeLabels(); this.draw(); }).observe(document.getElementById("map"));
    if (!reduceMotion) requestAnimationFrame((ts) => this.loop(ts));
  },

  resize() {
    const box = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.box = box;
    this.dpr = dpr;
    fitSvg(box);
  },

  setEchoes(live) {
    this.echoes = [];
    for (const r of REGIONS) {
      const sev = STATUS_SEV[live.get(r.component)] ?? 0;
      if (sev) this.echoes.push({ x: r.ex, y: r.ey, sev, seed: r.ex * 7 + r.ey });
    }
    this.draw();
  },

  loop(ts) {
    // Radar sweeps continuously; echoes refresh in hard steps, about 6 times a second.
    const dt = Math.min(ts - (this.last || ts), 100);
    this.last = ts;
    this.sweep = (this.sweep + dt * 0.0011) % (Math.PI * 2);
    if (++this.frame % 10 === 0) this.t += 0.08;
    this.draw();
    requestAnimationFrame((t) => this.loop(t));
  },

  draw() {
    const { ctx, canvas } = this;
    if (!ctx) return;
    const { s, ox, oy } = mapTransform(this.box);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * ox, this.dpr * oy);

    // Echoes
    for (const e of this.echoes) {
      const reach = 38 + e.sev * 20;
      for (let gx = e.x - reach; gx < e.x + reach; gx += CELL) {
        for (let gy = e.y - reach; gy < e.y + reach; gy += CELL) {
          const dx = gx - e.x, dy = gy - e.y;
          const dist = Math.sqrt(dx * dx + dy * dy) / reach;
          if (dist > 1) continue;
          const n = noise(gx * 0.025 + e.seed + this.t, gy * 0.025 - this.t * 0.6);
          const v = (1 - dist) * 1.35 + (n - 0.5) * 0.8;
          if (v < 0.3) continue;
          const level = Math.min(e.sev, v > 0.95 ? 3 : v > 0.62 ? 2 : 1);
          const [r, g, b] = RAMP[level];
          // Phosphor: returns brighten as the sweep passes over them.
          let ang = Math.atan2(gy - STATION.y, gx - STATION.x) - this.sweep;
          ang = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          const glow = reduceMotion ? 0.85 : 0.62 + 0.38 * Math.max(0, 1 - ang / 2.2);
          ctx.fillStyle = `rgba(${r},${g},${b},${glow})`;
          ctx.fillRect(gx, gy, CELL - 1, CELL - 1);
        }
      }
    }

    // Radar site: faint range rings and a crosshair, so the origin never reads as a place.
    ctx.strokeStyle = "rgba(190, 255, 200, 0.22)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 6]);
    for (const r of [110, 220, 330]) {
      ctx.beginPath();
      ctx.arc(STATION.x, STATION.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(190, 255, 200, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(STATION.x - 9, STATION.y); ctx.lineTo(STATION.x + 9, STATION.y);
    ctx.moveTo(STATION.x, STATION.y - 9); ctx.lineTo(STATION.x, STATION.y + 9);
    ctx.stroke();
    ctx.fillStyle = "rgba(190, 255, 200, 0.9)";
    ctx.beginPath();
    ctx.arc(STATION.x, STATION.y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    if (reduceMotion) return;
    // Sweep arm with a short stepped trail.
    const R = 760;
    for (let i = 0; i < 6; i++) {
      const a = this.sweep - i * 0.06;
      ctx.strokeStyle = `rgba(190, 255, 200, ${0.5 - i * 0.08})`;
      ctx.lineWidth = i === 0 ? 2.5 : 2;
      ctx.beginPath();
      ctx.moveTo(STATION.x, STATION.y);
      ctx.lineTo(STATION.x + Math.cos(a) * R, STATION.y + Math.sin(a) * R);
      ctx.stroke();
    }
  },
};

// ---------- Formatting ----------
// Day grades use GitHub's own impact levels.
const SEV_WORD = ["No incident", "Minor", "Major", "Critical"];
const fmtInt = new Intl.NumberFormat("en");
const fmtTime = (iso) => new Date(iso).toISOString().slice(11, 16);
const weekday = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" });
const longDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shortDateYear = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const shortDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
const plural = (n, one, many = one + "s") => `${fmtInt.format(n)} ${n === 1 ? one : many}`;
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function listNames(names, max = 2) {
  if (!names.length) return "an unlisted service";
  if (names.length <= max) return names.join(" and ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}
const regionName = (component) => REGIONS.find((r) => r.component === component)?.name ?? component;
const iconFor = (d) => (d.verdict === "broke" ? ["", "drizzle", "storm", "tornado"][d.severity] : d.verdict === "held" ? "sun" : "unknown");

// ---------- Local memory of your calls, per round ----------
const store = {
  get(round) { try { return localStorage.getItem(`wgbt:round:${round}`); } catch { return null; } },
  set(round, component) { try { localStorage.setItem(`wgbt:round:${round}`, component); } catch {} },
};
const myPick = () => (state?.round ? store.get(state.round.id) : null);
const shortName = (component) => REGIONS.find((r) => r.component === component)?.short ?? component;

// ---------- Render ----------
let state = null;

function render() {
  const round = state.round;
  const tally = round?.tally ?? [];
  const total = round?.total ?? 0;
  const mine = myPick();

  // Outlook tag: the crowd's favourite to break next.
  const value = document.getElementById("outlook-value");
  if (total) {
    document.getElementById("outlook-label").textContent = "Most called";
    value.textContent = REGIONS.find((r) => r.component === tally[0].component)?.title ?? tally[0].component;
    document.getElementById("outlook-unit").textContent = `${Math.round((100 * tally[0].n) / total)}% of ${plural(total, "call")}`;
  } else {
    document.getElementById("outlook-label").textContent = "Next to break";
    value.textContent = "?";
    document.getElementById("outlook-unit").textContent = "No calls yet";
  }
  value.classList.toggle("word", value.textContent.length > 4);
  value.classList.toggle("long", value.textContent.length > 9);

  // Desk copy
  const sub = document.getElementById("outlook-sub");
  const since = round ? ` Round open since ${fmtTime(round.opened_at)} UTC.` : "";
  sub.textContent = mine
    ? `Your call: ${regionName(mine)}. It settles at GitHub's next incident.${since}`
    : `Tap a region on the map to make your call. One call per round; the round ends at GitHub's next incident.${since}`;

  // Top picks
  const list = document.getElementById("tally");
  list.hidden = !total;
  list.innerHTML = tally.slice(0, 3).map((t) => {
    const p = Math.round((100 * t.n) / total);
    return `<li${t.component === mine ? ` class="mine"` : ""}><span>${escapeHtml(regionName(t.component))}</span><i style="--p: ${p}%"></i><b>${p}%</b></li>`;
  }).join("");

  // How the last round went.
  const note = document.getElementById("bet-note");
  note.classList.remove("error");
  const last = state.lastRound;
  if (last) {
    const hit = last.winners.map(regionName);
    const share = Math.round((100 * last.called) / last.total);
    const yours = store.get(last.id);
    const verdict = yours ? (last.winners.includes(yours) ? " You called it." : ` You had ${regionName(yours)}.`) : "";
    const when = last.incident ? ` at ${fmtTime(last.incident.created_at)} UTC` : "";
    note.textContent = `Last round: ${listNames(hit)} broke${when}. ${share}% of ${plural(last.total, "call")} saw it coming.${verdict}`;
  } else {
    note.textContent = "";
  }

  renderLive();
  renderWeek();
  keepTodayInView();
  renderRecord();
  renderReports();
  renderAlmanac();
}

function renderLive() {
  liveByComponent = new Map((state.live?.components ?? []).map((c) => [c.name, c.status]));
  // Open incidents that name no component show up over Unlisted Territory.
  const IMPACT_STATUS = { critical: "major_outage", major: "partial_outage" };
  const unlisted = state.today.incidents.filter((i) => !i.resolved_at && !i.components.length);
  if (unlisted.length) {
    const worst = unlisted.map((i) => IMPACT_STATUS[i.impact] ?? "degraded_performance").sort((a, b) => STATUS_SEV[b] - STATUS_SEV[a])[0];
    liveByComponent.set(UNLISTED, worst);
  }
  // Local preview: ?simulate=outage lights up every province with mixed severities.
  if (location.hostname === "localhost" && new URLSearchParams(location.search).get("simulate") === "outage") {
    const mix = ["degraded_performance", "partial_outage", "major_outage"];
    liveByComponent = new Map(REGIONS.map((r, i) => [r.component, mix[(i * 2 + 1) % 3]]));
  }
  radar.setEchoes(liveByComponent);
  placeLabels();
  renderCaption();

  const stale = !state.syncedAt || Date.now() - Date.parse(state.syncedAt) > 15 * 60_000;
  document.getElementById("radar-live").classList.toggle("stale", stale);

  const crawl = document.getElementById("crawl");
  const track = document.getElementById("crawl-track");
  const open = state.today.incidents.filter((i) => !i.resolved_at);
  const affected = (state.live?.components ?? []).filter((c) => (STATUS_SEV[c.status] ?? 0) > 0);
  if (open.length || affected.length) {
    crawl.classList.add("live");
    const parts = open.map((i) => `${escapeHtml(i.name)} (${escapeHtml(i.status)}, since ${fmtTime(i.created_at)} UTC)`);
    const regions = affected.map((c) => `${regionName(c.name).toUpperCase()}: ${STATUS_WORD[c.status] ?? c.status}`);
    const text = [...parts, ...regions, "Do not re-run your jobs", "Stay away from the merge button"].join(" · ");
    // Two identical runs so the loop is seamless and the warning is readable on the first frame.
    const run = `<span class="tag">Severe outage warning</span>${text} · source: githubstatus.com`;
    track.innerHTML = `<span class="crawl-run">${run}</span><span class="crawl-run" aria-hidden="true">${run}</span>`;
    crawl.style.setProperty("--crawl-duration", `${Math.max(25, text.length / 6)}s`);
  } else {
    crawl.classList.remove("live");
    track.textContent = "No watches or warnings in effect. All GitHub regions reporting normal. For now.";
  }
}

function renderWeek() {
  const ol = document.getElementById("week");
  ol.innerHTML = state.week.map((d) => {
    const isToday = d.day === state.today.day;
    const verdict = d.verdict === "broke" ? SEV_WORD[d.severity] : d.verdict === "held" ? "No incident" : "Nothing yet";
    const verdictShort = d.verdict === "broke" ? SEV_WORD[d.severity] : d.verdict === "held" ? "None" : "–";
    const sevClass = d.verdict === "broke" ? `sev-${d.severity}` : d.verdict === "held" ? "sev-0" : "sev-open";
    // Everything that broke, shortened to fit the tile; phones get the count.
    const names = d.hit.map(shortName);
    const crowd = names.length ? (names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ")) : d.verdict === "held" ? "All quiet" : "Nothing yet";
    const crowdShort = names.length ? `${names.length} hit` : "–";
    return `<li class="day${isToday ? " today" : ""}" aria-label="${longDate(d.day)}: ${verdict}. ${crowd}.">
      <span class="day-name">${isToday ? "Today" : weekday(d.day)}</span>
      <svg aria-hidden="true"><use href="#i-${iconFor(d)}"/></svg>
      <span class="day-verdict"><i class="${sevClass}"></i><span class="long">${verdict}</span><span class="short" aria-hidden="true">${verdictShort}</span></span>
      <span class="day-crowd"><span class="long">${escapeHtml(crowd)}</span><span class="short" aria-hidden="true">${escapeHtml(crowdShort)}</span></span>
    </li>`;
  }).join("");
}

function keepTodayInView() {
  // On very narrow screens the strip scrolls; start at today, not last Thursday.
  const ol = document.getElementById("week");
  ol.scrollLeft = ol.scrollWidth;
}

function renderRecord() {
  const { daysSince } = state;
  const { longestDry, stormCapital, tracked, broke, year } = state.stats;
  const weekBroke = state.week.filter((d) => d.verdict === "broke").length;
  const num = document.getElementById("days-since");
  num.textContent = daysSince ?? "–";
  num.dataset.digits = String(Math.min(3, String(daysSince ?? "–").length));
  document.getElementById("days-since-tail").textContent = daysSince === 1 ? "day without a GitHub incident" : "days without a GitHub incident";
  const facts = [
    ["Longest streak without an incident", longestDry ? `${plural(longestDry.length, "day")}` : "Not a single day yet", longestDry ? `${shortDateYear(longestDry.from)} to ${shortDateYear(longestDry.to)}` : ""],
    [`Outage capital of ${year}`, stormCapital ? regionName(stormCapital.name) : "Undecided", stormCapital ? `${stormCapital.name} was hit on ${plural(stormCapital.days, "day")}` : "Nothing has broken yet this year"],
    [`Days with an incident in ${year}`, `${fmtInt.format(broke)} of ${fmtInt.format(tracked)}`, tracked ? `${Math.round((100 * broke) / tracked)}% of the year so far` : ""],
    ["This week", `${weekBroke} of 7 days broke`, weekBroke === 7 ? "A perfect week, the wrong way round" : weekBroke ? "" : "Suspiciously quiet"],
  ];
  document.getElementById("facts").innerHTML = facts
    .map(([k, v, s]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}${s ? `<small>${escapeHtml(s)}</small>` : ""}</dd></div>`)
    .join("");
}

function renderReports() {
  const ol = document.getElementById("reports");
  const list = state.today.incidents;
  if (!list.length) {
    ol.innerHTML = `<li class="reports-empty">No incidents today. Suspicious.</li>`;
    return;
  }
  ol.innerHTML = list.map((i) => {
    const sev = { critical: 3, major: 2 }[i.impact] ?? 1;
    const chip = i.resolved_at ? `<span class="chip sev-${sev}">${SEV_WORD[sev]}</span>` : `<span class="chip live">Live</span>`;
    const where = i.components.length
      ? `${i.components.map(regionName).join(", ")}${i.inferred ? " (guessed from the title)" : ""}`
      : "Unlisted Territory";
    const when = i.resolved_at ? `Resolved at ${fmtTime(i.resolved_at)} UTC` : `Status: ${i.status}`;
    return `<li class="report">
      <time datetime="${i.created_at}">${fmtTime(i.created_at)}</time>
      <h3>${chip}${escapeHtml(i.name)}</h3>
      ${i.shortlink ? `<a href="${escapeHtml(i.shortlink)}" rel="noopener">Full report</a>` : "<span></span>"}
      <p>${escapeHtml(where)} · ${when}</p>
    </li>`;
  }).join("");
}

// History stays a fixed size: a year grid (weeks × weekdays, like a contribution graph) on
// desktop, one month at a time on phones. Both page through time with ‹ ›.
let pickedDay = null;
let almanacYear = null;
let almanacMonth = null; // "YYYY-MM"
const phone = matchMedia("(max-width: 640px)");
const ymd = (date) => date.toISOString().slice(0, 10);
const dayOfWeek = (date) => (date.getUTCDay() + 6) % 7; // Monday = 0

function almanacCell(day, byDay, extra = "") {
  const d = byDay.get(day);
  if (!d) return `<span class="cell blank${extra}" aria-hidden="true"></span>`;
  const verdict = d.verdict === "broke" ? `${SEV_WORD[d.severity]} incident` : d.verdict === "held" ? "No incident" : "Nothing yet";
  return `<button type="button" class="cell${extra}" data-day="${d.day}" ${d.verdict === "broke" ? `data-sev="${d.severity}"` : ""} ${d.verdict === "open" ? "data-open" : ""} aria-pressed="${pickedDay === d.day}" aria-label="${longDate(d.day)}: ${verdict}"></button>`;
}

function almanacNav(label, canBack, canForward) {
  return `<div class="alm-nav">
    <button type="button" data-step="-1" ${canBack ? "" : "disabled"} aria-label="Earlier">‹</button>
    <span aria-live="polite">${label}</span>
    <button type="button" data-step="1" ${canForward ? "" : "disabled"} aria-label="Later">›</button>
  </div>`;
}

function renderAlmanac() {
  const byDay = new Map(state.almanac.map((d) => [d.day, d]));
  const first = state.almanac[0]?.day ?? state.today.day;
  const last = state.today.day;
  const out = document.getElementById("almanac");

  if (phone.matches) {
    almanacMonth ??= last.slice(0, 7);
    const [y, mo] = almanacMonth.split("-").map(Number);
    const start = new Date(Date.UTC(y, mo - 1, 1));
    const len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const label = start.toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" });
    let cells = ["M", "T", "W", "T", "F", "S", "S"].map((w) => `<span class="wd" aria-hidden="true">${w}</span>`).join("");
    for (let i = 1; i <= len; i++) {
      cells += almanacCell(ymd(new Date(Date.UTC(y, mo - 1, i))), byDay, i === 1 ? " first" : "");
    }
    out.innerHTML = `${almanacNav(label, almanacMonth > first.slice(0, 7), almanacMonth < last.slice(0, 7))}
      <div class="month-days" style="--start: ${dayOfWeek(start) + 1}">${cells}</div>`;
  } else {
    almanacYear ??= Number(last.slice(0, 4));
    const jan1 = new Date(Date.UTC(almanacYear, 0, 1));
    const lead = dayOfWeek(jan1);
    const daysInYear = (Date.UTC(almanacYear + 1, 0, 1) - jan1.getTime()) / 86_400_000;
    const weeks = Math.ceil((lead + daysInYear) / 7);
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<span class="cell pad" aria-hidden="true"></span>`;
    let months = "";
    for (let i = 0; i < daysInYear; i++) {
      const date = new Date(jan1.getTime() + i * 86_400_000);
      cells += almanacCell(ymd(date), byDay);
      if (date.getUTCDate() === 1) {
        const col = Math.floor((lead + i) / 7) + 1;
        months += `<span style="grid-column: ${col}">${date.toLocaleDateString("en", { month: "short", timeZone: "UTC" })}</span>`;
      }
    }
    out.innerHTML = `${almanacNav(String(almanacYear), almanacYear > Number(first.slice(0, 4)), almanacYear < Number(last.slice(0, 4)))}
      <div class="year" style="--weeks: ${weeks}">
        <div class="year-months" aria-hidden="true">${months}</div>
        <div class="year-wd" aria-hidden="true"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span></span></div>
        <div class="year-days">${cells}</div>
      </div>`;
  }
  if (pickedDay) showDay(pickedDay);
}
phone.addEventListener("change", () => state && renderAlmanac());

function showDay(day) {
  pickedDay = day;
  const d = state.almanac.find((x) => x.day === day);
  for (const c of document.querySelectorAll(".cell[data-day]")) c.setAttribute("aria-pressed", String(c.dataset.day === day));
  const out = document.getElementById("almanac-detail");
  if (!d) return;
  if (d.verdict === "broke") {
    const reports = d.incidents.map((i) => i.shortlink ? `<a href="${escapeHtml(i.shortlink)}" rel="noopener">${escapeHtml(i.name)}</a>` : escapeHtml(i.name)).join("; ");
    out.innerHTML = `<b>${longDate(d.day)}: ${SEV_WORD[d.severity]} incident.</b> ${reports}.`;
  } else if (d.verdict === "held") {
    out.innerHTML = `<b>${longDate(d.day)}: No incident.</b> GitHub held all day.`;
  } else {
    out.innerHTML = `<b>${longDate(d.day)}: Still open.</b> Nothing yet.`;
  }
}

function stepAlmanac(step) {
  if (phone.matches) {
    const [y, m] = almanacMonth.split("-").map(Number);
    almanacMonth = ymd(new Date(Date.UTC(y, m - 1 + step, 1))).slice(0, 7);
  } else {
    almanacYear += step;
  }
  renderAlmanac();
}

document.getElementById("almanac").addEventListener("click", (e) => {
  const nav = e.target.closest("[data-step]");
  if (nav && !nav.disabled) return stepAlmanac(Number(nav.dataset.step));
  const cell = e.target.closest(".cell[data-day]");
  if (cell) showDay(cell.dataset.day);
});

// Swipe between months on phones.
let swipeX = null;
document.getElementById("almanac").addEventListener("touchstart", (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
document.getElementById("almanac").addEventListener("touchend", (e) => {
  if (swipeX === null || !phone.matches) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) < 50) return;
  const btn = document.querySelector(`#almanac [data-step="${dx < 0 ? 1 : -1}"]`);
  if (btn && !btn.disabled) stepAlmanac(dx < 0 ? 1 : -1);
});

// Tapping the terrain selects the nearest province, so the whole map is the betting slip.
document.getElementById("map").addEventListener("click", (e) => {
  if (e.target.closest(".region, .map-caption, .radar-key")) return;
  const box = document.getElementById("map").getBoundingClientRect();
  const { s, ox, oy } = mapTransform(box);
  const mx = (e.clientX - box.left - ox) / s, my = (e.clientY - box.top - oy) / s;
  let best = null, bestD = 90;
  for (const r of REGIONS) {
    const d = Math.hypot(mx - r.ex, my - r.ey);
    if (d < bestD) { bestD = d; best = r; }
  }
  if (best) selectRegion(best);
});

// ---------- Making a call ----------
document.getElementById("map-caption").addEventListener("click", async (e) => {
  const btn = e.target.closest(".call-btn");
  if (!btn || !state?.round) return;
  const component = btn.dataset.component;
  btn.disabled = true;
  btn.textContent = "Filing your call…";
  const note = document.getElementById("bet-note");
  try {
    const res = await fetch("/api/pick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ component }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok || body.error === "already_picked") {
      const picked = body.component ?? component;
      store.set(body.round ?? state.round.id, picked);
      if (res.ok) {
        const row = state.round.tally.find((t) => t.component === picked);
        if (row) row.n++;
        else state.round.tally.push({ component: picked, n: 1 });
        state.round.tally.sort((a, b) => b.n - a.n);
        state.round.total++;
      }
      render();
    } else {
      render();
      note.classList.add("error");
      note.textContent = body.message ?? "The forecast desk didn't answer. Try again.";
    }
  } catch {
    render();
    note.classList.add("error");
    note.textContent = "Lost the signal while filing. Check your connection and try again.";
  }
});

// ---------- Clock + data ----------
function tick() {
  document.getElementById("clock").textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
  // Roll the day's verdicts over at midnight UTC.
  if (state && !loading && new Date().toISOString().slice(0, 10) !== state.today.day) load();
}

let retry = 0;
let loading = false;
let history = null;
let historyAt = 0;
let timer = null;

const incidentLive = () => !!state && (state.today.incidents.some((i) => !i.resolved_at) || (state.live?.components ?? []).some((c) => (STATUS_SEV[c.status] ?? 0) > 0));

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => (document.hidden ? schedule(ms) : load()), ms);
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const needHistory = !history || Date.now() - historyAt > HISTORY_MS;
    const [liveRes, historyRes] = await Promise.all([
      fetch("/api/live", { cache: "no-store" }),
      needHistory ? fetch("/api/history") : null,
    ]);
    if (!liveRes.ok || (historyRes && !historyRes.ok)) throw new Error("bad response");
    if (historyRes) {
      history = await historyRes.json();
      historyAt = Date.now();
    }
    state = { ...(await liveRes.json()), ...history };
    retry = 0;
    document.getElementById("radar-live").classList.remove("lost");
    render();
    schedule(incidentLive() ? LIVE_MS : QUIET_MS);
  } catch {
    retry++;
    // Keep showing the last good data; just say the feed dropped.
    if (state) document.getElementById("radar-live").classList.add("lost");
    else document.getElementById("outlook-sub").textContent = "Signal lost. Retrying…";
    schedule(Math.min(QUIET_MS, 2000 * 2 ** retry));
  } finally {
    loading = false;
  }
}

drawMap();
radar.init();
placeLabels();
tick();
setInterval(tick, 1000);
load();
// Back from a background tab: refresh at once rather than waiting for the next tick.
document.addEventListener("visibilitychange", () => { if (!document.hidden && !loading) load(); });
