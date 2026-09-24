-- Muse Nexus Witness schema v1 (docs/dev/SPEC.md §5).
-- Timestamps are integer milliseconds since the epoch (UTC).
-- Columns ending in _ct hold ciphertext (SPEC §7); nothing here stores evidence in plaintext.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  inbound_slug  TEXT NOT NULL UNIQUE,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  created_at    INTEGER NOT NULL
);

-- Envelope senders allowed to deliver inbound mail for a user (account email + added ones).
CREATE TABLE user_addresses (
  user_id      TEXT NOT NULL,
  address      TEXT NOT NULL,
  verified_at  INTEGER,
  PRIMARY KEY (user_id, address)
);
CREATE INDEX user_addresses_address ON user_addresses (address);

CREATE TABLE magic_links (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX magic_links_expires ON magic_links (expires_at);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER,
  expires_at  INTEGER
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  kind          TEXT CHECK (kind IN ('agent', 'device')),
  label         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL, -- JSON array
  created_at    INTEGER,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE items (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('saved', 'maybe', 'removed')),
  kind               TEXT NOT NULL CHECK (kind IN ('text', 'image', 'mixed')),
  quote_ct           TEXT,
  context_ct         TEXT,
  from_name_ct       TEXT,
  occurred_at        INTEGER,
  source_type        TEXT NOT NULL
    CHECK (source_type IN ('email', 'text', 'photo', 'screenshot', 'manual', 'agent', 'import')),
  source_label       TEXT NOT NULL,
  dedupe_key         TEXT NOT NULL,
  sender_key         TEXT, -- HMAC of the normalized sender handle; never plaintext
  category           TEXT NOT NULL,
  score              REAL,
  reasons            TEXT, -- JSON [{rule, weight}], no message text
  media_key          TEXT,
  media_type         TEXT,
  edited             INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_delivered_at  INTEGER,
  delivered_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, dedupe_key)
);
-- Gallery listing: newest first by when it happened (or was kept, when that is unknown).
CREATE INDEX items_user_status_sort ON items (user_id, status, (COALESCE(occurred_at, created_at)) DESC, id DESC);
CREATE INDEX items_user_sender ON items (user_id, sender_key);
CREATE INDEX items_user_created ON items (user_id, created_at);

CREATE TABLE blocked_senders (
  user_id     TEXT NOT NULL,
  sender_key  TEXT NOT NULL,
  created_at  INTEGER,
  PRIMARY KEY (user_id, sender_key)
);

CREATE TABLE rhythms (
  user_id       TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 0,
  channel       TEXT NOT NULL DEFAULT 'email',
  local_time    TEXT NOT NULL DEFAULT '08:30',
  days          TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri,sat,sun',
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  paused_until  INTEGER,
  skip_next     INTEGER NOT NULL DEFAULT 0,
  next_run_at   INTEGER,
  consented_at  INTEGER,
  updated_at    INTEGER
);
CREATE INDEX rhythms_due ON rhythms (enabled, next_run_at);

CREATE TABLE deliveries (
  id        TEXT PRIMARY KEY,
  user_id   TEXT,
  item_id   TEXT,
  channel   TEXT,
  sent_at   INTEGER,
  status    TEXT,
  feedback  TEXT
);
CREATE INDEX deliveries_user_sent ON deliveries (user_id, sent_at DESC);

CREATE TABLE offers (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  token_id     TEXT,
  item_id      TEXT,
  created_at   INTEGER,
  expires_at   INTEGER,
  revealed_at  INTEGER
);
CREATE INDEX offers_user ON offers (user_id);
CREATE INDEX offers_expires ON offers (expires_at);

-- Status only: what arrived and what happened to it. Never content.
CREATE TABLE inbound_events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  received_at  INTEGER,
  source_type  TEXT,
  outcome      TEXT CHECK (outcome IN ('saved', 'maybe', 'excluded', 'duplicate', 'confirmation', 'rejected')),
  reason       TEXT
);
CREATE INDEX inbound_events_user_received ON inbound_events (user_id, received_at DESC);

CREATE TABLE pending_confirmations (
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  url_ct       TEXT,
  code_ct      TEXT,
  received_at  INTEGER,
  PRIMARY KEY (user_id, provider)
);

-- Fixed-window counters for rate limits (auth/start, send-now). Keys are hashed; no emails.
-- Additive to SPEC §5 (it allows "a D1-backed counter").
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);
