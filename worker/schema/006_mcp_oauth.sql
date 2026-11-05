-- OAuth 2.1 for the MCP endpoint: apps (Claude, ChatGPT, …) that a signed-in
-- user has approved to read and change their agendas.
--
-- Not user data. None of these tables is in worker/src/tables.ts, so they are
-- never streamed to the SPA by /api/data and a workspace wipe leaves them be.
-- Secrets are stored as SHA-256 hashes only: authorization codes, access
-- tokens and refresh tokens are never recoverable from the database.
--
-- Rollback: worker/schema/rollback/006_mcp_oauth.sql (not auto-run).
BEGIN;

-- Dynamically registered clients (RFC 7591). Public clients only (PKCE, no secret).
CREATE TABLE IF NOT EXISTS public.oauth_clients (
  client_id     text PRIMARY KEY,
  client_name   text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per approval that was redeemed for tokens: the "connection" a user
-- sees in Settings, and the family that refresh-token reuse revokes together.
-- user_id has no FK to the Better Auth "user" table (same as the data tables):
-- the bearer lookup joins it, so a deleted user's grants are inert.
CREATE TABLE IF NOT EXISTS public.oauth_grants (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  client_id    text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
  scope        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_grants_user_client_idx ON public.oauth_grants (user_id, client_id);

-- Single-use authorization codes, five minutes. grant_id is the id the grant
-- will get when the code is redeemed, so a replayed code can revoke what it made.
CREATE TABLE IF NOT EXISTS public.oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES public.oauth_clients (client_id) ON DELETE CASCADE,
  user_id        text NOT NULL,
  grant_id       text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scope          text NOT NULL,
  resource       text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Access (1 hour) and refresh (30 days, rotated on every use) tokens. A rotated
-- refresh token keeps its row with revoked_at set: presenting it again is how
-- reuse is detected.
CREATE TABLE IF NOT EXISTS public.oauth_tokens (
  id         text PRIMARY KEY,
  grant_id   text NOT NULL REFERENCES public.oauth_grants (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash text NOT NULL UNIQUE,
  scope      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON public.oauth_tokens (grant_id);

COMMIT;
