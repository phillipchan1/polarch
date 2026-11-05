-- Rollback for 007_mcp_changes.sql.
-- Do not apply from applySchema — this directory is not auto-run.
-- Also documented in RUNBOOK.md.

DROP TABLE IF EXISTS public.mcp_changes;
