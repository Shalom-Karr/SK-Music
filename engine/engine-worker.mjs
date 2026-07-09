// Runs the client data engine inside a Web Worker so the heavy one-time work — parsing/inflating the dataset
// and building the search indexes over ~70k tracks — happens off the main thread and never janks the UI.
// Protocol: the page posts { id, url }; we answer { id, r } on success or { id, err } on failure. If the
// worker can't start, the page falls back to running the same engine in-thread. (Original implementation.)
import { handle, preload } from "./engine.mjs";

// Pre-warm the dataset + indexes, but only after a short delay: the index build is synchronous and would
// block this worker's inbox, holding up the tiny reads that fire right at boot (/health, /home, /artists).
// Letting those through first is worth more than warming a couple seconds sooner; a search inside the window
// just builds on demand.
setTimeout(() => { preload().catch(() => {}); }, 2500);

self.addEventListener("message", async (ev) => {
  const { id, url } = ev.data || {};
  try {
    self.postMessage({ id, r: await handle(url) });
  } catch (err) {
    self.postMessage({ id, err: String((err && err.message) || err) });
  }
});
