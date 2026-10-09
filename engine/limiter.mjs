// Exact per-key rate limiter: one Durable Object per IP / account (idFromName(key)), created in the
// Cloudflare location nearest that client. Replaces the Workers `ratelimit` bindings, which count per
// machine and sync loosely — in production they let 56 requests a minute through a 20/min limit.
// Fixed windows, in memory only: an evicted object just starts counting again (fails open).
export class RateLimiter {
  constructor(state, env) {
    this.windows = new Map(); // tier name → { start, n }
  }

  // POST { tiers: [[name, limit, periodSeconds], ...] } → { tripped: name | null }. Every tier is counted,
  // so a request rejected by the burst tier still uses up the minute tier.
  async fetch(request) {
    let tiers;
    try { ({ tiers } = await request.json()); } catch { return Response.json({ tripped: null }); }
    const now = RateLimiter.now();
    let tripped = null;
    for (const [name, limit, period] of Array.isArray(tiers) ? tiers : []) {
      const span = period * 1000, start = now - (now % span);
      let w = this.windows.get(name);
      if (!w || w.start !== start) { w = { start, n: 0 }; this.windows.set(name, w); }
      w.n++;
      if (w.n > limit && !tripped) tripped = name;
    }
    return Response.json({ tripped });
  }
}
RateLimiter.now = () => Date.now(); // test hook
