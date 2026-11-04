-- One row per UTC day we know about.
-- verdict: 'open' (today, nothing yet), 'broke', 'held'
-- severity: 0 none, 1 hiccup (minor), 2 outage (major), 3 meltdown (critical)
CREATE TABLE days (
  day TEXT PRIMARY KEY,
  verdict TEXT NOT NULL DEFAULT 'open',
  severity INTEGER NOT NULL DEFAULT 0,
  -- First incident start for the day (ISO), when it broke.
  broke_at TEXT
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  impact TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  shortlink TEXT,
  components TEXT NOT NULL DEFAULT '[]',
  -- 1 when components were inferred from the title because GitHub tagged none.
  inferred INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX incidents_created ON incidents (created_at);

-- The market: "which part of GitHub breaks next?". A round stays open until the
-- next incident starts; that incident's components are the winning regions.
CREATE TABLE rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  settled_at TEXT,
  incident_id TEXT,
  -- JSON array of winning components ("Unlisted" when the incident named none).
  winners TEXT
);

CREATE TABLE picks (
  round_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  component TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (round_id, voter)
);
CREATE INDEX picks_ip ON picks (round_id, ip_hash);
CREATE INDEX picks_component ON picks (round_id, component);

-- Small key/value bag: launched_on, live summary, last sync.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
