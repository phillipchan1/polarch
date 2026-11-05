-- Rollback for 006_mcp_oauth.sql.
-- Do not apply from applySchema — this directory is not auto-run.
-- Disconnects every MCP client: they will have to be approved again.
BEGIN;
DROP TABLE IF EXISTS public.oauth_tokens;
DROP TABLE IF EXISTS public.oauth_codes;
DROP TABLE IF EXISTS public.oauth_grants;
DROP TABLE IF EXISTS public.oauth_clients;
COMMIT;
