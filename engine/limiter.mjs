// Exact per-key rate limiter: one Durable Object per IP / account (idFromName(key)), created in the
// Cloudflare location nearest that client. Replaces the Workers `ratelimit` bindings, which count per
// machine and sync loosely — in production they let 56 requests a minute through a 20/min limit.
// Fixed windows, in memory only: an evicted object just starts counting again (fails open).
//
// Anchored windows (the signed-out limits in engine/security.mjs) are different: a window starts at the
// first use, not on an epoch boundary, and counts DISTINCT members (an artist id, a video id), so opening the
// same page twice uses one slot. They are minutes long — longer than an idle object lives in memory — so
// they are kept in the object's storage (SQLite-backed), and an alarm deletes them once they have expired.
export class RateLimiter {
  constructor(state, env) {
    this.windows = new Map(); // tier name → { start, n }
    this.storage = (state && state.storage) || null; // absent in unit tests ⇒ memory only
    this.anch = new Map(); // anchored name → { start, span, members } | null (loaded: none stored)
  }

  // POST { tiers: [[name, limit, periodSeconds], ...], anchored?: [name, limit, periodSeconds, member|null] }
  //   → { tripped: name | null, anchored?: { ok, resetAt, used, limit } }
  // Every tier is counted, so a request rejected by the burst tier still uses up the minute tier.
  async fetch(request) {
    let body;
    try { body = await request.json(); } catch { return Response.json({ tripped: null }); }
    const tiers = body && body.tiers;
    const now = RateLimiter.now();
    let tripped = null;
    for (const [name, limit, period] of Array.isArray(tiers) ? tiers : []) {
      const span = period * 1000, start = now - (now % span);
      let w = this.windows.get(name);
      if (!w || w.start !== start) { w = { start, n: 0 }; this.windows.set(name, w); }
      w.n++;
      if (w.n > limit && !tripped) tripped = name;
    }
    const out = { tripped };
    if (Array.isArray(body && body.anchored)) out.anchored = await this.anchored(body.anchored, now);
    return Response.json(out);
  }

  // A window of `period` seconds that opens at the first use. A member already counted in the open window is
  // free; a new one is counted while fewer than `limit` are; otherwise refused (and not counted). member null ⇒
  // every call is a new member.
  async anchored([name, limit, period, member], now) {
    name = String(name);
    const span = Math.max(1, Number(period) || 0) * 1000, max = Math.max(0, Math.floor(Number(limit) || 0));
    let w = this.anch.get(name);
    if (w === undefined) {
      w = this.storage ? (await this.storage.get("a:" + name)) || null : null;
      this.anch.set(name, w);
    }
    let dirty = false, opened = false;
    // now < w.start: the clock went backwards past the window — start over rather than trust it.
    if (!w || now >= w.start + span || now < w.start) { w = { start: now, span, members: [] }; dirty = opened = true; }
    let ok;
    if (member != null && w.members.includes(String(member))) ok = true;
    else if (w.members.length < max) { w.members.push(member != null ? String(member) : "#" + w.members.length); ok = true; dirty = true; }
    else ok = false;
    this.anch.set(name, w);
    if (dirty && this.storage) {
      await this.storage.put("a:" + name, w);
      if (opened) {
        const at = await this.storage.getAlarm();
        if (at == null || at < w.start + span) await this.storage.setAlarm(w.start + span + 1000);
      }
    }
    return { ok, resetAt: w.start + span, used: w.members.length, limit: max };
  }

  // Delete expired anchored windows; re-arm for any still open.
  async alarm() {
    if (!this.storage) return;
    const now = RateLimiter.now();
    let next = 0;
    for (const [k, w] of await this.storage.list({ prefix: "a:" })) {
      const end = w && w.start + w.span;
      if (!w || !(now < end)) { await this.storage.delete(k); this.anch.delete(k.slice(2)); }
      else next = Math.max(next, end);
    }
    if (next) await this.storage.setAlarm(next + 1000);
  }
}
RateLimiter.now = () => Date.now(); // test hook
