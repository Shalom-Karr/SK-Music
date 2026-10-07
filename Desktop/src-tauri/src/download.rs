//! Offline downloads (DESKTOP ONLY).
//!
//! Lets the SK Music desktop app save a song's AUDIO for offline playback and then
//! play it from disk instead of the YouTube iframe. Isolated from the rest of the
//! shell: one module, one custom URI scheme, one capability. Nothing here runs for
//! the web-only PWA — the SPA gates every hook behind `SK_NATIVE`.
//!
//! ## How the audio URL is obtained (no browser window, no yt-dlp binary)
//! `native_extract()` calls YouTube's Innertube API through `rustypipe`
//! (<https://codeberg.org/ThetaDev/rustypipe>), a from-scratch Rust client. It picks the best
//! audio-only adaptive format and deciphers its signature/`n`-param by running the actual
//! extracted cipher function from YouTube's player JS through a bundled QuickJS engine
//! (`rquickjs`) — not a real browser, just a small embedded JS interpreter — so the whole thing
//! is a plain async network call on the download worker. Nothing opens, visibly or hidden, and
//! nothing here re-derives YouTube's cipher algorithm by hand (that was the previous approach's
//! fragility; rustypipe tracks player-JS changes as its own maintenance burden instead of ours).
//!
//! ## Download + playback
//! Rust fetches the signed URL with `reqwest` using a small number of concurrent ranged requests
//! (currently 3 × 2 MiB). The concurrency is kept low to stay under YouTube's multi-connection
//! throttle heuristic while still saturating typical home links; each request is small enough to
//! sidestep the per-request slow-path throttling of an untransformed `n`. The file is streamed to
//! `app_data_dir/downloads/<id>.<ext>`, and recorded in `downloads/index.json`.
//! Playback: a custom `skdl://` URI scheme serves the local file (with HTTP Range
//! support so the `<audio>` scrubber works). The SPA points its dormant html5
//! `<audio>` element at that URL when a download exists — allowed by the site CSP's
//! `media-src` once the scheme is whitelisted (see engine/build-static.mjs).
//!
//! ## Save for offline
//! The ⋮ "Save for offline" and the tray's "Save for offline" are the SAME pipeline as a plain
//! Download — one single-worker queue, one extraction strategy (native first, the streaming relay
//! as a last resort), one `<id>.<ext>.part` temp file per id. The only difference is the `Job` carries
//! extra metadata (album, artwork URLs) that the SPA already knows, so the finished `Entry` can be
//! grouped by album/artist with artwork in the offline player. Artwork itself is fetched with
//! `reqwest` after the song lands — small HTTPS images from the CDNs the site itself uses, not a
//! reason to spin up a browser window.
//!
//! ## Event contract (all `core:event`, the only channel remote origins get)
//! SPA (main window) -> Rust:
//!   * `sk-dl-request`      `{ videoId, title, artist }`  — download this song
//!   * `sk-dl-delete`       `{ videoId }`                 — remove a download
//!   * `sk-dl-list-request` `{}`                          — send the current library
//!   * `sk-dl-reveal`       `{ videoId }`                 — show the saved file in the OS file manager
//!   * `sk-offline-save`    `{ videoId, title, artist, ...SaveMeta }` — save for offline (⋮ menu)
//! Rust -> SPA (main window):
//!   * `sk-dl-progress`       `{ videoId, phase, received, total }`  phase = extracting|downloading
//!   * `sk-dl-done`           `{ videoId, item }`                    item = library entry (+ src)
//!   * `sk-dl-error`          `{ videoId, message }`
//!   * `sk-dl-list`           `{ items: [entry, ...] }`
//!   * `sk-dl-reveal-failed`  `{ videoId, message }`

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustypipe::client::RustyPipe;
use rustypipe::param::StreamFilter;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Listener, Manager, Url};
use tokio::sync::mpsc;

/// Ranged download chunk size — keeps each request small enough to stay under YouTube's
/// per-request throttle window while still being large enough to amortise round-trip latency.
const CHUNK: u64 = 2 << 20; // 2 MiB
/// Concurrent range requests in flight. Kept conservative (3) to avoid triggering YouTube's
/// multi-connection throttling / 403 responses while still being meaningfully faster than serial.
const PARALLEL: usize = 3;
/// Per-chunk retry limit before aborting the whole download.
const CHUNK_RETRIES: u32 = 2;
/// Browser-ish UA — googlevideo can 403 an obviously-headless client.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/// The streaming proxy — the same service the web app plays and downloads through when a filter
/// blocks YouTube (see RELAY_BASE in assets/ui.html). `/download` returns one full
/// `audio/mp4` file with a real Content-Length, which is exactly what the offline library wants.
/// (`/stream` exists too, but serves `audio/webm` — the wrong container for the library.)
const RELAY_DOWNLOAD: &str = "https://stream.zemer.io/download";

// ---------------------------------------------------------------------------
// Persistent index
// ---------------------------------------------------------------------------

/// One downloaded song, as stored in `downloads/index.json` and sent to the SPA.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    video_id: String,
    title: String,
    artist: String,
    ext: String,  // "m4a" | "weba" | "mp4"
    mime: String, // Content-Type served by the skdl:// handler
    bytes: u64,
    added: u64, // epoch ms
    // Filled in by "Save for offline" so the offline player can group by album and show artwork.
    // Files named here live in downloads/art and may be missing (fetch failed) — callers check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_sec: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    album_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    album_year: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    album_cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    artist_photo: Option<String>,
}

