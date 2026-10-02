//! Offline downloads (DESKTOP ONLY).
//!
//! Lets the SK Music desktop app save a song's AUDIO for offline playback and then
//! play it from disk instead of the YouTube iframe. Isolated from the rest of the
//! shell: one module, one custom URI scheme, one capability. Nothing here runs for
//! the web-only PWA — the SPA gates every hook behind `SK_NATIVE`.
//!
//! ## How the audio URL is obtained (no signature forging, no yt-dlp)
//! We reuse the SK Video Downloader trick: let YouTube's OWN player produce the
//! signed, PoToken'd stream URL and capture it. SK Music's main webview plays via a
//! cross-origin youtube-nocookie iframe it can't script, so we spin up a SEPARATE
//! hidden Tauri webview navigated to `https://www.youtube.com/watch?v=<id>`. An
//! initialization script (see `EXTRACTOR_JS`) runs on that youtube.com page, reads
//! `ytInitialPlayerResponse` (or the InnerTube player endpoint), picks the best
//! audio-only adaptive format (itag 140 / AAC preferred), deciphers the signature
//! eval-free, and ALSO monkeypatches fetch/XHR to capture the player's own
//! `videoplayback` request (which carries a valid, un-throttled `n`). It hands the
//! resulting URL back by EMITTING `sk-yt-extracted` — a `core:event`, because the
//! youtube webview is remote content and (like the main SPA) can only use events,
//! never app commands.
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
//! ## Event contract (all `core:event`, the only channel remote origins get)
//! SPA (main window) -> Rust:
//!   * `sk-dl-request`      `{ videoId, title, artist }`  — download this song
//!   * `sk-dl-delete`       `{ videoId }`                 — remove a download
//!   * `sk-dl-list-request` `{}`                          — send the current library
//!   * `sk-dl-reveal`       `{ videoId }`                 — show the saved file in the OS file manager
//! Rust -> SPA (main window):
//!   * `sk-dl-progress`       `{ videoId, phase, received, total }`  phase = extracting|downloading
//!   * `sk-dl-done`           `{ videoId, item }`                    item = library entry (+ src)
//!   * `sk-dl-error`          `{ videoId, message }`
//!   * `sk-dl-list`           `{ items: [entry, ...] }`
//!   * `sk-dl-reveal-failed`  `{ videoId, message }`
//! Hidden extractor webview -> Rust:
//!   * `sk-yt-extracted`      `{ videoId, url, mime, itag, contentLength, title, author }`
//!   * `sk-yt-extract-failed` `{ videoId, reason }`

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Listener, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{mpsc, oneshot};

/// Label of the reused hidden extractor window.
const EXTRACTOR_LABEL: &str = "sk-yt-extractor";
/// Ranged download chunk size — keeps each request small enough to stay under YouTube's
/// per-request throttle window while still being large enough to amortise round-trip latency.
const CHUNK: u64 = 2 << 20; // 2 MiB
/// Concurrent range requests in flight. Kept conservative (3) to avoid triggering YouTube's
/// multi-connection throttling / 403 responses while still being meaningfully faster than serial.
const PARALLEL: usize = 3;
/// Per-chunk retry limit before aborting the whole download.
const CHUNK_RETRIES: u32 = 2;
/// How long to wait for the extractor webview to hand back a stream URL.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);
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
/// videoId -> waiting extractor result channel (one in flight, but keyed for safety).
static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<Result<Extracted, String>>>>> =
    OnceLock::new();
/// The single-worker download queue.
static QUEUE: OnceLock<mpsc::UnboundedSender<Job>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<Result<Extracted, String>>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractFailed {
    video_id: String,
    #[serde(default)]
    reason: String,
}

