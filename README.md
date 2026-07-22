# SK Music for iOS

A fork/variant of the original **[SK Music](https://github.com/Shalom-Karr/SK-Music)** project that enables
**background audio playback on iPhone and iPad**.

The original app streams through the YouTube IFrame API, which iOS pauses as soon as you switch apps or lock the screen.
This version downloads the actual audio track from YouTube and plays it through the PWA's own `<audio>` element,
while caching each song in **Cloudflare R2** so subsequent plays are instant, seekable, and work offline-ish.

Live example: `https://<your-worker-url>.workers.dev`

---

## What changed vs. the original SK Music

| Original `Shalom-Karr/SK-Music` | This iOS version |
|---|---|
| Playback via embedded YouTube IFrame API | Playback via native HTML5 `<audio>` with a direct M4A stream |
| iOS pauses audio on app switch / screen lock | iOS keeps playing in the background |
| Streams directly from YouTube on every play | First play downloads and caches the M4A in Cloudflare R2; later plays served from R2 |
| Skipping when the IFrame API fails or is blocked | Reliable fallback stream with CORS and CSP support |
| No proxy / yt-dlp layer | Vercel serverless backend runs `yt-dlp` with optional proxy/cookies to bypass YouTube bot checks |

## Architecture

```
assets/       the PWA (ui.html), logos, manifest, icons
engine/       Cloudflare Worker (index.mjs), client search engine, static build scripts
vercel-backend/  Vercel function that runs yt-dlp and streams audio from YouTube
supabase/     analytics + parental-control schema
```

1. The PWA asks the Cloudflare Worker for `/stream?v=VIDEO_ID`.
2. The Worker checks the `AUDIO_BUCKET` R2 bucket:
   - **Hit** — serves the cached M4A with `Range`/`206` support.
   - **Miss** — fetches the Vercel backend, which uses `yt-dlp` to extract the audio URL. The Worker `tee()`s the
     response, returns one branch to the player, and writes the other branch to R2 in the background via `waitUntil()`.
3. The Vercel backend uses `--load-info-json` so YouTube is only queried once per song, and can use a proxy/cookies
   to avoid bot-check errors.

## Prerequisites

- Node.js 22+ and npm
- A Cloudflare account (Worker + R2 + KV)
- A Vercel account
- (Optional but recommended) a residential/mobile proxy URL for `yt-dlp`, or a YouTube cookies export, to avoid
  YouTube's "Sign in to confirm you're not a bot" errors.

## 1. Clone and install

```bash
git clone https://github.com/etatrackcustomerservice/SK-music-ios-new.git
cd SK-music-ios-new
npm install
cd vercel-backend
npm install
cd ..
```

`better-sqlite3` is a native dependency; `npm install` will build it for your platform.

## 2. Cloudflare setup

1. Create a Cloudflare Worker project.
2. Create an **R2 bucket** named `sk-music-audio`. This is where cached audio files live.
3. Create a **KV namespace** and note its ID (used for page overrides / trending playlist caching).
4. Note your **Cloudflare account ID**.
5. Create a **Cloudflare API token** with:
   - `Cloudflare Workers:Edit`
   - `Account:Read`
   - `Cloudflare R2:Edit` (or at least read/write for the `sk-music-audio` bucket)

### Update `wrangler.jsonc`

```json
{
  "name": "skmusic",
  "main": "engine/index.mjs",
  "account_id": "<your-cloudflare-account-id>",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },
  "kv_namespaces": [{ "binding": "PAGES", "id": "<your-kv-namespace-id>" }],
  "r2_buckets": [{ "binding": "AUDIO_BUCKET", "bucket_name": "sk-music-audio" }],
  "vars": { "STREAM_SERVER_URL": "https://<your-vercel-project>.vercel.app" },
  "triggers": { "crons": ["15 8,20 * * *"] },
  "observability": { "enabled": true }
}
```

## 3. Vercel setup

1. In the Vercel dashboard, create a project linked to the `vercel-backend` folder.
2. Set the following environment variables in **Project → Settings → Environment Variables**:

| Variable | Value | Purpose |
|---|---|---|
| `YTDLP_PROXY` | `http://host:port` (optional) | Residential/mobile proxy for `yt-dlp` to avoid bot checks |
| `YOUTUBE_COOKIES` | Netscape-format cookies for `youtube.com` (optional) | Helps bypass YouTube login challenges |
| `CLOUDFLARE_API_TOKEN` | your token (only needed if the Vercel function also uploads to R2; **not used** in the final Worker-cache version) | kept for legacy/future use |
| `CLOUDFLARE_ACCOUNT_ID` | your account id | same as above |
| `R2_BUCKET_NAME` | `sk-music-audio` | same as above |

3. Make sure `vercel.json` is present at `vercel-backend/vercel.json`:

```json
{
  "functions": {
    "api/stream.js": {
      "maxDuration": 300
    }
  }
}
```

4. Deploy the backend:

```bash
cd vercel-backend
npx vercel --prod
```

Copy the production URL (e.g. `https://<your-vercel-project>.vercel.app`) into `wrangler.jsonc` as `STREAM_SERVER_URL`.

## 4. Build and deploy the Worker

```bash
# From the repo root
npm run build    # fetches the catalog and bakes dist/
npx wrangler deploy
```

To deploy from CI, add `CLOUDFLARE_API_TOKEN` as a **GitHub repository secret** at
`Settings → Secrets and variables → Actions`. The included `.github/workflows/` (if present) will run
`npm run deploy` on every push to `main`.

## 5. Pre-warm the audio cache (optional but recommended)

The first listener to request a song pays the YouTube-download cost. For a smooth launch, warm the cache for the
songs you care about:

```bash
for id in VIDEO_ID1 VIDEO_ID2; do
  curl -s -o /dev/null "https://<your-worker>/stream?v=$id"
done
```

For long mixes or slow proxies, you may need to run the warmer with a long timeout, or download through the Vercel
backend and upload the M4A directly to R2.

## Run locally

```bash
npm install
npm run build
npm run dev    # wrangler dev
```

In another terminal:

```bash
cd vercel-backend
npm install
npx vercel dev
```

## iOS background audio

Because the PWA now plays a real `<audio>` stream instead of a YouTube iframe, Safari/iOS treats it like any other
audio app. Once installed to the home screen, the PWA will keep playing when you switch apps, lock the screen, or use
the system media controls.

## Credits

This project is based on the original **SK Music** by **[Shalom Karr](https://github.com/Shalom-Karr)**.

- Original repository: <https://github.com/Shalom-Karr/SK-Music>
- Announcement thread on jtechforums: <https://forums.jtechforums.org/t/sk-music-the-long-awaited-release-of-a-kosher-music-web-client/7839>

Special thanks to **[@Shalom_Karr](https://forums.jtechforums.org/u/Shalom_Karr)** and the
[jtechforums.org](https://forums.jtechforums.org) community for the original app, the catalog ideas, and the feedback
that led to this iOS-background-playback fork.

The whitelisted music catalog and artist whitelist come from **Zemer** by
[alltechdev](https://github.com/alltechdev) / [`zemer-search`](https://github.com/ZemerTeam/zemer-search).

## License

SK Music is free software under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).

Copyright © 2026 Shalom Karr. Portions derive from [`zemer-search`](https://github.com/ZemerTeam/zemer-search) by
[alltechdev](https://github.com/alltechdev), also licensed GPL-3.0.

The GPL permits commercial use. As a personal request — **not** a condition of the license — please contact the author
before using SK Music, or substantial parts of it, in a paid or commercial product.
