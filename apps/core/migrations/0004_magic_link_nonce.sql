-- Sign-in links are tied to the browser that asked for them: POST /api/v1/auth/start sets a
-- short-lived pre-auth cookie and keeps its SHA-256 here. Opening the link in that browser
-- signs in at once; anywhere else, the page first asks "Continue as a•••@example.com?", so
-- a link someone else requested cannot quietly sign a person into the wrong account.
ALTER TABLE magic_links ADD COLUMN nonce_hash TEXT;
