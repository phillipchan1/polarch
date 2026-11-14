# Polarch cutover: Vercel/Supabase → Cloudflare/Neon

Phil is the only user. Vercel and the Supabase project **Polarch** stay
intact. This runbook is the cutover, not a delete.

Realtime publication is on in Supabase. The app never calls
`supabase.channel` / `.subscribe()`, so realtime is dropped. No Worker
equivalent is shipped.

There are no crons, storage buckets, or payments. The public host will
be **polarch.day**.

Auth is a magic-link email. The only sender is Cloudflare Email Service (`EMAIL` send_email binding, from `Polarch <login@polarch.day>`). "Continue with Google" sits next to the magic link when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set (see [Google sign-in](#google-sign-in)); without them the button is hidden and only the magic link runs.
Sign-in and sign-up are allowlist-only (`ALLOWED_EMAILS`).

---

## Env vars and secrets (names only)

Never put values here.

### Worker / wrangler secrets

| Name | Where | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | wrangler secret | Session signing. Generate a long random string. |
| `BETTER_AUTH_URL` | wrangler var | Public Worker origin (`https`, with a scheme). Required in preview/prod. Unset is allowed only when `ENVIRONMENT=local`. Loopback may use `http`. After the custom domain is attached, set this to that origin. |
| `TRUSTED_ORIGINS` | wrangler var | Optional comma-separated extra origins for CORS and Better Auth. `BETTER_AUTH_URL` is always included. Use for `www` or a leftover `*.workers.dev` host. Hosts must not contain `*`. |
| `AUTH_COOKIE_DOMAIN` | wrangler var | Optional cookie `Domain`. Must equal or be a parent of the `BETTER_AUTH_URL` host and must not be a public suffix (`workers.dev`, `pages.dev`, `co.uk`, …). Omit on `*.workers.dev` / `*.pages.dev` and local. |
| `ENVIRONMENT` | `.dev.vars` only | Set to `local` on your laptop. Omit in preview/prod. |
| `CF_EMAIL_FROM` | wrangler var | Cloudflare Email Service from-address. Default `Polarch <login@polarch.day>`. |
| `EMAIL` | send_email binding | Cloudflare Email Service (Workers Paid). The only magic-link sender. polarch.day is onboarded for sending (cf-bounce MX/SPF, cf-bounce DKIM, `_dmarc`). |
| `OPENAI_API_KEY` | wrangler secret | Server-side OpenAI key. The client must never send it. |
| `OPENAI_MODEL` | wrangler var | Optional. Must be in the Worker allowlist (`gpt-5-mini`, `gpt-5`). Defaults to `gpt-5-mini`. |
| `ALLOWED_EMAILS` | wrangler var | Comma-separated allowlist for sign-up and sign-in. Set to Phil's email. Empty admits nobody. Non-allowlisted magic-link requests still return `{status:true}` and do not send mail. |
| `GOOGLE_CLIENT_ID` | wrangler secret | Google OAuth web client id (the LeadWell client, project number `75851534029`). Unset or blank = Google off. Never a wrangler var (`config.check.ts`). |
| `GOOGLE_CLIENT_SECRET` | wrangler secret | That client's secret. Never a wrangler var, never logged, never printed. |
| `DATABASE_URL` | wrangler secret | Neon connection string. Used when Hyperdrive is unset (preview / local). |
| `HYPERDRIVE` | wrangler binding | Workers Paid. `wrangler.jsonc` holds the prod config id `c18a2c83cf664a8d9fc9f40bcba47718` (`leadwell-neon`). Local uses `localConnectionString`; preview has none and uses `DATABASE_URL`. |

### Client (Vite)

| Name | Where | Notes |
| --- | --- | --- |
| `VITE_DEMO` | build env | `1` for the offline sample-org build. |
| `POLARCH_WORKER_ORIGIN` | `.env.local` | Optional Vite proxy target. Defaults to `http://127.0.0.1:8787`. |

### Migration script (laptop, once)

| Name | Notes |
| --- | --- |
| `SUPABASE_DB_URL` | Read-only Postgres URI for the Polarch project (`migration_reader`). The script `pg_dump`s `public` (never `auth`) and `COPY`s auth rows from `migration_tmp.auth_users()` / `migration_tmp.auth_identities()`. |
| `NEON_DB_URL` | Empty Neon database. The script writes here. |
| `POLARCH_MIGRATE_TEST` | Set to `1` in prove/CI so both URLs must be loopback. Do **not** set this for the live Phil cutover or the Actions cutover workflow. |
| `PG_BIN` | Optional directory containing `pg_dump` / `pg_restore` matching the source major. |

### GitHub Actions cutover (`cutover-migrate.yml`)

Repo secrets. Never put values here or in the workflow file.

| Name | Notes |
| --- | --- |
| `SOURCE_DATABASE_URL` | Read-only Supabase **session-pooler** URI (`sslmode=require`). `migration_reader` — no `USAGE` on `auth`; auth rows are read through `migration_tmp.auth_users()` / `migration_tmp.auth_identities()`. Same role the laptop script calls `SUPABASE_DB_URL`. |
| `NEON_DATABASE_URL` | Empty Neon database. Used only when `dry_run=false`. |

`checks.yml` still uses loopback prove URLs only. These two secrets belong on the
manual cutover workflow, not in the PR checks job.

---

## Local

```sh
cp .env.example .env.local
cp .dev.vars.example .dev.vars
# fill names from the tables above
npm install
# terminal 1
npx wrangler dev
# terminal 2
npm run dev
```

Or `npm run cf:dev` after a Vite build (Worker serves `dist` + `/api`).

**`wrangler dev` / `cf:dev` sends real email.** The `EMAIL` send_email binding is `remote: true`, so a magic-link request in local dev goes out through Cloudflare Email Service from login@polarch.day to the real address (account `CLOUDFLARE_API_TOKEN` needs Email Sending: Edit). Only allowlisted addresses get mail. Use a bot inbox you own, never a stranger's address.

Apply `worker/schema/001_polarch.sql`, `002_better_auth.sql`,
`003_rate_limit.sql`, `004_rate_limit_window_start.sql`, then
`005_arcs_and_sharing.sql` to a local Postgres or Neon branch before signing
in. **Apply `005` to prod before deploying the Worker that ships arcs and
shared meetings**: that Worker writes the new tables on every sync. Rollback:
`worker/schema/rollback/005_arcs_and_sharing.sql`. `008_arc_cover_url.sql` (book
covers on arcs) goes on prod before the Worker that writes `cover_url`; rollback
`worker/schema/rollback/008_arc_cover_url.sql`. **`009_knowledge.sql` (glossary,
fixtures, what we know) goes on prod before the Worker that ships them**: that
Worker reads the new tables on every load, so without them nobody can sign in.
Rollback `worker/schema/rollback/009_knowledge.sql`; see
[docs/meetings-that-learn.md](docs/meetings-that-learn.md). **`010_shared_ideas.sql`
(`topics.is_shared`) goes on prod before the Worker that ships shared ideas**:
that Worker writes the column on every topic sync, so without it saving fails.
Rollback `worker/schema/rollback/010_shared_ideas.sql`. `004` is a `BEGIN`/`COMMIT`
transaction. To undo just that column (same statement as
`worker/schema/rollback/004_rate_limit_window_start.sql`):

```sql
ALTER TABLE rate_limit DROP COLUMN IF EXISTS window_start;
```

The MCP server adds two more files: `006_mcp_oauth.sql` (OAuth clients, grants,
codes, tokens) and `007_mcp_changes.sql` (the undo journal). **Apply both to
prod before deploying a Worker that mounts `/mcp`**: the Worker reads them on
every call. Details, and what rolling each back does, are under
[Connecting Claude and ChatGPT (MCP)](#connecting-claude-and-chatgpt-mcp).

---

## Data migration (source is read-only)

Dry-run with no URLs (prints the contract, writes nothing):

```sh
node scripts/migrate-supabase-to-neon.mjs --dry-run
```

Expected output:

```
dry-run: would pg_dump public (exclude auth) and COPY migration_tmp.auth_users() / migration_tmp.auth_identities() from SUPABASE_DB_URL (read-only)
dry-run: would abort before any Neon write if an email is blank or lower(email) is duplicated
dry-run: would refuse a non-empty target (any user table/function/enum/type in public or auth)
dry-run: would CREATE EXTENSION IF NOT EXISTS pgcrypto, then stub auth.users + auth.uid() and NOLOGIN roles (anon, authenticated, service_role) on NEON_DB_URL
dry-run: would CREATE a target-only BYPASSRLS copy role on NEON_DB_URL (never on Supabase) and DROP ROLE it after checksums
dry-run: would pg_restore --exit-on-error with EXTENSION entries filtered out
dry-run: would insert auth.users into Better Auth "user" (same ids); magic-link uses that email (Google identities are not mapped)
dry-run: would compare per-table row counts and content hashes and abort on mismatch
tools required: pg_dump, pg_restore, psql
```

Live cutover (Phil, by hand — not a test, so loopback is not required):

```sh
SUPABASE_DB_URL=postgres://… NEON_DB_URL=postgres://… \
  node scripts/migrate-supabase-to-neon.mjs
```

`--dry-run` with both URLs set still dumps from Supabase (read-only) and
prints row counts; it does not write to Neon.

### GitHub Actions (`cutover-migrate.yml`)

Manual only (`workflow_dispatch`). Default input `dry_run=true`. It is not
on push or pull_request. Do not add the secret values to the repo; set them
once in the GitHub UI (Settings → Secrets and variables → Actions).

1. Actions → **cutover-migrate** → Run workflow.
2. Leave **dry_run** checked for a rehearsal. The job:
   - masks `SOURCE_DATABASE_URL` / `NEON_DATABASE_URL` (`::add-mask::`) and
     never `set -x`
   - takes a **verified dump backup** of `public` from Supabase (custom
     format, matching client major, `sslmode=require`, `--exclude-schema=auth`)
     into `$RUNNER_TEMP`. It checks `pg_restore --list` succeeds and the
     file is non-zero, then logs **only the file name and byte size**. The
     dump is never uploaded, never printed, and never written to the step
     summary or `GITHUB_OUTPUT`. Auth rows are **not** in the dump. An
     `always()` step deletes `*.dump` and auth COPY CSVs
   - runs `scripts/migrate-supabase-to-neon.mjs` against an ephemeral
     Postgres 17 service container — **not** Neon. Before restore it
     creates `NOLOGIN` stubs for `anon` / `authenticated` / `service_role`
     and a target-only `LOGIN BYPASSRLS` copy role (`polarch_copy`). After
     checksums verify, the script **explicitly `DROP ROLE`s** that copy
     role (`ALTER ROLE … NOLOGIN` is the documented alternative if DROP
     is blocked). Never create those roles on the Supabase source.
     That script `COPY`s the narrow TABLE columns from
     `migration_tmp.auth_users()` / `migration_tmp.auth_identities()`
     (id/name/email/verified/timestamps and user_id/provider/provider_id
     — no password hashes or tokens). Logs are counts and md5s only.
     Blank-email and case-insensitive-dupe aborts print **user ids and counts only**, never emails. Command failures log the command name,
     exit code, SQLSTATE if present, and the first ERROR line with
     values stripped — never raw stdout/stderr, DETAIL, or row contents.
   - prints per-table `COUNT(*)` + content md5 hashes (source vs scratch
     target, including auth users via the function vs Better Auth `"user"`)
     to the **job log only**. No artifact, no step summary, no output file
   - confirms Phil's auth user (via `migration_tmp.auth_users()`) landed
     in Better Auth `"user"` with the same id and email, and prints
     **the id only**
   - fails if any checksum table mismatches or the user did not carry over
3. Uncheck **dry_run** only when Neon is empty and you intend to load it.
   Same dump + migrate script + checksums; the target is `NEON_DATABASE_URL`.
   Optional: snapshot a Neon branch of the empty (or current) target first
   so a failed live copy can be discarded without touching the Polarch
   Supabase project.

The job does **not** set `POLARCH_MIGRATE_TEST`. That flag is prove/CI
loopback only and would refuse the real session-pooler URL. The loopback
guards in `scripts/loopback.mjs` stay as they are.

The script:

1. `pg_dump`s `public` (no-owner, no-acl, `--exclude-schema=auth`) from Supabase.
2. `COPY`s `migration_tmp.auth_users()` (and `migration_tmp.auth_identities()`, unused). The functions `RETURNS TABLE` only the columns Better Auth needs. Never `SELECT`s `auth.users` / `auth.identities` — the source role cannot get `USAGE` on `auth`.
3. Aborts on blank or case-insensitive-duplicate emails.
4. Refuses a non-empty Neon target.
5. Creates `pgcrypto`, stub `auth.users` / `auth.uid()`, and stub **only**
   `anon`, `authenticated`, and `service_role` as `NOLOGIN` (tagged
   `DO $polarch_stub_roles$`, `IF NOT EXISTS`). The dump is scanned for
   `CREATE POLICY … TO` and privilege `GRANT … ON … TO` only — not
   function bodies and not membership `GRANT role TO role`. Any other
   role in those clauses is a hard error. Also creates a target-only
   `LOGIN BYPASSRLS` copy role (`polarch_copy`) and restores as that
   role. The same stubs + copy role run on the Actions scratch target
   (`dry_run=true`) and on Neon (`dry_run=false`). Without the stubs,
   `pg_restore` fails with `role "authenticated" does not exist` on
   `CREATE POLICY actions_owner … TO authenticated`.
   **Never create roles on the Supabase source.**
6. Inserts Better Auth `"user"` rows with the **same UUIDs** and emails.
7. Does **not** map Google identities. The first "Continue with Google" links
   by verified email to the migrated user (same id), so none are needed.
8. Compares per-table `COUNT(*)` and `md5` of every public row (`ORDER BY … COLLATE "C"`, so collation differences cannot cause a false mismatch), plus auth-user count/md5 via the function vs `"user"`. Aborts on mismatch. Logs are those counts and md5s — never emails or row data.
9. After checksums verify, **explicitly `DROP ROLE polarch_copy`**
   (`REASSIGN OWNED` first so `DROP OWNED` cannot remove tables). If
   `DROP` is blocked, `ALTER ROLE polarch_copy NOLOGIN` (and drop
   `BYPASSRLS`). On failure, the same drop runs, then only objects this
   run created on Neon are dropped. Supabase is never modified. The
   `NOLOGIN` stubs are cluster-level and are left in place.

### Restored RLS vs how the Worker enforces access

Supabase policies are `TO authenticated` and `user_id = auth.uid()`. After
cutover the Worker is the access path, not PostgREST:

- The Worker connects with `DATABASE_URL` / Hyperdrive as the Neon owner
  (or that role via Hyperdrive). It never `SET ROLE authenticated` /
  `anon` / `service_role`.
- `pg_restore --no-owner` makes that connecting role the table owner.
  Table owners **bypass RLS** unless `FORCE ROW LEVEL SECURITY` is set.
  We do **not** FORCE RLS — that would hide every row from the Worker
  (`auth.uid()` is the NULL stub).
- Access is enforced in `worker/src/store.ts`: every load / upsert /
  delete is scoped `WHERE user_id = $1` for the Better Auth session user.
  That is the same `user_id` as the migrated Supabase auth UUID.

The `NOLOGIN` stubs exist so `CREATE POLICY` can restore. Nothing can log
in as those roles. Policies stay attached to `authenticated` and still
call stub `auth.uid()`, so a future `SET ROLE authenticated` session
would see the RLS expression. That is dump fidelity, not the Worker
path. Do not grant `LOGIN` on the stubs and do not point Hyperdrive at
`authenticated`.

### `pg_dump` and RLS on the source

`pg_dump` (default, no `--enable-row-security`) sets `row_security=off`
and then `COPY`s each table. That is **not** the same as `GRANT SELECT`.
A non-owner without `BYPASSRLS` gets:

```
ERROR: query would be affected by row-level security policy for table "actions"
```

`--enable-row-security` would only dump rows a policy allows. The Polarch
policies are `TO authenticated` + `auth.uid()`. `migration_reader` is
neither `authenticated` nor the table owner, so it would dump **empty**
tables. Do not use that flag.

**Prod finding (do not guess attributes):** cutover
[40377053881](https://github.com/phillipchan1/leadwell/actions/runs/40377053881)
dumped `public` from real Supabase as `migration_reader` and then failed
later on `CREATE POLICY … TO authenticated`. So the prod dump role
**already can** `COPY` RLS-protected tables under `row_security=off`.
This environment cannot `SELECT rolbypassrls` on that role (no source
URI). **Do not grant `BYPASSRLS` on Supabase.** If prove or restore
needs a `BYPASSRLS` role, create it on the Neon / scratch **target**
only (`polarch_copy`), then `DROP ROLE` (or `ALTER ROLE … NOLOGIN`)
after checksums. Never print credentials.

The loopback prove dumps as the **table owner** (not `migration_reader`).
`migration_reader` stays a non-`BYPASSRLS` role for auth-function tests
only. The restore target creates `polarch_copy` `LOGIN BYPASSRLS`,
restores as that role, then **explicitly `DROP ROLE`s it**.

Loopback prove that a restore with role-scoped policies succeeds:

```sh
POLARCH_PROVE_SOURCE_URL=postgresql://postgres:postgres@127.0.0.1:5432/polarch_src \
POLARCH_PROVE_TARGET_URL=postgresql://postgres:postgres@127.0.0.1:5432/polarch_dst \
  npm run test:migrate
```

`scripts/prove-migrate.mjs` seeds `CREATE POLICY actions_owner … TO authenticated`
(the clause that failed in cutover dry-run 40377053881), then asserts the
target has the NOLOGIN stubs, the policy is restored, `polarch_copy` is
gone, and the table owner can still read rows (the Worker path). The
`authenticated` stub has no `USAGE` on `public` — the Worker never
`SET ROLE` those stubs. Dump-SQL scanning of `TO`/`GRANT` is also
unit-tested without a database.

The repo is public. `checks.yml` runs `scripts/guard-public-ci.mjs` (port
of nuvo PR #100): a default-deny YAML hasher. Every step, job, and
workflow — plus their order — is hashed; parse errors fail closed.
`.github/CODEOWNERS` requires `@phillipchan1` on the hasher, the
allowlist, and every workflow. There is no repo-settings change. Cutover
uploads **nothing** and writes no step summary or `GITHUB_OUTPUT`. Every
DB URL and secret is masked with `::add-mask::` before use. Scripts never
echo query results or row data — only counts and md5s. Every `uses:` is
pinned to a full commit SHA.

Email/password hashes from GoTrue are not portable. Phil's login path is a
**magic-link** to the migrated `"user"` row (same UUID + email). The first
sign-in with that email lands on that row; it does not create a second user.
The wrappers therefore do **not** return `encrypted_password`, recovery
tokens, or confirmation tokens. If a later change needs a secret column,
justify it in the PR — do not widen `RETURNS TABLE` by default.

### Apply / verify `migration_tmp` (prod, once)

Apply the SQL from the PR description (same text as
`MIGRATION_TMP_PROD_APPLY_SQL` in `scripts/migrate-users.lib.mjs`) on
Polarch prod as a privileged role (`postgres`), **not**
`migration_reader`. Run it as one transaction:

```sh
psql -1 -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f apply-migration-tmp.sql
```

`CREATE OR REPLACE` cannot change `SETOF auth.users` to `RETURNS TABLE`,
so the script `DROP`s the old functions first. Do not grant `USAGE` on
`auth`.

Pre-check dependents (expect 0 rows; abort if anything depends on the
current wrappers):

```sql
SELECT
  pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent,
  pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS referenced
FROM pg_catalog.pg_depend d
JOIN pg_catalog.pg_proc p ON p.oid = d.refobjid
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'migration_tmp'
  AND p.proname IN ('auth_users', 'auth_identities')
  AND d.deptype = 'n'
ORDER BY 1, 2;
```

The apply script wraps `CREATE` / `REVOKE` / `GRANT` in `BEGIN`/`COMMIT`
and includes an optional `ALTER FUNCTION … OWNER TO postgres` (needed
only when the creating role is not already `postgres`). After a failed
apply or an aborted data migration, roll back with:

```sql
DROP SCHEMA migration_tmp CASCADE;
```

Then verify (still as a privileged role; never print row values):

```sql
-- expect f
SELECT has_schema_privilege('migration_reader', 'auth', 'USAGE');

-- expect t
SELECT has_function_privilege('migration_reader', 'migration_tmp.auth_users()', 'EXECUTE');
SELECT has_function_privilege('migration_reader', 'migration_tmp.auth_identities()', 'EXECUTE');

-- expect f
SELECT has_function_privilege('anon', 'migration_tmp.auth_users()', 'EXECUTE');
SELECT has_function_privilege('anon', 'migration_tmp.auth_identities()', 'EXECUTE');
SELECT has_function_privilege('authenticated', 'migration_tmp.auth_users()', 'EXECUTE');
SELECT has_function_privilege('authenticated', 'migration_tmp.auth_identities()', 'EXECUTE');
SELECT has_function_privilege('service_role', 'migration_tmp.auth_users()', 'EXECUTE');
SELECT has_function_privilege('service_role', 'migration_tmp.auth_identities()', 'EXECUTE');

-- expect TABLE (...), not SETOF auth.users / auth.identities
-- expect no encrypted_password / recovery_token / confirmation_token / identity_data
SELECT p.proname, pg_get_function_result(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'migration_tmp'
  AND p.proname IN ('auth_users', 'auth_identities')
ORDER BY 1;

-- expect search_path = ''
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'migration_tmp'
  AND p.proname IN ('auth_users', 'auth_identities');
```

As `migration_reader` (session-pooler URI), confirm:

```sql
-- expect permission denied
SELECT 1 FROM auth.users LIMIT 1;

-- expect column does not exist (function is TABLE, not SETOF auth.users)
SELECT encrypted_password FROM migration_tmp.auth_users();

-- expect one row; print the id only
SELECT id FROM migration_tmp.auth_users() LIMIT 1;
```

### After cutover

Do **not** pause or delete the Polarch Supabase project until Neon is verified
(checksums match and magic-link sign-in works). Supabase is the intact rollback.

Once Neon is loaded and magic-link sign-in works, drop the temporary
schema so the wrappers cannot be reused. Do **not** drop `auth` or
`public`. Supabase stays intact. Same statement as the abort rollback:

```sql
DROP SCHEMA migration_tmp CASCADE;
```

---

## Cutover

1. Create a Neon project (free tier). Leave it empty.
2. Create a Cloudflare Worker (`polarch`) with Workers static assets.
   Hyperdrive is Workers Paid; preview can use `DATABASE_URL` instead.
3. Set the Worker secrets (`BETTER_AUTH_SECRET`,
   `OPENAI_API_KEY`, `DATABASE_URL`) and `ALLOWED_EMAILS` to Phil's email.
   Preview can use `BETTER_AUTH_URL` = the `*.workers.dev` origin. Production
   uses the custom domain (next step).
4. Attach **polarch.day** as the Worker custom domain (dashboard: Workers →
   polarch → Settings → Domains & Routes → Add, or
   `npx wrangler domains add polarch.day`). Then set:
   - `BETTER_AUTH_URL` = `https://polarch.day`
   - `AUTH_COOKIE_DOMAIN` = `polarch.day` (no leading dot)
   - `TRUSTED_ORIGINS` only if you still serve `www` or `*.workers.dev`
   Do not rename the Worker, package, or repo.
5. Sign-in mail is Cloudflare Email Service from `login@polarch.day`
   (polarch.day onboarded under Email Sending). That is the only sender.
   Google OAuth is optional: see [Google sign-in](#google-sign-in).
6. Run the migrate script against the empty Neon database (laptop, above) or
   the **cutover-migrate** workflow with `dry_run=false`.
7. `npm run cf:deploy` (= `npm run build && wrangler deploy --keep-vars`), or
   `npm run cf:preview` first. `keep_vars: true` in `wrangler.jsonc` also keeps
   dashboard vars on a bare `wrangler deploy`. Check first with
   `npx wrangler deploy --dry-run`: it must list `HYPERDRIVE (c18a2c83…)` and
   `EMAIL (senders: login@polarch.day)`.
8. Open `https://polarch.day`. Request a magic-link to Phil's email. Data
   should be Phil's existing org (same `user.id` as the Supabase auth UUID).
9. Smoke-test. The shared URL is `https://polarch.day`.

Vercel stays deployed. Supabase stays live. Nothing is deleted.

---

## Smoke tests

- `GET /api/health` → `{ ok: true, service: "polarch", realtime: false }`
- Signed-out `https://polarch.day/` still shows the marketing landing.
- Magic-link sign-in returns to the app; the org loads (people, meetings, prayer).
- An edit syncs (chrome leaves "saving"); reload keeps it.
- `POST /api/openai` with a signed-in session and no client API key.
  Without `OPENAI_API_KEY` the Worker returns 501; with it, OpenAI answers.
- Magic-link send is 3/minute per IP and per allowlisted email+IP. An hourly
  cap (10/hour) is keyed on email + IP prefix (IPv4 /24, IPv6 /48). Unparseable
  IPs share one `invalid` prefix bucket. A silent 200/hour per-email soft cap
  still returns 200 with the same timing but skips the send and logs once.
  That soft cap is email-only — see below. Verify is 10/minute per IP. Prod
  keys IP on `CF-Connecting-IP` only. Extra hard-limit requests return 429.
  Mail (or the first-skip console log) is dispatched in `waitUntil` so timing
  does not leak the allowlist or the cap. Soft-cap DB work (email + log keys)
  is awaited on the request; background send failures log kind/status only
  (no email, token, or IP).
- `GET /api/auth-providers` → `{ magicLink: true, google: <bool> }` (booleans only).
- With Google on: "Continue with Google" on `/signin` → Google account picker
  (app name **Polarch**) → back on `/signin`, signed in as the same user the
  magic link gives. A non-allowlisted Google account lands on
  `/signin?error=not_allowed` with no session.
- Confirm the Supabase dashboard still has the original rows (source untouched).

---

## Magic-link soft cap (email-only lockout)

The 200/hour silent cap is keyed on the allowlisted email alone
(`email-soft|/sign-in/magic-link|<lowercased-email>`). Hard limits are 10/hour
per email+prefix, so about **20 distinct /24 (or IPv6 /48) prefixes** can
burn the soft cap and **silently lock the victim out**: further requests
still return `200 {status:true}` and skip the send. The victim sees a successful
sign-in request and never gets mail.

### How to spot it

- One Worker log line per window: `magic-link send skipped` with
  `{ kind: "soft_cap" }`. The log has no email, token, or IP.
- In Postgres, look for a `rate_limit` row whose `key` starts with
  `email-soft|/sign-in/magic-link|` and `count >= 200`. The suffix after
  the last `|` is the lowercased address — read it in a SQL client; do
  not copy it into app logs.

### How to clear a key

Replace the placeholder with the lowercased address. Do not log the
statement or the key.

```sql
DELETE FROM rate_limit
 WHERE key IN (
   'email-soft|/sign-in/magic-link|<lowercased-email>',
   'email-soft-log|/sign-in/magic-link|<lowercased-email>'
 );
```

After delete, the next allowlisted request starts a new fixed hour window
and can send again. Prefix hard-limit rows (`email-prefix|…`) are separate;
clear those only if the same flood also 429s a prefix.

---

## Rollback

The intact **Polarch** Supabase project is the backup and the rollback
target. Cutover never uploads a dump artifact; the source rows stay on
Supabase. Optional: take a Neon branch snapshot of the empty target
before `dry_run=false` so a failed copy can be dropped without touching
Supabase.

`vercel.json` has `"ignoreCommand": "exit 0"`. Merging to `master` does
**not** ship a new Vercel build. Production on Vercel stays deployment
`a147830` and is the fallback:

| What | Value |
| --- | --- |
| Fallback URL (public) | **https://leadwell-ochre.vercel.app** |
| Vercel project | `leadwell` (`prj_bM8EnDRKvIWbLCMfAWtSei1ZGWxw`) |
| Deployment | `dpl_4hVVw2AQgdzJmmm1dfovs98i2w6T` (`leadwell-a2mlqhnjn-phillipchan1s-projects.vercel.app`), commit `a147830` |
| Not the fallback | `leadwell.vercel.app` is someone else's app. `leadwell-phillipchan1s-projects.vercel.app` is the same deployment but sits behind Vercel SSO. |

Vercel never served `polarch.day`. Before cutover the `polarch.day`
Cloudflare zone had **0 DNS records**. Cutover added one thing: a Worker
custom domain `polarch.day` → Worker `polarch`, which auto-created a
proxied `AAAA polarch.day 100::` record.

### Rollback steps (in order)

0. **Read-only Neon dump first.** Writes made on Neon after cutover are
   not on Supabase, so save them before anything else so Phil's edits can
   be re-entered by hand. Run from a machine that can reach Postgres on
   5432 (not the agent box). Use the direct (non-pooler) Neon URL, in a
   read-only transaction, to a 0600 file outside the repo. Never upload it
   as an artifact or attach it anywhere.

   ```bash
   umask 077
   PGOPTIONS='-c default_transaction_read_only=on' \
     pg_dump "$NEON_DIRECT_URL" --format=custom --no-owner --no-privileges \
       --schema=public --file "$HOME/polarch-neon-$(date +%Y%m%d-%H%M).dump"
   pg_restore --list "$HOME"/polarch-neon-*.dump | grep -c 'TABLE DATA'   # expect 26
   ```

   Alternative with no 5432 access: in the Neon console, create a branch
   from `main` at "now" (for example `pre-rollback-YYYYMMDD`). That is a
   read-only snapshot of the same data.
1. **Detach `polarch.day` from the Worker.** Do not delete the Worker or
   the Hyperdrive config.
   - Dashboard: Workers & Pages → `polarch` → Settings → Domains & Routes
     → `polarch.day` → Remove.
   - Or API (account `c1f7fb7e8c746389e2c56c499805d3e1`):

     ```bash
     A=c1f7fb7e8c746389e2c56c499805d3e1
     ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
       "https://api.cloudflare.com/client/v4/accounts/$A/workers/domains?hostname=polarch.day" \
       | jq -r '.result[0].id')   # was 9a9305bff2b42336d26be42945bf4019dd59a1ea
     curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
       "https://api.cloudflare.com/client/v4/accounts/$A/workers/domains/$ID" | jq .success
     ```

   Removing the custom domain also removes its `AAAA 100::` record, so the
   zone goes back to 0 records (the pre-cutover state). Confirm in
   DNS → Records.
2. **Decide what `polarch.day` does afterward.** Pick one:
   - (a) Leave it detached. `polarch.day` stops resolving, as it did
     before cutover. Phil uses https://leadwell-ochre.vercel.app.
   - (b) Redirect to Vercel. Add a proxied `AAAA polarch.day 100::`
     record, plus a Rules → Redirect Rule: hostname equals `polarch.day`
     → 302 to `https://leadwell-ochre.vercel.app` (preserve path).
3. **Verify the fallback.** `curl -sI https://leadwell-ochre.vercel.app/`
   returns 200 with title `Polarch`. Sign in with the Supabase magic link
   on that URL. Old polarch.day Better Auth sessions do not carry over.
4. Sign-in stays magic-link against the intact Polarch Supabase project
   (Vercel). No Google OAuth client was ever required for rollback.
5. Neon and the Worker stay up but unused (workers.dev URL
   `https://polarch.nq-morning-briefing.workers.dev`) until you cut over
   again.
6. **Writes made on Neon after cutover do not exist on Supabase.** Rolling
   back returns Phil to the last Supabase snapshot. Do not write back from
   Neon to Supabase; re-enter edits by hand from the step 0 dump.
7. Re-migrate later only into a **new empty** Neon database (the script
   refuses a dirty target). Discard an optional Neon branch snapshot if
   you took one before the live copy.
8. If you applied `004_rate_limit_window_start.sql` and need to drop the
   fixed-window column without a full cutover rollback:

   ```sql
   ALTER TABLE rate_limit DROP COLUMN IF EXISTS window_start;
   ```

---

## What is not here

- No Cloudflare cron.
- No R2 / storage.
- No payments.
- No Anthropic / Claude proxy.
- No Supabase realtime replacement (unused).
- No deletion of the Vercel project or the Polarch Supabase project.

## Sign-in email: Cloudflare Email Service

- Prod deploy: `npm run cf:deploy`. `keep_vars: true` keeps dashboard-only vars (`BETTER_AUTH_URL`, `AUTH_COOKIE_DOMAIN`). It does **not** protect any var written in `wrangler.jsonc`: config vars always overwrite the dashboard.
- Before Oct 27 2026, prod was deployed from a generated config (`hyperdrive.id` and vars patched outside the repo). The repo config now carries the real Hyperdrive id, so the repo deploy is the prod deploy.
- The prod Worker was named `leadwell` until Oct 27 2026, when it was renamed to `polarch` in place (Workers API `PATCH /workers/workers/<id>`). Secrets, the `polarch.day` custom domain and sessions carried over. The Neon project was renamed to `polarch` the same day (id `falling-dream-34644326`, unchanged).
- `allowed_destination_addresses` is deliberately not set. It only allows Email Routing *verified* destinations, so every allowlisted user would have to verify with Cloudflare first, and new users would fail closed. `ALLOWED_EMAILS` plus the rate limit already bound who gets mail.
- A missing binding logs `magic-link send failed {kind:"missing_env"}`. A binding throw logs `{kind:"cf_email"}`. Neither log includes the email or token.

## Google sign-in

"Continue with Google" is Better Auth `socialProviders.google`, next to the
magic link. Code: `googleSocialProviders`, `ACCOUNT_LINKING` and
`validateUserInfo` in `worker/src/auth.ts`; proof: `worker/src/google.check.ts`.

- **On/off.** On only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  are Worker secrets. Otherwise `POST /api/auth/sign-in/social` is 404
  `PROVIDER_NOT_FOUND`, `/api/auth-providers` says `google:false`, and Login
  hides the button. The magic link never depends on Google.
- **Linking.** `accountLinking: { enabled, trustedProviders: ["google"],
  requireLocalEmailVerified: true, allowDifferentEmails: false }`. A Google
  login whose email matches an existing (verified) user lands on that user and
  adds one `account` row (`provider_id='google'`, `account_id`=Google `sub`).
  No duplicate users. Email match is case-insensitive.
- **Second Google account, same email.** A different Google account (new
  `sub`) whose verified email is the same address links to the **same** user
  as a second `account` row (`provider_id='google'`). That is by design: Google
  vouches for the verified address, and the allowlist is per email, not per
  Google account. Audit with
  `SELECT user_id, count(*) FROM account WHERE provider_id='google' GROUP BY 1;`
  and remove a stray link with `DELETE FROM account WHERE provider_id='google' AND account_id='<sub>';`.
- **Email shape.** `validateUserInfo` refuses any email with leading/trailing
  whitespace or outside printable ASCII (`/^[\x21-\x7e]+$/`) →
  `invalid_email`. Better Auth lowercases before validation (and
  `toLowerCase` folds look-alikes such as U+212A KELVIN SIGN to `k`), so the
  Google provider's `mapProfileToUser` also marks a non-ASCII or padded *raw*
  Google email unverified, which is refused.
- **No id-token linking.** `POST /api/auth/link-social` with an `idToken` body
  skips `validateUserInfo`, so a `hooks.before` refuses it (403
  `LINK_SOCIAL_ID_TOKEN_DISABLED`). Linking happens only through the redirect
  flow.
- **Verified only.** `validateUserInfo` refuses any OAuth profile with
  `email_verified !== true` (create, link and sign-in), so trusting Google can
  never let an unverified address adopt a user.
- **Allowlist.** The same `ALLOWED_EMAILS` check runs on Google create, link
  and sign-in. Refused → `/signin?error=not_allowed`, no user, no account.
- **Google Cloud (Phil's console login; no gcloud on the box).** Project
  number `75851534029`, OAuth client
  `75851534029-n43ho7oqt9mm598bh4jtm03mpjcfjt8p.apps.googleusercontent.com`
  (the client the Polarch Supabase project used).
  1. APIs & Services → Credentials → that client → **Authorized redirect URIs**:
     add `https://polarch.day/api/auth/callback/google` (keep the Supabase
     `/auth/v1/callback` one until Supabase is retired). For a preview Worker
     also add `https://polarch-preview.<subdomain>.workers.dev/api/auth/callback/google`.
  2. Same client → **Add secret** (the old one is only stored hashed in
     Supabase, so it cannot be recovered). Copy it once.
  3. OAuth consent screen → Branding → **App name** = `Polarch`
     (optionally the home page `https://polarch.day`).
- **Set the secrets** (preview first):

  ```sh
  npx wrangler secret put GOOGLE_CLIENT_ID --env preview
  npx wrangler secret put GOOGLE_CLIENT_SECRET --env preview
  # after QA, prod (no --env):
  npx wrangler secret put GOOGLE_CLIENT_ID
  npx wrangler secret put GOOGLE_CLIENT_SECRET
  ```

  Paste values at the prompt; never on the command line or in `wrangler.jsonc`.
  Code deploys only with `npm run cf:deploy` (`keep_vars` on).
- **Errors** come back on `/signin?error=<code>` (`not_allowed`,
  `email_not_verified`, `invalid_email`, `state_mismatch`, `access_denied`, …)
  because `onAPIError.errorURL` is `BETTER_AUTH_URL/signin`; Login shows one
  friendly line.
- **Rollback.** Turn Google off without a deploy:
  `npx wrangler secret delete GOOGLE_CLIENT_SECRET` (button disappears, magic
  link unchanged). Or `wrangler rollback <previous version id>`. No schema
  change; linked `account` rows are harmless if left, or
  `DELETE FROM account WHERE provider_id = 'google';`.

## Connecting Claude and ChatGPT (MCP)

Polarch is an MCP server. An assistant you connect can see what's coming up
across every meeting and **plan, rearrange and close out agendas** for you:
capture ideas, move topics between weeks and sections, tag them, park or roll
them forward, skip or reschedule a meeting, create a meeting, set its sections,
manage tags, start and run an arc, add follow-ups. If you also give it **the
people records**, it can read and update health reads, prayer, assessments,
notes, wins, goals, what's known, fixtures, write-ups and transcripts. Every
change is journaled and undoable. It is one Worker route,
`https://polarch.day/mcp`, with a small OAuth server in front of it; no new
service, binding or secret.

### Deploy order

1. Apply `worker/schema/005_arcs_and_sharing.sql` (if not yet),
   `006_mcp_oauth.sql`, `007_mcp_changes.sql` to the prod Neon database, the
   same manual way as 001–004. All are idempotent (`IF NOT EXISTS`).
2. `npm run cf:deploy`. Nothing to configure: the OAuth issuer is
   `BETTER_AUTH_URL`, consent tokens are signed with `BETTER_AUTH_SECRET`, and
   `ALLOWED_EMAILS` gates who can connect.
3. Check, from anywhere:

```sh
curl -s https://polarch.day/.well-known/oauth-protected-resource   # {"resource":"https://polarch.day/mcp",…}
curl -si -X POST https://polarch.day/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'                     # 401 + WWW-Authenticate: Bearer resource_metadata=…
```

### Connecting an assistant

Add Polarch as a custom connector / MCP server with the URL
`https://polarch.day/mcp` (Settings → Connectors in Claude and ChatGPT; for
ChatGPT turn on developer mode first). The assistant opens Polarch's consent
page; sign in with your magic link or Google, read what it asks for, and
approve. In Claude Code: `claude mcp add --transport http polarch https://polarch.day/mcp`,
then `/mcp` to sign in.

The consent page lets you **narrow to read-only**, and has an unticked box to
**also give it the people records** (`people:read`, plus `people:write` if it
may make changes). No app gets those by asking for nothing: the default scope
is `agenda:read agenda:write`. The name an app shows is self-reported and
unverified, so the page always shows where it will send you back to
(`claude.ai`, `chatgpt.com`); if that isn't the app you meant to connect, deny
it.

**A bot that takes a URL and a key** (Grokbot, a script, xAI's remote MCP
tool): Settings → Connected apps → **Make a token**. Name it, choose whether it
may make changes and whether it gets the people records, and copy the token
(shown once; only its SHA-256 is stored). Give the bot the URL
`https://polarch.day/mcp` and the header `Authorization: Bearer <token>`. A
token lasts a year, lists and is deleted like any connected app, and at most
10 can be live per user. (`POST /api/mcp/tokens`, signed-in session, same
origin.)

### What an assistant can and cannot do

| Scope | Can |
|---|---|
| `agenda:read` | List upcoming occurrences across meetings with readiness and how far ahead each is planned; meetings, agendas, the Plan-ahead board, ideas, follow-ups, arcs, tags, past points; people's **names and roles** |
| `agenda:write` | Add, edit (talking points, sharing, privacy), tag, move, park, cover, roll forward, delete topics; follow-ups; skip, move, restore, add a week; set a meeting's point and *append* to prep notes; create a meeting; sections, rhythm, coverage targets; create, edit, recolour, reorder, delete tags; arcs |
| `people:read` | Everything kept about a person, team or manager (health, prayer, assessments, how-to-lead, leading-up, notes, wins, goals, prayer log, what's known, fixtures), your own profile, past write-ups and shared notes, transcripts (only when asked), the glossary |
| `people:write` | Add people, teams and managers; update their profiles, health reads and prayer; add notes; add or edit wins, goals, team actions, prayer entries, known items, fixtures, glossary terms; delete those records |

Never, with any scope: delete a meeting, person or team; replace written
session notes (append-only); read photos or chats; reach another user's data.

Without `people:*`, a connection is not even shown those tools, and
`worker/src/mcp/workspace.ts` never selects those columns for the agenda tools.
`worker/src/mcp/mcp.check.ts` plants sentinel strings in every private field
and fails if any tool output reaches an agenda-only connection with one; it
also checks a `people:*` connection gets them back. The consent text and the
connection instructions make the same promise, so keep all three true
together.

**Shared meetings.** A topic placed on a week of a meeting you've shared, or an
idea marked `shared`, is visible to the person you shared it with unless it is
`private`. Write tools
return a `warnings` entry naming who will see it.

### Undo

Every write returns a `change_id`. `list_changes` shows them and `undo_change`
reverses one: updates are set back column by column, creations deleted,
deletions re-inserted whole. It is **refused, never forced**, if anything the
change touched was edited since (including by you in the app) or if a later
change touched the same rows. The journal holds copies of the rows a change
touched, so it is pruned to the newest 200 entries / 30 days per user and is
cleared when a workspace is wiped or replaced (`DELETE`/`PUT /api/data`).

### How the web app sees it

An assistant writes row by row, like a third device. An open tab merges what it
changed the next time it refreshes (on focus, and on a slow timer): rows you
didn't touch update in place; a row both of you edited keeps your version.

### Limits and lifetimes

- `/mcp`: 120 calls a minute and 40 writes a minute per user. Tool results over
  60,000 characters are refused with advice to ask for less.
- OAuth: registration 20 an hour per IP (and a cap on stored clients), token and
  authorize 60 a minute per IP. Shared egress IPs from an assistant vendor could
  hit these under heavy use; they are in `worker/src/oauth/constants.ts`.
- Requests with no or an invalid token are not rate limited inside the Worker
  (a bad token costs one indexed lookup). If `/mcp` or `/oauth/*` sees abuse, add
  a Cloudflare rate-limiting rule for those paths.
- Access token 1 hour, refresh token 30 days, a connection 180 days at most
  (then the app asks you to approve again). Codes live 5 minutes and work once.
  A personal token lives a year and is not refreshable.
- Tokens are stored only as SHA-256 hashes. Removing someone from
  `ALLOWED_EMAILS` cuts their MCP access on the next call.

### Operating it

- **Disconnect**: Settings → Connected apps → Disconnect (or Delete, for a
  personal token). Every token of that app stops immediately.
  (`GET`/`DELETE /api/mcp/connections`.)
- **"Reconnect the app" after a refresh**: a refresh token is single-use, and
  presenting a used one revokes the whole connection (theft protection). If the
  response to a refresh is lost in transit, the retry looks like reuse. There is
  no grace window; the app just asks you to approve once more.
- **See what an assistant did**: `SELECT created_at, tool, summary, undone_at FROM mcp_changes WHERE user_id = '<id>' ORDER BY created_at DESC LIMIT 20;`
- **Errors**: tool failures log only the tool name, error class and SQLSTATE
  (`mcp: move_topics failed Error 40001`), never a message that could quote a row.

### Rollback

- Disable the endpoint: `wrangler rollback <previous version id>`. The tables
  can stay.
- `worker/schema/rollback/007_mcp_changes.sql` drops the undo journal (undo
  history is lost; data is untouched).
- `worker/schema/rollback/006_mcp_oauth.sql` drops the OAuth tables and so
  **disconnects every connected app**. Do not run it casually.

### Tests

`npm run test:mcp` (protocol, every tool, privacy sweep, undo round trips,
isolation, limits; plus the whole OAuth → `/mcp` path through the real `app`),
`npm run test:oauth` (the authorization server), `npm run test:agenda` (the pure
agenda rules in `src/lib/agendaOps.ts`).
