// Runs the client data engine inside a Web Worker so the heavy one-time work — parsing/inflating the dataset
// and building the search indexes over ~70k tracks — happens off the main thread and never janks the UI.
// Protocol: the page posts { id, url }; we answer { id, r } on success or { id, err } on failure. If the
// worker can't start, the page falls back to running the same engine in-thread. (Original implementation.)
import { handle, preload, resetAuth, forget } from "./engine.mjs";

// Rate-limit / block / sign-in-needed responses on the catalog files (edge 429, Worker 401/403/429) go to the
// page, which shows the notice; this thread has no UI. The background pre-warm is quiet: nobody asked for
// anything yet, so a refusal there must not pop a notice (the next real request reports it). The dataset's 401
// (it needs an account) is not relayed either: the engine answers {error:"signin_required"} and the page decides
// whether that request deserves the sign-in prompt (a search does; a background lookup doesn't).
const nativeFetch = self.fetch.bind(self);
let quiet = false;
const DATASET_RX = /\/data\/dataset\.json\.gz(?:$|\?)/;
self.fetch = async (input, init) => {
  const q = quiet; // read synchronously: the pre-warm's fetch starts inside preload()'s first tick
  const r = await nativeFetch(input, init);
  if (r.status === 401 && DATASET_RX.test(String((input && input.url) || input))) return r;
  if (!q && (r.status === 429 || r.status === 403 || r.status === 401)) {
    const ra = r.headers.get("Retry-After");
    r.clone().json().then((j) => self.postMessage({ sec: { status: r.status, j, ra } }), () => self.postMessage({ sec: { status: r.status, j: null, ra } }));
  }
  return r;
};
// The page posts { cfg: { warm, auth } }: warm = pre-warm the dataset (only when signed in — signed out it is
// refused, and fetched only if something actually needs it); auth = someone just signed in, so a refusal the
// engine remembered no longer holds.
let warm = false, due = false, warmed = false;

// Pre-warm the dataset + indexes, but only after a short delay: the index build is synchronous and would
// block this worker's inbox, holding up the tiny reads that fire right at boot (/health, /home, /artists).
// Letting those through first is worth more than warming a couple seconds sooner; a search inside the window
// just builds on demand. A sign-in later in the session warms then.
function maybeWarm() {
  if (!warm || !due || warmed) return;
  warmed = true;
  quiet = true;
  try { preload().catch(() => { warmed = false; }); } finally { quiet = false; }
}
setTimeout(() => { due = true; maybeWarm(); }, 2500);

self.addEventListener("message", async (ev) => {
  if (ev.data && ev.data.cfg) {
    if (ev.data.cfg.auth) resetAuth();
    if (ev.data.cfg.forget) { forget(); warmed = false; }
    warm = ev.data.cfg.warm === true;
    maybeWarm();
    return;
  }
  const { id, url } = ev.data || {};
  try {
    self.postMessage({ id, r: await handle(url) });
  } catch (err) {
    self.postMessage({ id, err: String((err && err.message) || err) });
  }
});
