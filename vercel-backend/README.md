# iOS SK Music — Vercel Backend & Media Setup Guide

This backend enables **uninterrupted background audio playback on iPad and iOS devices** for the SK Music PWA.

## Why this is needed
iOS and iPadOS automatically pause off-screen YouTube `<iframe>` players whenever you switch apps or turn off your screen. HTML5 `<audio>` elements paired with direct audio streams bypass this limitation.

## Deployment Options

### Option 1: Vercel On-Demand Stream Proxy (Recommended)
1. Deploy this `vercel-backend` folder to Vercel (`vercel deploy`).
2. Add your deployed Vercel domain to `wrangler.jsonc` in the root SK Music project:
   ```json
   "vars": {
     "STREAM_SERVER_URL": "https://your-vercel-backend.vercel.app"
   }
   ```
3. Deploy SK Music via `npm run deploy`.

### Option 2: Cloudflare R2 Object Storage Cache
Instead of hosting audio directly in a relational database (which degrades database performance), store audio in **Cloudflare R2**:
1. Create an R2 bucket in Cloudflare named `sk-music-audio`.
2. Configure a **7-day or 24-hour Lifecycle Auto-Delete Rule** in the Cloudflare R2 console (Settings -> Lifecycle rules).
   - This prevents unlimited storage growth while allowing full HTTP Range request support (seeking and scrubbing) for smooth iPad listening.
3. In `wrangler.jsonc`, enable the R2 binding:
   ```json
   "r2_buckets": [{ "binding": "AUDIO_BUCKET", "bucket_name": "sk-music-audio" }]
   ```
