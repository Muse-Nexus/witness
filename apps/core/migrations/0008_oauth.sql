-- OAuth 2.1 for the remote MCP server (SPEC §9), so apps that only speak OAuth
-- (the claude.ai and Claude apps) can connect. The access token an app receives is
-- an ordinary assistant key (a row in `tokens`), so it shows in Settings and is
-- disconnected the same way. Only hashes of codes are stored.

-- Apps that registered themselves (RFC 7591). Public clients only: no secrets.
CREATE TABLE oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL, -- JSON array of exact URIs
  created_at     INTEGER NOT NULL
);

-- One-use authorization codes, bound to the app, the redirect and the PKCE challenge.
CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scopes          TEXT NOT NULL, -- JSON array
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);
CREATE INDEX oauth_codes_user ON oauth_codes (user_id);
CREATE INDEX oauth_codes_expires ON oauth_codes (expires_at);