struct Job {
    video_id: String,
    title: String,
    artist: String,
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
                let _ = q.send(Job { video_id: r.video_id, title: r.title, artist: r.artist });
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
            // Off the event thread: building a window from a synchronous handler can deadlock on Windows,
            // and the lookup below is network. The page normally sends everything; this fills any gap.
            tauri::async_runtime::spawn(async move {
                let meta = if valid_id(&meta.video_id) && (meta.album_id.is_none() || meta.artist_photo_url.is_none()) {
                    enrich_meta(meta).await
                } else {
                    meta
                };
                save_offline(&h, meta, false);
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

    // Hidden extractor webview -> Rust
    app.listen("sk-yt-extracted", move |ev| {
        if let Ok(x) = serde_json::from_str::<Extracted>(ev.payload()) {
            if let Some(tx) = pending().lock().unwrap().remove(&x.video_id) {
                let _ = tx.send(Ok(x));
            }
        }
    });
    app.listen("sk-yt-extract-failed", move |ev| {
        if let Ok(f) = serde_json::from_str::<ExtractFailed>(ev.payload()) {
            if let Some(tx) = pending().lock().unwrap().remove(&f.video_id) {
                let _ = tx.send(Err(if f.reason.is_empty() {
                    "extraction failed".into()
                } else {
                    f.reason
                }));
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Download pipeline (runs on the single worker task)
// ---------------------------------------------------------------------------

async fn process(app: &AppHandle, job: Job) {
    let id = job.video_id.clone();

    // Already have it: just re-affirm to the SPA.
    if load_index(app).contains_key(&id) {
        emit_done(app, &id);
        emit_list(app);
        return;
    }

    emit_progress(app, &id, "extracting", 0, None);

    let (tx, rx) = oneshot::channel();
    pending().lock().unwrap().insert(id.clone(), tx);
    open_extractor(app, &id);

    // The hidden extractor loads youtube.com/watch and tries three ways to find an audio
    // URL: the embedded player response, a sniffed googlevideo request from the hidden
    // player, and the InnerTube API. All three need YouTube itself to be reachable, and
    // for a large share of this audience it isn't: a kosher filter blocks youtube.com and
    // googlevideo.com outright, the extractor gets a block page, and every strategy comes
    // up empty — that is the "no audio format found" report.
    //
    // The web app already handles exactly this case by streaming and downloading through
    // the streaming proxy (see RELAY_BASE in assets/ui.html). This
    // gives the desktop downloader the same fallback: when YouTube extraction fails for
    // ANY reason — filter block, timeout, or a YouTube-side change that breaks the
    // scraper — try the relay before giving up. Everything downstream (ranged download,
    // index entry, done event) is unchanged: the relay simply yields an `Extracted`.
    let extracted = match tokio::time::timeout(EXTRACT_TIMEOUT, rx).await {
        Ok(Ok(Ok(x))) => {
            park_extractor(app);
            x
        }
        Ok(Ok(Err(reason))) => {
            pending().lock().unwrap().remove(&id);
            park_extractor(app);
            match relay_extract(app, &id, &job).await {
                Some(x) => x,
                None => {
                    emit_error(app, &id, &format!("could not read the audio stream: {reason}"));
                    return;
                }
            }
        }
        _ => {
            pending().lock().unwrap().remove(&id);
            park_extractor(app);
            match relay_extract(app, &id, &job).await {
                Some(x) => x,
                None => {
                    emit_error(app, &id, "timed out reading the audio stream");
                    return;
                }
            }
        }
    };

    let ext = ext_for(&extracted.mime, extracted.itag);
    let mime = if extracted.mime.is_empty() {
        default_mime(&ext)
    } else {
        extracted.mime.clone()
    };
    let dir = downloads_dir(app);
    if let Err(e) = fs::create_dir_all(&dir) {
        emit_error(app, &id, &format!("cannot create downloads folder: {e}"));
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
            emit_error(app, &id, &format!("download failed: {e}"));
            return;
        }
    };
    if written == 0 {
        let _ = fs::remove_file(&part);
        emit_error(app, &id, "download produced an empty file");
        return;
    }
    if let Err(e) = fs::rename(&part, &final_path) {
        let _ = fs::remove_file(&part);
        emit_error(app, &id, &format!("could not finalize file: {e}"));
        return;
    }

    let title = pick(&job.title, &extracted.title, &id);
    let artist = pick(&job.artist, &extracted.author, "");
    let entry = Entry { video_id: id.clone(), title, artist, ext, mime, bytes: written, added: now_ms(), ..Default::default() };
    upsert_index(app, entry);
    emit_done(app, &id);
    emit_list(app);
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
// Hidden extractor webview
// ---------------------------------------------------------------------------

/// Create (or reuse + re-navigate) the hidden youtube.com extractor webview for `id`.
fn open_extractor(app: &AppHandle, id: &str) {
    let target = format!("https://www.youtube.com/watch?v={id}");
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let url = match Url::parse(&target) {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Some(win) = app.get_webview_window(EXTRACTOR_LABEL) {
            let _ = win.navigate(url);
        } else {
            let _ = WebviewWindowBuilder::new(&app, EXTRACTOR_LABEL, WebviewUrl::External(url))
                .title("SK Music helper")
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .inner_size(400.0, 300.0)
                .initialization_script(EXTRACTOR_JS)
                .build();
        }
    });
}

/// Send the extractor to about:blank between jobs so the youtube player stops
/// buffering/using the network while a download runs (and while idle).
fn park_extractor(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window(EXTRACTOR_LABEL) {
            if let Ok(url) = Url::parse("about:blank") {
                let _ = win.navigate(url);
            }
        }
    });
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
// "Save for offline" — fetched by the WEBVIEW, not by reqwest
// ---------------------------------------------------------------------------
//
// The Download pipeline above fetches with reqwest, i.e. Windows' own TLS stack. Behind a
// TLS-intercepting filter (Techloq, Bitdefender web scan…) that path fails where the webview —
// Chromium's network stack — streams music through the same filter fine. So a save runs in a hidden
// window on a LOCAL page (frontend/saver.html): it asks `offline_saver_job` what to fetch, pulls the
// cover / album cover / artist photo with fetch() and hands them back through `offline_store_image`,
// then navigates to the relay's /download URL. That answers `Content-Disposition: attachment`, so the
// webview's own download manager writes the song wherever `on_download` points it. Images the webview
// couldn't get (a host without CORS, a filter) are retried with reqwest once the song has landed; an
// image that still fails just leaves the placeholder. The song and its details join the same library
// as Download, so the full app plays it locally and the offline player lists it — grouped by artist
// and album, with artwork.

/// How long a save may take before the hidden window is torn down and the save reported failed
/// (covers a relay that answers with a page instead of a file, or a filter that silently drops it).
const SAVE_TIMEOUT: Duration = Duration::from_secs(180);
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

/// One pending save, keyed by its hidden window's label, so `offline_saver_job` /
/// `offline_store_image` only ever act for the window that owns the job.
#[derive(Clone)]
struct SaveJob {
    relay: String,
    images: Vec<(String, String)>, // (file name under downloads/art, https url)
}
static SAVE_JOBS: OnceLock<Mutex<HashMap<String, SaveJob>>> = OnceLock::new();
fn save_jobs() -> &'static Mutex<HashMap<String, SaveJob>> {
    SAVE_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
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
        let meta = enrich_meta(meta).await; // album + artist photo, looked up natively
        save_offline(&h, meta, true);
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

/// Fill in what the page didn't send — album (id/title/year/cover) and the artist's photo — from the
/// site's own /track, /album and /artists endpoints. Best effort: any failure leaves the field empty
/// and the song still saves, just with a placeholder in that spot.
async fn enrich_meta(mut meta: SaveMeta) -> SaveMeta {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(8)).user_agent(UA).build() else {
        return meta;
    };
    if meta.album_id.is_none() {
        let album_id = site_json(&client, &format!("/track?v={}", meta.video_id))
            .await
            .and_then(|t| t.get("albumId").and_then(|v| v.as_str()).map(str::to_string))
            .filter(|a| !a.is_empty() && a.len() <= 64 && a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        if let Some(aid) = album_id {
            if let Some(al) = site_json(&client, &format!("/album?id={aid}")).await.and_then(|v| v.get("album").cloned()) {
                meta.album = al.get("title").and_then(|v| v.as_str()).map(str::to_string);
                meta.album_year = al.get("year").filter(|v| !v.is_null()).cloned();
                meta.album_cover_url = al.get("thumbnail").and_then(|v| v.as_str()).map(|u| sized_art(u, 480));
                meta.album_id = Some(aid);
            }
        }
    }
    if meta.artist_photo_url.is_none() && !meta.artist.trim().is_empty() {
        let cached = ARTIST_THUMBS.get_or_init(|| Mutex::new(None)).lock().unwrap().clone();
        let map = match cached {
            Some(m) => m,
            None => {
                let mut m = HashMap::new();
                if let Some(list) = site_json(&client, "/artists").await {
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
pub fn save_offline(app: &AppHandle, meta: SaveMeta, native_notices: bool) {
    let id = meta.video_id.clone();
    let name = if meta.title.is_empty() { "This song".to_string() } else { meta.title.clone() };
    if !valid_id(&id) {
        if native_notices { notify(app, "Can't save this one", "Only songs can be saved for offline, not shiurim or podcasts."); }
        return;
    }
    let dir = downloads_dir(app);
    if let Some(e) = load_index(app).get(&id) {
        if dir.join(format!("{}.{}", e.video_id, e.ext)).is_file() {
            if native_notices { notify(app, "Already saved for offline", &name); }
            emit_done(app, &id);
            return;
        }
    }
    let label = format!("sk-offline-{id}");
    if app.get_webview_window(&label).is_some() {
        return; // this song is already being saved
    }
    let _ = fs::create_dir_all(dir.join("art"));
    let part = dir.join(format!("{id}.m4a.part"));
    let _ = fs::remove_file(&part);

    // Only fetch artwork we don't already have (album covers and artist photos are shared).
    let images: Vec<(String, String)> = art_plan(&meta)
        .into_iter()
        .filter(|(file, _)| !dir.join("art").join(file).is_file())
        .collect();
    save_jobs().lock().unwrap().insert(
        label.clone(),
        SaveJob { relay: format!("{RELAY_DOWNLOAD}?v={id}"), images },
    );

    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (h, meta_s, part_s, label_s, done_s) = (app.clone(), meta.clone(), part.clone(), label.clone(), done.clone());
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("saver.html".into()))
        .title("SK Music — saving for offline")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .on_download(move |_webview, event| match event {
            tauri::webview::DownloadEvent::Requested { destination, .. } => {
                *destination = part_s.clone();
                true
            }
            tauri::webview::DownloadEvent::Finished { success, .. } => {
                if !done_s.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    finish_offline_save(&h, &meta_s, &part_s, success, native_notices);
                    end_save_job(&h, &label_s);
                }
                true
            }
            _ => true,
        })
        .build();
    if let Err(e) = built {
        save_jobs().lock().unwrap().remove(&label);
        emit_error(app, &id, "couldn't start saving for offline");
        if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: {e}")); }
        return;
    }
    if native_notices { notify(app, "Saving for offline…", &name); }

    let (h, label_s) = (app.clone(), label);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_TIMEOUT).await;
        if !done.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let _ = fs::remove_file(downloads_dir(&h).join(format!("{id}.m4a.part")));
            end_save_job(&h, &label_s);
            emit_error(&h, &id, "the song didn't start downloading. Check your connection and try again");
            if native_notices { notify(&h, "Couldn't save for offline", &format!("{name}: the download didn't start. Check your connection and try again.")); }
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

/// saver.html: "what am I fetching?" — answered only for the hidden window that owns the job.
#[tauri::command]
pub fn offline_saver_job(window: tauri::WebviewWindow) -> Option<serde_json::Value> {
    let job = save_jobs().lock().unwrap().get(window.label()).cloned()?;
    Some(serde_json::json!({
        "relay": job.relay,
        "images": job.images.iter().map(|(n, u)| serde_json::json!({ "name": n, "url": u })).collect::<Vec<_>>(),
    }))
}

/// saver.html hands back one fetched image as a raw body, named by the `x-sk-name` header. Accepted
/// only for a name its own job asked for, and only if the bytes really are an image.
#[tauri::command]
pub fn offline_store_image(app: AppHandle, window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let name = request
        .headers()
        .get("x-sk-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let wanted = save_jobs()
        .lock()
        .unwrap()
        .get(window.label())
        .map(|j| j.images.iter().any(|(n, _)| *n == name))
        .unwrap_or(false);
    if !wanted {
        return Err("not part of this save".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    if store_art(&app, &name, bytes) { Ok(()) } else { Err("not a usable image".into()) }
}

/// Close the hidden window and, in the background, retry with reqwest any image the webview couldn't
/// fetch — the song is already saved by then, so this can only add artwork, never hold anything up.
fn end_save_job(app: &AppHandle, label: &str) {
    let job = save_jobs().lock().unwrap().remove(label);
    close_window_later(app, label);
    let Some(job) = job else { return };
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = downloads_dir(&h).join("art");
        let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(UA).build() else { return };
        for (name, url) in job.images {
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

/// Move the finished `.part` into the library — but only if it's really audio. A relay error, or a
/// filter's block page, would also "download" successfully as a few KB of HTML.
fn finish_offline_save(app: &AppHandle, meta: &SaveMeta, part: &PathBuf, success: bool, native_notices: bool) {
    let id = meta.video_id.as_str();
    let name = if meta.title.is_empty() { "This song" } else { meta.title.as_str() };
    let looks_like_m4a = || {
        let mut head = [0u8; 8];
        File::open(part).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head[4..8] == b"ftyp"
    };
    let bytes = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if !success || bytes < 16 * 1024 || !looks_like_m4a() {
        let _ = fs::remove_file(part);
        emit_error(app, id, "the song couldn't be fetched for offline. Try again later");
        if native_notices { notify(app, "Couldn't save for offline", &format!("{name}: the song couldn't be fetched. Try again later.")); }
        return;
    }
    let dest = downloads_dir(app).join(format!("{id}.m4a"));
    if fs::rename(part, &dest).is_err() {
        let _ = fs::remove_file(part);
        emit_error(app, id, "the saved song couldn't be stored");
        if native_notices { notify(app, "Couldn't save for offline", name); }
        return;
    }
    upsert_index(app, Entry {
        video_id: id.to_string(),
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        ext: "m4a".into(),
        mime: "audio/mp4".into(),
        bytes,
        added: now_ms(),
        duration_sec: meta.duration_sec.as_ref().and_then(json_u64),
        album_id: meta.album_id.clone().filter(|s| !s.is_empty()),
        album: meta.album.clone().filter(|s| !s.is_empty()),
        album_year: meta.album_year.as_ref().and_then(json_u64).and_then(|y| u32::try_from(y).ok()),
        cover: cover_name(meta),
        album_cover: album_cover_name(meta),
        artist_photo: artist_photo_name(meta),
    });
    emit_done(app, id); // the full app's Downloads list + local playback pick it up live
    if native_notices { notify(app, "Saved for offline", name); }
}

/// A number the page may send as a number or a numeric string ("2019").
fn json_u64(v: &serde_json::Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f.round() as u64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

/// Destroy a hidden save window outside of its own event callback.
fn close_window_later(app: &AppHandle, label: &str) {
    let (h, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        if let Some(w) = h.get_webview_window(&label) {
            let _ = w.destroy();
        }
    });
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

// ---------------------------------------------------------------------------
// Extractor init script (runs in the MAIN world on youtube.com)
// ---------------------------------------------------------------------------

/// Injected into the hidden youtube.com webview. Reads the player response, picks
/// the best audio-only format, deciphers signatures eval-free (YouTube's CSP forbids
/// eval), monkeypatches fetch/XHR to prefer the player's own valid-`n` stream URL,
/// and hands the result back over `core:event`. Adapted (audio-only) from the SK
/// Video Downloader content script.
const EXTRACTOR_JS: &str = r#"
(function () {
  "use strict";
  var VID = null;
  try { VID = new URLSearchParams(location.search).get("v"); } catch (e) {}
  if (!VID || !/^[\w-]{11}$/.test(VID)) return;
  if (window.__skDlDone === VID) return;

  var AUDIO_ITAGS = { 139:1,140:1,141:1,149:1,150:1,256:1,258:1,327:1,328:1,251:1,250:1,249:1 };
  var captured = null;
  function scoreCap(itag, mime) {
    if (itag === 140 || /audio\/mp4/.test(mime)) return 3;
    if (AUDIO_ITAGS[itag] || /audio/.test(mime)) return 2;
    return 0;
  }
  function noteUrl(u) {
    try {
      if (!u || u.indexOf("googlevideo.com/videoplayback") < 0) return;
      var url = new URL(u, location.href);
      var itag = parseInt(url.searchParams.get("itag"), 10);
      var mime = url.searchParams.get("mime") || "";
      var s = scoreCap(itag, mime);
      if (!s) return;
      ["range","rn","rbuf","ump","srfvp","sq","alr"].forEach(function (p) { url.searchParams.delete(p); });
      var clen = parseInt(url.searchParams.get("clen"), 10) || null;
      if (!captured || s > captured.pri) {
        captured = { url: url.toString(), itag: itag, mime: (mime || (s === 3 ? "audio/mp4" : "audio/webm")).split(";")[0], clen: clen, pri: s };
      }
    } catch (e) {}
  }
  try {
    var of = window.fetch;
    if (of) window.fetch = function (a) { try { noteUrl(typeof a === "string" ? a : (a && a.url) || ""); } catch (e) {} return of.apply(this, arguments); };
  } catch (e) {}
  try {
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { try { noteUrl(u); } catch (e) {} return ox.apply(this, arguments); };
  } catch (e) {}

  var cipherCache = null;
  function getBaseJs() {
    var path = null;
    try { if (window.ytcfg && ytcfg.get) path = ytcfg.get("PLAYER_JS_URL"); } catch (e) {}
    if (!path) { var m = document.documentElement.innerHTML.match(/"(\/s\/player\/[^"]+base\.js)"/); if (m) path = m[1]; }
    if (!path) return Promise.resolve(null);
    var url = path.indexOf("http") === 0 ? path : "https://www.youtube.com" + path;
    return fetch(url).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; });
  }
  var DEC_RE = [
    /\b([a-zA-Z0-9$]{2,})\s*=\s*function\(\s*([a-zA-Z0-9$]+)\s*\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)\s*;[\s\S]+?return\s+\2\.join\(\s*""\s*\)\s*\}/,
    /(?:\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2,})\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\)[\s\S]+?return a\.join\(\s*""\s*\)\s*\}/
  ];
  function buildCipher(body) {
    var name = null;
    for (var i = 0; i < DEC_RE.length; i++) { var m = body.match(DEC_RE[i]); if (m) { name = m[1]; break; } }
    if (!name) return null;
    var esc = name.replace(/[$]/g, "\\$&");
    var fnMatch = body.match(new RegExp(esc + "=function\\(\\s*[a-zA-Z0-9$]+\\s*\\)\\{([\\s\\S]+?)\\}"));
    if (!fnMatch) return null;
    var fnBody = fnMatch[1];
    var objMatch = fnBody.match(/;\s*([a-zA-Z0-9$]+)\./);
    if (!objMatch) return null;
    var objEsc = objMatch[1].replace(/[$]/g, "\\$&");
    var objBody = (body.match(new RegExp("var " + objEsc + "=\\{([\\s\\S]+?)\\};")) || [])[1];
    if (!objBody) return null;
    var ops = {};
    objBody.split(/,\s*(?=[a-zA-Z0-9$]+:function)/).forEach(function (part) {
      var nm = (part.match(/^([a-zA-Z0-9$]+):/) || [])[1];
      if (!nm) return;
      if (/reverse\(\)/.test(part)) ops[nm] = { t: "reverse" };
      else if (/splice\(/.test(part)) ops[nm] = { t: "splice" };
      else if (/var\s+c=/.test(part) || /\[0\]/.test(part)) ops[nm] = { t: "swap" };
    });
    var seq = [], callRe = new RegExp(objEsc + "\\.([a-zA-Z0-9$]+)\\([a-zA-Z0-9$]+,(\\d+)\\)", "g"), c;
    while ((c = callRe.exec(fnBody))) { var op = ops[c[1]]; if (op) seq.push({ t: op.t, n: parseInt(c[2], 10) }); }
    if (!seq.length) return null;
    return function (sig) {
      var arr = sig.split("");
      for (var k = 0; k < seq.length; k++) {
        var st = seq[k];
        if (st.t === "reverse") arr.reverse();
        else if (st.t === "splice") arr.splice(0, st.n);
        else if (st.t === "swap") { var tmp = arr[0]; arr[0] = arr[st.n % arr.length]; arr[st.n % arr.length] = tmp; }
      }
      return arr.join("");
    };
  }
  function getCipher() {
    if (cipherCache !== null) return Promise.resolve(cipherCache);
    return getBaseJs().then(function (body) { cipherCache = body ? buildCipher(body) : null; return cipherCache; }).catch(function () { cipherCache = null; return null; });
  }
  function resolveUrl(fmt) {
    if (fmt.url) return Promise.resolve(fmt.url);
    var cipher = fmt.signatureCipher || fmt.cipher;
    if (!cipher) return Promise.resolve(null);
    var params = new URLSearchParams(cipher);
    var url = params.get("url"), s = params.get("s"), sp = params.get("sp") || "signature";
    if (!url) return Promise.resolve(null);
    if (!s) return Promise.resolve(url);
    return getCipher().then(function (c) { return c ? url + "&" + sp + "=" + encodeURIComponent(c(s)) : null; });
  }

  function grabPlayerResponse() {
    try { if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.streamingData) return window.ytInitialPlayerResponse; } catch (e) {}
    try {
      var args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      if (args) {
        if (args.raw_player_response && args.raw_player_response.streamingData) return args.raw_player_response;
        if (typeof args.player_response === "string") { var p = JSON.parse(args.player_response); if (p && p.streamingData) return p; }
      }
    } catch (e) {}
    return null;
  }
  function ytCfg(key, fb) { try { if (window.ytcfg && ytcfg.get) { var v = ytcfg.get(key); if (v) return v; } } catch (e) {} return fb; }
  function fetchInnertube(id) {
    var key = ytCfg("INNERTUBE_API_KEY", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8");
    var cv = ytCfg("INNERTUBE_CLIENT_VERSION", "2.20240401.00.00");
    return fetch("/youtubei/v1/player?key=" + encodeURIComponent(key) + "&prettyPrint=false", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: id, context: { client: { clientName: "WEB", clientVersion: cv, hl: "en" } }, contentCheckOk: true, racyCheckOk: true })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { return j && j.streamingData ? j : null; }).catch(function () { return null; });
  }

  function pickAudio(pr) {
    var af = (pr.streamingData && pr.streamingData.adaptiveFormats) || [];
    var audios = af.filter(function (f) { return /audio/i.test(f.mimeType || ""); });
    audios.sort(function (a, b) {
      var am = /audio\/mp4/i.test(a.mimeType || "") ? 1 : 0, bm = /audio\/mp4/i.test(b.mimeType || "") ? 1 : 0;
      if (am !== bm) return bm - am;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });
    if (audios.length) return audios[0];
    var prog = (pr.streamingData && pr.streamingData.formats) || [];
    var m18 = prog.filter(function (f) { return f.itag === 18; });
    return m18.length ? m18[0] : null;
  }
  function mimeOf(f) { return ((f.mimeType || "").split(";")[0]) || "audio/mp4"; }

  function emitResult(url, mime, itag, clen, meta) {
    window.__skDlDone = VID;
    try { window.__TAURI__.event.emit("sk-yt-extracted", { videoId: VID, url: url, mime: mime, itag: itag || 0, contentLength: clen || null, title: (meta && meta.title) || "", author: (meta && meta.author) || "" }); } catch (e) {}
  }
  function emitFail(reason) {
    window.__skDlDone = VID;
    try { window.__TAURI__.event.emit("sk-yt-extract-failed", { videoId: VID, reason: String(reason || "") }); } catch (e) {}
  }

  function run() {
    try { var v = document.querySelector("video"); if (v) { v.muted = true; var pp = v.play && v.play(); if (pp && pp.catch) pp.catch(function () {}); } } catch (e) {}
    var pr = grabPlayerResponse(), tries = 0;
    (function poll() {
      pr = pr || grabPlayerResponse();
      if (!pr && tries++ < 12) { setTimeout(poll, 400); return; }
      (pr ? Promise.resolve(pr) : fetchInnertube(VID)).then(function (resp) {
        var meta = resp && resp.videoDetails ? { title: resp.videoDetails.title, author: resp.videoDetails.author } : {};
        var fmt = resp ? pickAudio(resp) : null;
        (fmt ? resolveUrl(fmt) : Promise.resolve(null)).then(function (prUrl) {
          var waited = 0;
          (function waitCap() {
            if ((captured && captured.pri >= 3) || waited >= 4500) {
              if (captured && (!prUrl || captured.pri >= 2)) return emitResult(captured.url, captured.mime, captured.itag, captured.clen, meta);
              if (prUrl) return emitResult(prUrl, fmt ? mimeOf(fmt) : "audio/mp4", fmt ? fmt.itag : 0, (fmt && fmt.contentLength) ? parseInt(fmt.contentLength, 10) : null, meta);
              if (captured) return emitResult(captured.url, captured.mime, captured.itag, captured.clen, meta);
              return emitFail("no audio format found");
            }
            waited += 300; setTimeout(waitCap, 300);
          })();
        });
      });
    })();
  }
  run();
})();
"#;
