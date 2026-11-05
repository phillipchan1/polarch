-- What Polarch learns as meetings happen: a glossary taught by transcript
-- corrections, fixtures (the standing things a team does), and what's known
-- about each person and team. Owner-only: never on a shared page, and offered
-- to a connected assistant only when it was given the people records
-- (`people:read`).
--
-- Apply before deploying a Worker that knows these tables: the Worker reads
-- every allowlisted table on load, and a missing one fails the whole load.
BEGIN;

CREATE TABLE IF NOT EXISTS public.glossary (
  user_id     uuid NOT NULL,
  id          text NOT NULL,
  heard       text,
  meant       text NOT NULL,
  created_on  text,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS public.fixtures (
  user_id          uuid NOT NULL,
  id               text NOT NULL,
  subject_kind     text NOT NULL CHECK (subject_kind IN ('person', 'team', 'manager')),
  subject_id       text NOT NULL,
  title            text NOT NULL,
  owner            text,
  cadence          text NOT NULL DEFAULT 'monthly'
                   CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly', 'as_needed')),
  notes            text,
  last_touched_on  text,
  created_on       text,
  sort_order       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_fixtures_subject ON public.fixtures (user_id, subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS public.knowledge (
  user_id       uuid NOT NULL,
  id            text NOT NULL,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('person', 'team', 'manager')),
  subject_id    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('decision', 'theme', 'fact')),
  text          text NOT NULL,
  session_id    text,
  noted_on      text,
  pinned        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_subject ON public.knowledge (user_id, subject_kind, subject_id);

COMMIT;
