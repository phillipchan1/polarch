# Polarch cloud setup

> **Cutover:** the live app is moving to Cloudflare Workers + Neon + Better
> Auth. Follow [RUNBOOK.md](RUNBOOK.md) for env names, migrate, smoke tests,
> and rollback. Vercel and this Supabase project stay intact. The rest of this
> file is the original Supabase setup, kept as history.

Polarch now runs on **Supabase** (Postgres + Auth) with **Google sign-in**, so
your data lives in the cloud and syncs across every device.

You do this once. It takes ~15 minutes.

---

## 1. Create a Supabase project

1. Go to <https://supabase.com> → **New project**. Pick a name and a strong
   database password (save it).
2. When it finishes provisioning, open **Project Settings → API** and copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon public** key → `VITE_SUPABASE_ANON_KEY`
3. In the repo, copy the example env file and paste those in:

   ```sh
   cp .env.example .env.local
   # then edit .env.local
   ```

   The anon key is safe to expose in the browser — **row-level security** (set
   up by the migration below) is what actually protects each user's data.

---

## 2. Create the database schema

The schema lives in [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
It creates one table per entity, all scoped to the signed-in user with RLS.

**Easiest way (dashboard):**

1. Supabase dashboard → **SQL Editor → New query**.
2. Paste the entire contents of `supabase/migrations/0001_init.sql`.
3. **Run**. You should see it create the tables and policies with no errors.
4. Then run each later migration in `supabase/migrations/` in order (`0002…`
   through `0011…`) the same way. They're additive `alter table` statements and
   are safe to re-run.

**Or with the CLI** (if you use it):

```sh
npm install -g supabase          # if you don't have it
supabase link --project-ref <your-project-ref>
supabase db push
```

---

## 3. Sign-in is a magic link

Auth lives on the Worker. Google sign-in is optional (`GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` Worker secrets; see `RUNBOOK.md` → Google sign-in). Mail goes
through the Cloudflare Email Service `EMAIL` binding only (login@polarch.day).
Set `ALLOWED_EMAILS` (see `RUNBOOK.md` and `.dev.vars.example`). Only
allowlisted addresses can request a link or create an account.

---

## 4. Run it

```sh
npm install
npm run dev
```

Open <http://localhost:5173>, enter an allowlisted email, and follow the
sign-in link.

### Migrating your existing local data

If you used the old localStorage version **in the same browser**, your teams and
people are imported automatically the first time you sign in — nothing is lost.
(The import runs only for a brand-new account with no cloud data yet.)

---

## Optional: a local allowlisted account

Sign-in is a magic link, plus "Continue with Google" when the Google
secrets are set. There is no password button. Put your address in `ALLOWED_EMAILS` (`.dev.vars`),
request a link from the sign-in screen, and follow it.

`npm run dev` also exposes `window.useStore` for inspecting or driving
store state from the console.

---

## Deploying to the web

Build with `npm run build` and host the `dist/` folder anywhere static (Vercel,
Netlify, Cloudflare Pages, Supabase Hosting…). Then:

- Set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` as build env vars there.
- Add your production URL to **Google** authorized redirect URIs is *not*
  needed (Google only points at Supabase), but **do** add it to Supabase
  **Authentication → URL Configuration** (Site URL + Redirect URLs).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| App stuck on "Backend not configured" | `.env.local` missing/typo'd; restart `npm run dev` after editing. |
| Google sign-in loops or 400s | Redirect URI in Google must be the Supabase `/auth/v1/callback` URL; your app URL must be in Supabase → Auth → URL Configuration. |
| Signed in but no data / permission errors | The SQL migration didn't run (RLS/tables missing). Re-run step 2. |
