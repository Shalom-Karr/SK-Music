# Zemer partner key (`X-Zemer-Partner`)

Since **2026-10-28** Zemer refuses server-side calls to `content.zemer.io` and `search.zemer.io` unless they
carry the partner key in the `X-Zemer-Partner` request header. Browser calls from the canonical host are
unaffected; this is only about the build (`engine/build-static.mjs`) and the Worker (`engine/index.mjs`).

## Paths that accept the key

The key is accepted only on these paths and paths below them. It is sent nowhere else, and never to
`tracking.zemer.io` (`/stats/public` is not affected).

| Host | Paths |
|---|---|
| `content.zemer.io` | `/whitelist`, `/blockedContentIds`, `/podcastsWhitelist` |
| `search.zemer.io` | `/home-rows`, `/new`, `/radio`, `/stations`, `/station`, `/podcasts`, `/podcast`, `/podcast-channel`, `/zemer-playlists` |

Who calls what:

| Caller | Upstream | Powers |
|---|---|---|
| Build | `content.zemer.io/whitelist` | artist flags, admin taggers (**required**) |
| Build | `content.zemer.io/blockedContentIds` | `dist/data/blocked-ids.json` (**required**) |
| Build | `search.zemer.io/zemer-playlists`, `/zemer-playlists?id=`, `/zemer-playlists/cover?id=` | curated playlists, acapella filter |
| Build | `search.zemer.io/podcasts` + `content.zemer.io/podcastsWhitelist` | `dist/data/podcasts.json` |
| Worker | `/zemer-playlists?id=` | `/zp-live`, cron `refreshTrending` |
| Worker | `/home-rows` | `/zemer-home-rows`, cron `refreshHomeRows` |
| Worker | `/new` | `/zemer-new` |
| Worker | `/radio` | `/radio` |
| Worker | `/stations`, `/stations/cover`, `/station` | `/stations`, `/stations/cover`, `/station` |
| Worker | `/podcast`, `/podcast-channel`, `/podcasts/new-episodes` | same-named routes |
| Worker | `content.zemer.io/podcastsWhitelist`, `/podcastsWhitelist/version` | `/podcasts-whitelist`, `/podcasts-whitelist/version` |

In the Worker, `zemerHeaders(env, url)` adds the header only when `env.ZEMER_PARTNER_KEY` is set **and** the URL
is `https` on one of the hosts/path prefixes above. In the build, `ZEMER_HEADERS` is applied to every
`content.zemer.io` call, and `CATALOG_HEADERS` (the same header, but only when `CATALOG_API` is the real
`search.zemer.io`) to every `CATALOG_BASE` call, including `fetchWithRetry`.

## Where the secret lives

The key exists in exactly two places. **Never** put it in the repo, `wrangler.jsonc`, `.env.example`, a commit
message, a log line, or an error message, and never return it to a browser.

1. **GitHub Actions secret** `ZEMER_PARTNER_KEY` (used by the build):
   GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret** → name
   `ZEMER_PARTNER_KEY`. `.github/workflows/deploy.yml` passes it to the "Build static bundle" step only.
2. **Worker secret** `ZEMER_PARTNER_KEY` (used at runtime):

   ```sh
   npx wrangler secret put ZEMER_PARTNER_KEY
   ```

   Paste the value at the prompt (not as an argument, so it stays out of shell history). Secrets persist
   across `wrangler deploy`; CI's deploy does not touch them. Check with `npx wrangler secret list`.

Local Worker dev (`wrangler dev`): wrangler reads `.dev.vars`, which is **not** in `.gitignore` here — add it
there before creating one. Local build: `ZEMER_PARTNER_KEY=... npm run build:static`.
There is no offline escape hatch: a full build without a working key fails (see below). `--code` builds make
no Zemer calls and need no key.

## Fail-closed behaviour

- **`/whitelist` and `/blockedContentIds` are content gates.** If either can't be fetched, isn't HTTP 2xx,
  isn't JSON, or doesn't have the expected shape (whitelist: non-empty artist array; blocked ids:
  `{ global: [], female?: [] }`), the build throws, e.g.
  `blockedContentIds: HTTP 403; not publishing without it (ZEMER_PARTNER_KEY is not set)`.
  `node engine/build-static.mjs` exits non-zero, the "Deploy to Cloudflare" step is skipped, and the
  previous deployment stays live. There is no committed or cached fallback copy of either file.
- **Optional feeds** (curated playlists, acapella read, podcasts) do not fail the build. Each failure prints a
  GitHub `::warning::` annotation with the HTTP status, so a refused key is visible in the Actions run summary.
  The acapella read's 404 is the normal off-season state and is not warned about; the committed
  `data/acapella-fallback.json` still applies.
- **Worker**: with the secret missing, calls go out without the header (no crash); Zemer then refuses them and
  the routes answer with their usual 502 / upstream status. KV copies written by the cron keep serving until
  they expire.
