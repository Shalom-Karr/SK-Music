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
//! Rust fetches the signed URL with `reqwest` in ~1 MiB ranged chunks (which also
//! sidesteps YouTube's slow-path throttling of an untransformed `n`), streams it to
//! `app_data_dir/downloads/<id>.<ext>`, and records it in `downloads/index.json`.
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
/// Ranged download chunk size — small enough to keep YouTube's throttle window from kicking in.
const CHUNK: u64 = 1 << 20; // 1 MiB
/// How long to wait for the extractor webview to hand back a stream URL.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);
/// Browser-ish UA — googlevideo can 403 an obviously-headless client.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Persistent index
// ---------------------------------------------------------------------------

/// One downloaded song, as stored in `downloads/index.json` and sent to the SPA.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    video_id: String,
    title: String,
    artist: String,
    ext: String,  // "m4a" | "weba" | "mp4"
    mime: String, // Content-Type served by the skdl:// handler
    bytes: u64,
    added: u64, // epoch ms
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

    let extracted = match tokio::time::timeout(EXTRACT_TIMEOUT, rx).await {
        Ok(Ok(Ok(x))) => x,
        Ok(Ok(Err(reason))) => {
            pending().lock().unwrap().remove(&id);
            park_extractor(app);
            emit_error(app, &id, &format!("could not read the audio stream: {reason}"));
            return;
        }
        _ => {
            pending().lock().unwrap().remove(&id);
            park_extractor(app);
            emit_error(app, &id, "timed out reading the audio stream");
            return;
        }
    };
    park_extractor(app);

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
    let entry = Entry { video_id: id.clone(), title, artist, ext, mime, bytes: written, added: now_ms() };
    upsert_index(app, entry);
    emit_done(app, &id);
    emit_list(app);
}

/// Download `url` to `path` in ranged chunks. Returns the number of bytes written.
async fn download_ranged(
    app: &AppHandle,
    url: &str,
    path: &PathBuf,
    total_hint: Option<u64>,
    id: &str,
) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    let mut pos: u64 = 0;
    let mut total = total_hint;

    loop {
        let range = format!("bytes={}-{}", pos, pos + CHUNK - 1);
        let resp = client
            .get(url)
            .header(header::RANGE, range)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            // 416 after the last full chunk just means "no more bytes".
            if status.as_u16() == 416 && pos > 0 {
                break;
            }
            return Err(format!("HTTP {status}"));
        }
        let ranged = status.as_u16() == 206;
        if total.is_none() && ranged {
            total = resp
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.rsplit('/').next().map(str::to_string))
                .and_then(|s| s.trim().parse::<u64>().ok());
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let n = bytes.len() as u64;
        if n == 0 {
            break;
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        pos += n;
        emit_progress(app, id, "downloading", pos, total);

        // Server ignored Range (200) => the whole body already arrived.
        if !ranged {
            break;
        }
        if let Some(t) = total {
            if pos >= t {
                break;
            }
        }
        // A short final chunk means we hit EOF.
        if n < CHUNK {
            break;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(pos)
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
    let mut items: Vec<_> = load_index(app).values().map(to_item).collect();
    // Newest first.
    items.sort_by(|a, b| {
        b.get("added").and_then(|v| v.as_u64()).unwrap_or(0)
            .cmp(&a.get("added").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    let _ = app.emit("sk-dl-list", serde_json::json!({ "items": items }));
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
