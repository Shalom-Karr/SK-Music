// Runs the client data engine inside a Web Worker so the heavy one-time work — parsing/inflating the dataset
// and building the search indexes over ~70k tracks — happens off the main thread and never janks the UI.
// Protocol: the page posts { id, url }; we answer { id, r } on success or { id, err } on failure. If the
// worker can't start, the page falls back to running the same engine in-thread. (Original implementation.)
import { handle, preload } from "./engine.mjs";

// Rate-limit / block / sign-in-needed responses on the catalog files (edge 429, Worker 401/403/429) go to the
// page, which shows the notice; this thread has no UI. The background pre-warm is quiet: nobody asked for
// anything yet, so a refusal there must not pop a notice (the next real request reports it).
const nativeFetch = self.fetch.bind(self);
let quiet = false;
self.fetch = async (input, init) => {
  const q = quiet; // read synchronously: the pre-warm's fetch starts inside preload()'s first tick
  const r = await nativeFetch(input, init);
  if (!q && (r.status === 429 || r.status === 403 || r.status === 401)) {
    const ra = r.headers.get("Retry-After");
    r.clone().json().then((j) => self.postMessage({ sec: { status: r.status, j, ra } }), () => self.postMessage({ sec: { status: r.status, j: null, ra } }));
  }
  return r;
};
// The page posts { cfg: { warm: false } } when the catalog needs an account and nobody is signed in: then the
// dataset is fetched only when a search actually needs it.
let warm = true;

// Pre-warm the dataset + indexes, but only after a short delay: the index build is synchronous and would
// block this worker's inbox, holding up the tiny reads that fire right at boot (/health, /home, /artists).
// Letting those through first is worth more than warming a couple seconds sooner; a search inside the window
// just builds on demand.
setTimeout(() => {
  if (!warm) return;
  quiet = true;
  try { preload().catch(() => {}); } finally { quiet = false; }
}, 2500);

self.addEventListener("message", async (ev) => {
  if (ev.data && ev.data.cfg) { warm = ev.data.cfg.warm !== false; return; }
  const { id, url } = ev.data || {};
  try {
    self.postMessage({ id, r: await handle(url) });
  } catch (err) {
    self.postMessage({ id, err: String((err && err.message) || err) });
  }
});