/// Serialize index writes across the download worker + delete handler.
static INDEX_LOCK: Mutex<()> = Mutex::new(());
/// The single-worker download queue.
static QUEUE: OnceLock<mpsc::UnboundedSender<Job>> = OnceLock::new();
/// The Innertube client used by `native_extract()`. Cheap to clone/reuse (internally Arc'd), so
/// one instance lives for the app's lifetime instead of being rebuilt per download.
static RP: OnceLock<RustyPipe> = OnceLock::new();
fn rp() -> &'static RustyPipe {
    RP.get_or_init(RustyPipe::new)
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DlRequest {
    video_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdOnly {
    video_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Extracted {
    video_id: String,
    url: String,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    itag: u32,
    #[serde(default)]
    content_length: Option<u64>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
}

struct Job {
    video_id: String,
    title: String,
    artist: String,
    /// Set for a "Save for offline" job: extra metadata the SPA (or the native now-playing
    /// snapshot) already knows, so the finished entry can be grouped by album/artist with
    /// artwork. `None` for a plain Download — same pipeline, nothing extra to attach.
    extras: Option<SaveMeta>,
    /// True for a tray/right-click save, which has no in-page UI to report back to — so process()
    /// shows OS notifications for it. A plain Download and an SPA-triggered save show none; the
    /// SPA already renders its own toasts off `sk-dl-done` / `sk-dl-error`.
    native_notices: bool,
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Wire the event listeners and spawn the single download worker. Called from `main.rs` setup().
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let _ = fs::create_dir_all(downloads_dir(app));

    // Single-worker queue: extractions reuse one hidden webview, so serialize jobs.
    let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
    let _ = QUEUE.set(tx);
    let worker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(job) = rx.recv().await {
            process(&worker_app, job).await;
        }
    });

    // SPA -> Rust
    let h = app.clone();
    app.listen("sk-dl-request", move |ev| {
        if let Ok(r) = serde_json::from_str::<DlRequest>(ev.payload()) {
            if !valid_id(&r.video_id) {
                emit_error(&h, &r.video_id, "invalid video id");
                return;
            }
            if let Some(q) = QUEUE.get() {
                let _ = q.send(Job { video_id: r.video_id, title: r.title, artist: r.artist, extras: None, native_notices: false });
            }
        }
    });
    let h = app.clone();
    app.listen("sk-dl-delete", move |ev| {
        if let Ok(r) = serde_json::from_str::<IdOnly>(ev.payload()) {
            delete(&h, &r.video_id);
        }
    });
    let h = app.clone();
    app.listen("sk-dl-list-request", move |_| emit_list(&h));
    // The SPA's ⋮ "Save for offline" (it toasts on its own, so no native notifications).
    let h = app.clone();
    app.listen("sk-offline-save", move |ev| {
        if let Ok(meta) = serde_json::from_str::<SaveMeta>(ev.payload()) {
            let h = h.clone();
            // Off the event thread: the lookup below is network. The page normally sends everything;
            // this fills any gap. Queuing (not a direct call) is what gives every save the same
            // single-worker serialization as a plain Download.
            tauri::async_runtime::spawn(async move {
                let meta = if valid_id(&meta.video_id) && (meta.album_id.is_none() || meta.artist_photo_url.is_none()) {
                    enrich_meta(meta).await
                } else {
                    meta
                };
                enqueue_save(&h, meta, false);
            });
        }
    });
    // Tray / right-click save on a site that doesn't offer __skSaveOfflineCurrent yet.
    let h = app.clone();
    app.listen("sk-offline-save-fallback", move |_| save_from_snapshot(&h));
    let h = app.clone();
    app.listen("sk-dl-reveal", move |ev| {
        if let Ok(r) = serde_json::from_str::<IdOnly>(ev.payload()) {
            reveal(&h, &r.video_id);
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Download pipeline (runs on the single worker task)
// ---------------------------------------------------------------------------

async fn process(app: &AppHandle, job: Job) {
    let id = job.video_id.clone();
    let native_notices = job.native_notices;
    let name = if job.title.is_empty() { "This song".to_string() } else { job.title.clone() };

    // Already have it: just re-affirm to the SPA (and the tray, if this was a save).
    if load_index(app).contains_key(&id) {
        if native_notices {
            notify(app, "Already saved for offline", &name);
        }
        emit_done(app, &id);
        emit_list(app);
        return;
    }
    if native_notices {
        notify(app, "Saving for offline…", &name);
    }

    emit_progress(app, &id, "extracting", 0, None);

    // native_extract() is a plain Innertube network call — no window opens. It fails whenever
    // YouTube itself isn't reachable (a kosher filter blocking youtube.com/googlevideo.com
    // outright is the common case for this audience) or YouTube changes something rustypipe
    // hasn't caught up with yet. Either way, fall back to the same streaming relay the web app
    // already uses when a filter blocks YouTube (see RELAY_BASE in assets/ui.html) before giving
    // up. Everything downstream (ranged download, index entry, done event) is unchanged: the
    // relay simply yields an `Extracted` too.
    let extracted = match native_extract(&id).await {
        Ok(x) => x,
        Err(reason) => match relay_extract(app, &id, &job).await {
            Some(x) => x,
            None => {
                let msg = format!("could not read the audio stream: {reason}");
                emit_error(app, &id, &msg);
                if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: {msg}")); }
                return;
            }
        },
    };

    let ext = ext_for(&extracted.mime, extracted.itag);
    let mime = if extracted.mime.is_empty() {
        default_mime(&ext)
    } else {
        extracted.mime.clone()
    };
    let dir = downloads_dir(app);
    if let Err(e) = fs::create_dir_all(&dir) {
        let msg = format!("cannot create downloads folder: {e}");
        emit_error(app, &id, &msg);
        if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: {msg}")); }
        return;
    }
    let part = dir.join(format!("{id}.{ext}.part"));
    let final_path = dir.join(format!("{id}.{ext}"));

    emit_progress(app, &id, "downloading", 0, extracted.content_length);
    let written = match download_ranged(app, &extracted.url, &part, extracted.content_length, &id).await
    {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_file(&part);
            let msg = format!("download failed: {e}");
            emit_error(app, &id, &msg);
            if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: {msg}")); }
            return;
        }
    };
    if written == 0 {
        let _ = fs::remove_file(&part);
        emit_error(app, &id, "download produced an empty file");
        if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: download produced an empty file")); }
        return;
    }
    if let Err(e) = fs::rename(&part, &final_path) {
        let _ = fs::remove_file(&part);
        let msg = format!("could not finalize file: {e}");
        emit_error(app, &id, &msg);
        if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: {msg}")); }
        return;
    }

    let title = pick(&job.title, &extracted.title, &id);
    let artist = pick(&job.artist, &extracted.author, "");
    let mut entry = Entry { video_id: id.clone(), title, artist, ext, mime, bytes: written, added: now_ms(), ..Default::default() };
    if let Some(meta) = &job.extras {
        entry.duration_sec = meta.duration_sec.as_ref().and_then(json_u64);
        entry.album_id = meta.album_id.clone().filter(|s| !s.is_empty());
        entry.album = meta.album.clone().filter(|s| !s.is_empty());
        entry.album_year = meta.album_year.as_ref().and_then(json_u64).and_then(|y| u32::try_from(y).ok());
        entry.cover = cover_name(meta);
        entry.album_cover = album_cover_name(meta);
        entry.artist_photo = artist_photo_name(meta);
        spawn_art_fetch(app, meta);
    }
    upsert_index(app, entry);
    emit_done(app, &id);
    emit_list(app);
    if native_notices {
        notify(app, "Saved for offline", &name);
    }
}

/// Download `url` to `path` using a pool of concurrent ranged requests. Returns bytes written.
///
/// Strategy: probe to learn the total size, then keep up to `PARALLEL` range GETs in flight via
/// `FuturesUnordered`. Each completed chunk is written at its correct offset from a blocking
/// thread. If the server doesn't support ranges, falls back to a simple sequential download.
async fn download_ranged(
    app: &AppHandle,
    url: &str,
    path: &PathBuf,
    total_hint: Option<u64>,
    id: &str,
) -> Result<u64, String> {
    use futures_util::stream::{FuturesUnordered, StreamExt};

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;

    // --- Determine total length (prefer hint, else probe) ---
    let total: u64 = if let Some(t) = total_hint.filter(|&t| t > 0) {
        t
    } else {
        let probe = client
            .get(url)
            .header(header::RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if probe.status().as_u16() == 206 {
            probe
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.rsplit('/').next().map(str::to_string))
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0)
        } else if probe.status().is_success() {
            // Server doesn't support ranges — sequential fallback.
            return download_sequential(app, path, id, probe).await;
        } else {
            return Err(format!("HTTP {}", probe.status()));
        }
    };

    if total == 0 {
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        return download_sequential(app, path, id, resp).await;
    }

    // --- Parallel chunked download ---
    // Pre-allocate file from a blocking context.
    let path_c = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = File::create(&path_c).map_err(|e| e.to_string())?;
        file.set_len(total).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let num_chunks = (total + CHUNK - 1) / CHUNK;
    let received = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    // Use FuturesUnordered to keep exactly PARALLEL requests in flight at all times.
    let mut futures = FuturesUnordered::new();
    let mut next_chunk: u64 = 0;

    // Seed the initial batch.
    while next_chunk < num_chunks && futures.len() < PARALLEL {
        futures.push(fetch_chunk(client.clone(), url.to_string(), path.clone(), next_chunk, total));
        next_chunk += 1;
    }

    while let Some(result) = futures.next().await {
        let n = result?;
        received.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
        let done = received.load(std::sync::atomic::Ordering::Relaxed);
        emit_progress(app, id, "downloading", done, Some(total));

        // Feed the next chunk into the pool.
        if next_chunk < num_chunks {
            futures.push(fetch_chunk(client.clone(), url.to_string(), path.clone(), next_chunk, total));
            next_chunk += 1;
        }
    }

    let final_len = received.load(std::sync::atomic::Ordering::Relaxed);
    // If we somehow got fewer bytes than expected, truncate the pre-allocated file.
    if final_len < total {
        let path_c = path.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&path_c) {
                let _ = f.set_len(final_len);
            }
        })
        .await;
    }
    Ok(final_len)
}

