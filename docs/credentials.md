# External credentials & secrets

Everything SK Music needs to build and deploy. **None of these are committed** — the token file and any
secret keys are gitignored; secrets live as GitHub Actions repository secrets. The one key that *is* in the
code (the Supabase **anon** key) is publishable and safe (see below).

| Credential | Needed for | Required? | Where it lives |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` | Yes (to deploy) | GitHub Actions secret |
| `GITHUB_TOKEN` | Fetching the catalog release | Auto (CI) | Provided by GitHub Actions |
| `CF_ANALYTICS_TOKEN` | Cloudflare Web Analytics beacon | Optional | GitHub Actions secret |
| Supabase **anon** key | Analytics, parental controls, tags | Yes | Committed (safe, RLS-protected) |
| Supabase **service_role** key | — | **Not used by the app** | Never commit; local admin only |

---

## 1. `CLOUDFLARE_API_TOKEN`

Used by `wrangler deploy` (in CI and locally) to publish the Worker. The Worker bundles a **Worker script +
Static Assets + a KV namespace binding + a cron trigger** (`wrangler.jsonc`), so the token must be able to
edit Workers and KV.

**Easiest — use the built-in template:** Cloudflare dashboard → **My Profile → API Tokens → Create Token →
"Edit Cloudflare Workers"**. Under *Account Resources*, scope it to the one account you deploy to.

That template grants exactly what's needed:

| Permission | Scope | Why |
|---|---|---|
| **Workers Scripts** · Edit | Account | Publish the Worker, its Static Assets, and the cron trigger |
| **Workers KV Storage** · Edit | Account | The `PAGES` KV namespace binding (page overrides + trending cache) |
| **Account Settings** · Read | Account | wrangler reads account info during deploy |

**Custom / least-privilege** (if you'd rather not use the template): create a token with just those three
Account permissions, scoped to your account.

**Only if you serve from a custom domain** (not `*.workers.dev`), add: **Zone · Workers Routes · Edit** and
**Zone · Zone · Read**, scoped to that zone.

**After creating it:** GitHub → repo → **Settings → Secrets and variables → Actions → New repository
secret** → name it `CLOUDFLARE_API_TOKEN`. Rotate it if it's ever exposed (revoke + recreate + update the
secret). Never place it in a committed file.

## 2. `GITHUB_TOKEN`

**No setup in CI** — GitHub Actions injects it automatically (`${{ secrets.GITHUB_TOKEN }}`). `fetch-corpus.mjs`
uses it to authenticate GitHub API calls when locating the latest catalog release, so the build doesn't hit
the 60-requests/hour unauthenticated rate limit.

**Local builds:** you usually don't need it. If you hit a GitHub rate limit, export a classic Personal Access
Token (no scopes required for public repos — it only raises the limit) as `GITHUB_TOKEN` before `npm run build`.

## 3. `CF_ANALYTICS_TOKEN` (optional)

The **Cloudflare Web Analytics** beacon token — a **public client id** (safe to ship in the HTML). Enables
the privacy-first, cookieless pageview beacon injected at build time. Get it from the dashboard →
**Web Analytics** → add your site → copy the token → add as a GitHub Actions secret. Omit it to disable
analytics entirely.

## 4. Supabase (analytics · parental controls · artist tags)

The app talks to Supabase for play analytics, the parental-controls policy, and crowdsourced artist tags.
Schema: **[`supabase/schema.sql`](../supabase/schema.sql)**.

- **anon / publishable key** — committed in the client and the build. **This is safe**: it's the public
  client key, and every table is protected by Row-Level Security (writes go through `SECURITY DEFINER`
  `pc_*` functions). Project ref: `jxttqcouabdptftlvfnd`.
- **service_role key** — **the app does not use it** and it must **never** be committed. It bypasses RLS;
  keep it only in your own machine's environment if you run admin/migration scripts.
- **To self-host your own backend:** create a Supabase project, run `supabase/schema.sql`, then replace the
  project URL + anon key where they appear in the code (search for the project ref).
- **Admin dashboard** (`/analytics`): sign in with a Supabase Auth email/password whose email is listed in
  the `zemer_admin` table.

## 5. Catalog source (no credentials)

- **`CORPUS_REPO`** — the whitelisted catalog snapshot is a **public** GitHub release; downloading it needs
  no auth.
- **`CATALOG_API`** — the curated-playlist API is public; no auth.

---

## Never commit

`CLOUDFLARE_API_TOKEN`, any Supabase `service_role` key, and any `*.token` file are gitignored. If one is
ever exposed, rotate it immediately. See [`.env.example`](../.env.example) for the full list of
(non-secret) build configuration.
