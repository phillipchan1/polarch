-- Everything an assistant changes through MCP, so it can be listed and undone.
--
-- Not a synced table: it is never part of /api/data and never in tables.ts.
-- `changes` holds before/after column images of the rows a tool touched, which
-- is user data (topic text, notes), so the Worker prunes it (30 days / newest
-- 200 per user) and clears it when a workspace is wiped or replaced.
--
-- Rollback (also in worker/schema/rollback/007_mcp_changes.sql):
--   DROP TABLE IF EXISTS public.mcp_changes;
BEGIN;

CREATE TABLE IF NOT EXISTS public.mcp_changes (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL,
  client_id  text,
  tool       text NOT NULL,
  summary    text NOT NULL,
  changes    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mcp_changes_user ON public.mcp_changes (user_id, created_at DESC);

COMMIT;