/// Fetch a single chunk with retry. Returns bytes written on success.
/// Asserts the server returned 206 — a 200 (full body) would corrupt the file.
async fn fetch_chunk(
    client: reqwest::Client,
    url: String,
    path: PathBuf,
    chunk_index: u64,
    total: u64,
) -> Result<u64, String> {
    let start = chunk_index * CHUNK;
    let end = ((chunk_index + 1) * CHUNK - 1).min(total - 1);
    let expected = end - start + 1;

    for attempt in 0..=CHUNK_RETRIES {
        let range = format!("bytes={start}-{end}");
        let resp = match client.get(&url).header(header::RANGE, range).send().await {
            Ok(r) => r,
            Err(_) if attempt < CHUNK_RETRIES => {
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };

        let status = resp.status().as_u16();

        // We MUST get 206. A 200 means the server ignored Range and returned the full body;
        // writing that at an offset would silently corrupt the file.
        if status == 416 && start >= total {
            // Past-end request on a file whose size we already know — nothing to write.
            return Ok(0);
        }
        if status != 206 {
            if attempt < CHUNK_RETRIES && (status == 429 || status == 403 || status >= 500) {
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
                continue;
            }
            return Err(format!("expected HTTP 206, got {status} for chunk at offset {start}"));
        }

        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(_) if attempt < CHUNK_RETRIES => {
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let n = bytes.len() as u64;

        // Every chunk (including the last) has a precise expected size since `end` is clamped
        // to `total - 1`. A mismatch means a short/over read — either corrupts the file.
        if n == 0 {
            return Err(format!("empty response for chunk at offset {start}"));
        }
        if n != expected {
            return Err(format!(
                "chunk at offset {start}: got {n} bytes, expected {expected}"
            ));
        }

        // Write at the correct offset from a blocking thread.
        let path_c = path.clone();
        let write_result = tokio::task::spawn_blocking(move || -> Result<u64, String> {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .open(&path_c)
                .map_err(|e| e.to_string())?;
            f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
            f.write_all(&bytes).map_err(|e| e.to_string())?;
            Ok(n)
        })
        .await
        .map_err(|e| e.to_string())?;

        return write_result;
    }
    Err(format!("chunk at offset {start} failed after {CHUNK_RETRIES} retries"))
}

/// Fallback: download the entire response body sequentially (server doesn't support Range).
async fn download_sequential(
    app: &AppHandle,
    path: &PathBuf,
    id: &str,
    resp: reqwest::Response,
) -> Result<u64, String> {
    let total = resp.content_length();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let n = bytes.len() as u64;
    let path_c = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut file = File::create(&path_c).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_progress(app, id, "downloading", n, total);
    Ok(n)
}

fn delete(app: &AppHandle, id: &str) {
    if !valid_id(id) {
        return;
    }
    let mut index = load_index(app);
    if let Some(entry) = index.remove(id) {
        let _ = fs::remove_file(downloads_dir(app).join(format!("{}.{}", entry.video_id, entry.ext)));
        store_index(app, &index);
    }
    emit_list(app);
}

/// "Remove from offline" in the offline player (a local page, so it may invoke commands). Same
/// removal as the full app's delete: the audio file and its index entry. Artwork is left alone because
/// album covers and artist photos are shared by other songs.
#[tauri::command]
pub fn offline_remove(app: AppHandle, video_id: String) -> Result<(), String> {
    if !valid_id(&video_id) {
        return Err("invalid video id".into());
    }
    delete(&app, &video_id);
    Ok(())
}

/// Open the OS file manager on a finished download, with the file selected.
///
/// The page sends only the videoId — never a path. A path arriving from the main window would be a
/// path arriving from REMOTE content, which would turn "reveal my song" into "select any file on this
/// machine"; instead the id is shape-checked and then resolved against OUR OWN index, so the worst a
/// hostile or injected SPA can reach is a file this app itself downloaded.
fn reveal(app: &AppHandle, id: &str) {
    use tauri_plugin_opener::OpenerExt;

    if !valid_id(id) {
        return;
    }
    let Some(entry) = load_index(app).remove(id) else {
        emit_reveal_failed(app, id, "that download is no longer in the library");
        return;
    };
    let path = downloads_dir(app).join(format!("{}.{}", entry.video_id, entry.ext));
    if !path.is_file() {
        emit_reveal_failed(app, id, "the saved file is missing from the downloads folder");
        return;
    }
    if let Err(e) = app.opener().reveal_item_in_dir(&path) {
        eprintln!("[downloads] reveal failed for {id}: {e}");
        emit_reveal_failed(app, id, "could not open the downloads folder");
    }
}

// ---------------------------------------------------------------------------
// Native YouTube extraction (no browser window — see the module doc comment)
// ---------------------------------------------------------------------------

/// Resolve `id` to a deciphered, downloadable audio stream URL via rustypipe's Innertube client.
/// A plain async network call: nothing opens a window, visible or hidden. Errors (video blocked
/// in-region, DRM, no audio format, the Innertube call itself failing) all fall through to
/// `relay_extract()` in `process()` — this function only needs to say what went wrong, not
/// distinguish why, since the caller treats every failure the same way.
async fn native_extract(id: &str) -> Result<Extracted, String> {
    let player = rp()
        .query()
        .player(id)
        .await
        .map_err(|e| format!("youtube lookup failed: {e}"))?;
    let stream = player
        .select_audio_stream(&StreamFilter::default())
        .ok_or_else(|| "no audio format found".to_string())?;
    Ok(Extracted {
        video_id: id.to_string(),
        url: stream.url.clone(),
        mime: stream.mime.clone(),
        itag: stream.itag,
        content_length: Some(stream.size).filter(|&n| n > 0),
        title: player.details.name.clone().unwrap_or_default(),
        author: player.details.channel_name.clone().unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// skdl:// protocol — serves a downloaded file to the <audio> element
// ---------------------------------------------------------------------------

/// Handler for `skdl://localhost/<videoId>` (Windows: `http://skdl.localhost/<videoId>`).
/// Supports HTTP Range so the html5 scrubber can seek.
pub fn serve_protocol(app: &AppHandle, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if let Some(name) = req.uri().path().strip_prefix("/art/") {
        return serve_art(app, name);
    }
    let id = req.uri().path().trim_start_matches('/');
    let id = id.split('.').next().unwrap_or(id); // tolerate a trailing extension
    if !valid_id(id) {
        return simple(StatusCode::BAD_REQUEST);
    }
    let Some(entry) = load_index(app).remove(id) else {
        return simple(StatusCode::NOT_FOUND);
    };
    let path = downloads_dir(app).join(format!("{}.{}", entry.video_id, entry.ext));
    let Ok(mut file) = File::open(&path) else {
        return simple(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);

    // Parse a single "bytes=start-end" range if present.
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_range(s, len));

    let (start, end, status) = match range {
        Some((s, e)) => (s, e, StatusCode::PARTIAL_CONTENT),
        None => (0, len.saturating_sub(1), StatusCode::OK),
    };
    let count = end.saturating_sub(start) + 1;
    let mut buf = vec![0u8; count as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
        return simple(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, entry.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, count.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{len}"),
        );
    }
    builder.body(buf).unwrap_or_else(|_| simple(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Saved artwork (cover / album cover / artist photo) for the offline player.
fn serve_art(app: &AppHandle, name: &str) -> Response<Vec<u8>> {
    if !valid_art_name(name) {
        return simple(StatusCode::BAD_REQUEST);
    }
    let Ok(bytes) = fs::read(downloads_dir(app).join("art").join(name)) else {
        return simple(StatusCode::NOT_FOUND);
    };
    let Some(mime) = image_mime(&bytes) else {
        return simple(StatusCode::NOT_FOUND);
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap_or_else(|_| simple(StatusCode::INTERNAL_SERVER_ERROR))
}

fn parse_range(spec: &str, len: u64) -> Option<(u64, u64)> {
    let spec = spec.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let last = len - 1;
    if a.is_empty() {
        // suffix range: last N bytes
        let n: u64 = b.trim().parse().ok()?;
        let n = n.min(len);
        return Some((len - n, last));
    }
    let start: u64 = a.trim().parse().ok()?;
    if start > last {
        return None;
    }
    let end = if b.trim().is_empty() {
        last
    } else {
        b.trim().parse::<u64>().ok()?.min(last)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn simple(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

fn emit_progress(app: &AppHandle, id: &str, phase: &str, received: u64, total: Option<u64>) {
    let _ = app.emit(
        "sk-dl-progress",
        serde_json::json!({ "videoId": id, "phase": phase, "received": received, "total": total }),
    );
}

fn emit_error(app: &AppHandle, id: &str, message: &str) {
    let _ = app.emit("sk-dl-error", serde_json::json!({ "videoId": id, "message": message }));
}

/// Distinct from `sk-dl-error`: the download itself is fine, only the reveal failed — so the SPA
/// toasts it instead of flipping the library row to a retryable failure.
fn emit_reveal_failed(app: &AppHandle, id: &str, message: &str) {
    let _ = app.emit(
        "sk-dl-reveal-failed",
        serde_json::json!({ "videoId": id, "message": message }),
    );
}

fn emit_done(app: &AppHandle, id: &str) {
    if let Some(entry) = load_index(app).remove(id) {
        let _ = app.emit("sk-dl-done", serde_json::json!({ "videoId": id, "item": to_item(&entry) }));
    }
}

fn emit_list(app: &AppHandle) {
    let _ = app.emit("sk-dl-list", serde_json::json!({ "items": library_items(app) }));
}

/// The whole library as SPA-ready items, newest first.
fn library_items(app: &AppHandle) -> Vec<serde_json::Value> {
    let mut items: Vec<_> = load_index(app).values().map(to_item).collect();
    items.sort_by(|a, b| {
        b.get("added").and_then(|v| v.as_u64()).unwrap_or(0)
            .cmp(&a.get("added").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    items
}

/// The library for the bundled offline player (`frontend/offline.html`). A local page can invoke app
/// commands, unlike the remote SPA, which has to go through the `sk-dl-list-request` event. Entries
/// whose audio file has gone missing are left out so the player never lists an unplayable song.
#[tauri::command]
pub fn offline_library(app: AppHandle) -> Vec<serde_json::Value> {
    let dir = downloads_dir(&app);
    let art = dir.join("art");
    let art_src = |name: &Option<String>| {
        name.as_ref().filter(|n| valid_art_name(n) && art.join(n.as_str()).is_file()).map(|n| art_url(n))
    };
    let mut entries: Vec<Entry> = load_index(&app)
        .into_values()
        .filter(|e| dir.join(format!("{}.{}", e.video_id, e.ext)).is_file())
        .collect();
    entries.sort_by(|a, b| b.added.cmp(&a.added)); // newest first
    entries
        .iter()
        .map(|e| {
            let mut it = to_item(e);
            if let Some(o) = it.as_object_mut() {
                o.insert("durationSec".into(), serde_json::json!(e.duration_sec));
                o.insert("albumId".into(), serde_json::json!(e.album_id));
                o.insert("album".into(), serde_json::json!(e.album));
                o.insert("albumYear".into(), serde_json::json!(e.album_year));
                o.insert("coverSrc".into(), serde_json::json!(art_src(&e.cover)));
                o.insert("albumCoverSrc".into(), serde_json::json!(art_src(&e.album_cover)));
                o.insert("artistPhotoSrc".into(), serde_json::json!(art_src(&e.artist_photo)));
            }
            it
        })
        .collect()
}

// ---------------------------------------------------------------------------
// "Save for offline" — queues onto the SAME pipeline as a plain Download
// ---------------------------------------------------------------------------
//
// A save is a download with extra metadata attached: the audio comes from the same native-extraction-
// first, relay-as-last-resort pipeline `process()` already uses, through the same single-worker queue
// (so a save can never collide with a Download's temp file, and only one of either ever runs at a
// time). `enqueue_save()` builds a `Job` with `extras: Some(meta)` and sends it; `process()` reads
// `job.extras` once the song has landed to fill in album/artwork and to kick off `spawn_art_fetch()`.
// Everything downstream — the library index, `sk-dl-done`, the offline player — is the same as Download.

/// Images are small; anything bigger than this isn't the thumbnail we asked for.
const MAX_IMAGE_BYTES: usize = 3 << 20;

/// Everything the page knows about a song when it asks to save it. Only `video_id` is required; the
/// rest makes the offline player look like the site (artist/album grouping, artwork, durations).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveMeta {
    video_id: String,
    title: String,
    artist: String,
    duration_sec: Option<serde_json::Value>,
    album_id: Option<String>,
    album: Option<String>,
    album_year: Option<serde_json::Value>,
    cover_url: Option<String>,
    album_cover_url: Option<String>,
    artist_photo_url: Option<String>,
}

/// Tray / right-click "Save for offline": let the page do it when it can — it knows the album and
/// the artist's photo — and fall back to what the native now-playing snapshot carries. The page
/// answers by calling `__skSaveOfflineCurrent` (newer site) or emitting `sk-offline-save-fallback`.
pub fn save_current_offline(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let on_site = win
        .url()
        .ok()
        .and_then(|u| u.host_str().map(|h| h.ends_with("skmusic.shalomkarr.com") || h.ends_with("skmusic.shalomkarr.workers.dev")))
        .unwrap_or(false);
    if !on_site {
        notify(app, "You're offline", "Connect to the internet to save songs for offline.");
        return;
    }
    let _ = win.eval(
        "(function(){try{if(typeof window.__skSaveOfflineCurrent==='function'){window.__skSaveOfflineCurrent();return;}}catch(e){}\
         try{window.__TAURI__.event.emit('sk-offline-save-fallback',{});}catch(e){}})();",
    );
}

/// The page couldn't (older site): save from the native now-playing snapshot instead.
fn save_from_snapshot(app: &AppHandle) {
    let np = crate::media::snapshot_value();
    let field = |k: &str| np.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = field("videoId");
    if id.is_empty() {
        notify(app, "Nothing to save", "Play a song first, then choose Save for offline.");
        return;
    }
    let art = field("artUrl");
    let meta = SaveMeta {
        video_id: id.clone(),
        title: field("title"),
        artist: field("artist"),
        duration_sec: np.get("durationMs").and_then(|v| v.as_u64()).map(|ms| serde_json::json!(ms / 1000)),
        // The snapshot's art is whatever the media overlay uses; the YouTube thumbnail is the same cover
        // the site shows, so prefer it when the id is well-formed.
        cover_url: if valid_id(&id) { Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")) } else if art.is_empty() { None } else { Some(art) },
        ..Default::default()
    };
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let meta = enrich_meta(meta).await; // artist photo, looked up natively
        enqueue_save(&h, meta, true);
    });
}

const SITE: &str = "https://skmusic.shalomkarr.com";
/// Artist name (lowercase) -> photo URL, fetched once per run from the site's /artists list.
static ARTIST_THUMBS: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();

/// Same rewrite the site's sizedArt() does: Google image CDN URLs take a size after the last "=", and
/// the corpus ships banner-sized originals. Other hosts pass through untouched.
fn sized_art(src: &str, px: u32) -> String {
    let ok = Url::parse(src)
        .map(|u| {
            let h = u.host_str().unwrap_or("");
            u.scheme() == "https"
                && u.query().is_none()
                && (h.starts_with("yt3.") || h.starts_with("lh"))
                && (h.ends_with(".googleusercontent.com") || h.ends_with(".ggpht.com"))
        })
        .unwrap_or(false);
    if !ok {
        return src.to_string();
    }
    let base = match src.rfind('=') {
        Some(c) if c > src.rfind('/').unwrap_or(0) => &src[..c],
        _ => src,
    };
    format!("{base}=s{px}-c-k-c0x00ffffff-no-rj")
}

async fn site_json(client: &reqwest::Client, path_and_query: &str) -> Option<serde_json::Value> {
    let resp = client.get(format!("{SITE}{path_and_query}")).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    serde_json::from_str(&resp.text().await.ok()?).ok()
}

/// Fill in what the page didn't send — the artist's photo — from the site's static `/data/artists.json`
/// (the same file the web app's own artist-photo lookups use; it's a real deployed asset, unlike
/// `/track` and `/album`, which only exist as routes inside the client-side search engine and 404 to
/// the app shell on a direct server request). Best effort: any failure leaves the field empty and the
/// song still saves, just with a placeholder in that spot.
///
/// There's no server-side way to resolve a bare videoId to its album (that needs the full corpus, which
/// only the browser's search engine holds) — so album fields stay whatever the page already sent, and a
/// save with no album context just doesn't get album grouping in the offline player.
async fn enrich_meta(mut meta: SaveMeta) -> SaveMeta {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(8)).user_agent(UA).build() else {
        return meta;
    };
    if meta.artist_photo_url.is_none() && !meta.artist.trim().is_empty() {
        let cached = ARTIST_THUMBS.get_or_init(|| Mutex::new(None)).lock().unwrap().clone();
        let map = match cached {
            Some(m) => m,
            None => {
                let mut m = HashMap::new();
                if let Some(list) = site_json(&client, "/data/artists.json").await {
                    for a in list.get("artists").and_then(|v| v.as_array()).into_iter().flatten() {
                        if let (Some(n), Some(t)) = (a.get("name").and_then(|v| v.as_str()), a.get("thumbnail").and_then(|v| v.as_str())) {
                            m.insert(n.to_lowercase(), sized_art(t, 480));
                        }
                    }
                }
                if !m.is_empty() {
                    *ARTIST_THUMBS.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(m.clone());
                }
                m
            }
        };
        meta.artist_photo_url = map.get(&meta.artist.trim().to_lowercase()).cloned();
    }
    meta
}

/// `native_notices`: true from the tray / right-click menu (no in-page UI to report back), false from
/// the SPA, which shows its own toasts off `sk-dl-done` / `sk-dl-error`.
fn enqueue_save(app: &AppHandle, meta: SaveMeta, native_notices: bool) {
    let id = meta.video_id.clone();
    if !valid_id(&id) {
        if native_notices {
            notify(app, "Can't save this one", "Only songs can be saved for offline, not shiurim or podcasts.");
        }
        return;
    }
    let job = Job {
        video_id: id,
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        extras: Some(meta),
        native_notices,
    };
    if let Some(q) = QUEUE.get() {
        let _ = q.send(job);
    }
}

/// Fetch a save's artwork (cover / album cover / artist photo) with `reqwest`, in the background — the
/// song is already indexed and playable by the time this runs, so it can only add artwork, never hold
/// up the next queued job. Only fetches what isn't already on disk (album covers and artist photos are
/// shared across songs); a failure here just leaves that spot as a placeholder.
fn spawn_art_fetch(app: &AppHandle, meta: &SaveMeta) {
    let art_dir = downloads_dir(app).join("art");
    let images: Vec<(String, String)> = art_plan(meta)
        .into_iter()
        .filter(|(file, _)| !art_dir.join(file).is_file())
        .collect();
    if images.is_empty() {
        return;
    }
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = downloads_dir(&h).join("art");
        let _ = fs::create_dir_all(&dir);
        let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(UA).build() else {
            return;
        };
        for (name, url) in images {
            if dir.join(&name).is_file() {
                continue;
            }
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        let _ = store_art(&h, &name, &bytes);
                    }
                }
            }
        }
    });
}

/// Which images a song wants, as (file under downloads/art, url). Album covers and artist photos get
/// shared names, so the second song from the same album/artist reuses the first one's file.
fn art_plan(meta: &SaveMeta) -> Vec<(String, String)> {
    [
        (cover_name(meta), meta.cover_url.as_deref()),
        (album_cover_name(meta), meta.album_cover_url.as_deref()),
        (artist_photo_name(meta), meta.artist_photo_url.as_deref()),
    ]
    .into_iter()
    .filter_map(|(name, url)| match (name, url) {
        (Some(n), Some(u)) if image_url_ok(u) => Some((n, u.to_string())),
        _ => None,
    })
    .collect()
}
fn cover_name(meta: &SaveMeta) -> Option<String> {
    meta.cover_url.as_ref().map(|_| format!("{}.img", meta.video_id))
}
fn album_cover_name(meta: &SaveMeta) -> Option<String> {
    let id = meta.album_id.as_deref().filter(|s| !s.is_empty())?;
    meta.album_cover_url.as_ref().map(|_| format!("al-{}.img", art_key(id)))
}
fn artist_photo_name(meta: &SaveMeta) -> Option<String> {
    let a = meta.artist.trim();
    if a.is_empty() { return None; }
    meta.artist_photo_url.as_ref().map(|_| format!("ar-{}.img", art_key(&a.to_lowercase())))
}

/// The page passes these URLs, so only fetch from the image CDNs the site itself uses, over https.
fn image_url_ok(u: &str) -> bool {
    let Ok(url) = Url::parse(u) else { return false };
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && (host.ends_with(".ytimg.com") || host.ends_with(".ggpht.com") || host.ends_with(".googleusercontent.com"))
}

/// Stable, filename-safe key (FNV-1a) — album ids and artist names can hold any character.
fn art_key(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn valid_art_name(name: &str) -> bool {
    name.len() <= 80
        && name.ends_with(".img")
        && name.trim_end_matches(".img").bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Content-Type from the first bytes; also our "is this really an image" check.
fn image_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn store_art(app: &AppHandle, name: &str, bytes: &[u8]) -> bool {
    if !valid_art_name(name) || bytes.len() > MAX_IMAGE_BYTES || image_mime(bytes).is_none() {
        return false;
    }
    let dir = downloads_dir(app).join("art");
    let _ = fs::create_dir_all(&dir);
    fs::write(dir.join(name), bytes).is_ok()
}

/// A number the page may send as a number or a numeric string ("2019").
fn json_u64(v: &serde_json::Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f.round() as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// An index entry as sent to the SPA, with a ready-to-use `src` for the audio element.
fn to_item(entry: &Entry) -> serde_json::Value {
    serde_json::json!({
        "videoId": entry.video_id,
        "title": entry.title,
        "artist": entry.artist,
        "ext": entry.ext,
        "mime": entry.mime,
        "bytes": entry.bytes,
        "added": entry.added,
        "src": src_url(&entry.video_id),
    })
}

/// Platform-correct URL for the skdl:// scheme. Tauri serves custom schemes at
/// `http://<scheme>.localhost/...` on Windows and `<scheme>://localhost/...` elsewhere.
fn art_url(name: &str) -> String {
    format!("{}/art/{name}", src_url("").trim_end_matches('/'))
}

fn src_url(id: &str) -> String {
    #[cfg(windows)]
    {
        format!("http://skdl.localhost/{id}")
    }
    #[cfg(not(windows))]
    {
        format!("skdl://localhost/{id}")
    }
}

// ---------------------------------------------------------------------------
// Index storage helpers
// ---------------------------------------------------------------------------

fn downloads_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("downloads")
}

fn index_path(app: &AppHandle) -> PathBuf {
    downloads_dir(app).join("index.json")
}

fn load_index(app: &AppHandle) -> HashMap<String, Entry> {
    let _guard = INDEX_LOCK.lock();
    fs::read(index_path(app))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn store_index(app: &AppHandle, index: &HashMap<String, Entry>) {
    let _guard = INDEX_LOCK.lock();
    let dir = downloads_dir(app);
    let _ = fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_vec_pretty(index) {
        let _ = fs::write(index_path(app), json);
    }
}

fn upsert_index(app: &AppHandle, entry: Entry) {
    let mut index = load_index(app);
    index.insert(entry.video_id.clone(), entry);
    store_index(app, &index);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/// YouTube ids are 11 chars of [A-Za-z0-9_-]. The SPA only surfaces whitelisted
/// corpus ids; this is a cheap shape guard so the command can trust the SPA.
fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Fallback when YouTube extraction fails: resolve the track through the streaming proxy instead.
///
/// Probes the relay first (HEAD-equivalent GET, body discarded) so we only ever hand
/// `download_ranged` a URL that actually answers, and so the size and mime it reports are the
/// relay's real ones rather than guesses. Returns None — never an error — because the caller
/// already holds the original YouTube failure and will report THAT if this doesn't pan out.
async fn relay_extract(app: &AppHandle, id: &str, job: &Job) -> Option<Extracted> {
    emit_progress(app, id, "extracting", 0, None);

    // A YouTube id is always [A-Za-z0-9_-] (the SPA enforces this with safeId before it
    // ever reaches us). Refusing anything else means the id can go into the URL verbatim —
    // no encoding crate needed — and a malformed id can't smuggle extra query parameters.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let url = format!("{RELAY_DOWNLOAD}?v={id}");
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;

    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // Only accept something that is genuinely audio: a filter that intercepts THIS host too
    // would answer 200 with an HTML block page, and that must not land in the library as .m4a.
    let mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    if !mime.starts_with("audio/") {
        return None;
    }
    let content_length = resp.content_length().filter(|&n| n > 0);
    // Discard the body of the probe; download_ranged will fetch it properly.
    drop(resp);

    Some(Extracted {
        video_id: id.to_string(),
        url,
        mime,
        itag: 0,
        content_length,
        // The relay knows nothing about the song; the queue entry carries the title/artist the
        // SPA passed in, and process() prefers those anyway (see `pick`).
        title: job.title.clone(),
        author: job.artist.clone(),
    })
}

fn ext_for(mime: &str, itag: u32) -> String {
    if mime.contains("audio/mp4") || itag == 140 || itag == 139 || itag == 141 {
        "m4a".into()
    } else if mime.contains("audio/webm") || itag == 251 || itag == 250 || itag == 249 {
        "weba".into()
    } else if mime.contains("video/mp4") || itag == 18 || itag == 22 {
        "mp4".into()
    } else {
        "m4a".into()
    }
}

fn default_mime(ext: &str) -> String {
    match ext {
        "weba" => "audio/webm",
        "mp4" => "video/mp4",
        _ => "audio/mp4",
    }
    .into()
}

fn pick<'a>(a: &'a str, b: &'a str, c: &'a str) -> String {
    let a = a.trim();
    if !a.is_empty() {
        return a.to_string();
    }
    let b = b.trim();
    if !b.is_empty() {
        return b.to_string();
    }
    c.trim().to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
