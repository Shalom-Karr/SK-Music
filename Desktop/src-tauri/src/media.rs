//! OS media controls bridge via `souvlaki`.
//!
//! Publishes now-playing metadata + playback state to the OS media session
//! (Windows SMTC / macOS Now Playing / Linux MPRIS) and forwards hardware
//! media-key / lock-screen events back into the webview's YouTube-IFrame `PB`
//! player. Filtering/gating stays entirely in the webview — the Rust side only
//! relays the *intent* (next/prev/play/pause), never picks the track.
//!
//! ## Why the `souvlaki` object is pinned to the main thread
//! On Windows the SMTC object is bound to the main window's `HWND` and its
//! button events are dispatched on the thread that pumps that window's message
//! loop — i.e. the Tauri main thread. The macOS backend is also `!Send`. So we
//! create the controls in `setup()` (main thread) and stash them in a
//! `thread_local`; every later mutation from a command hops back onto the main
//! thread with `AppHandle::run_on_main_thread`. This needs no `Send` bound on
//! `MediaControls` and keeps the session on its owning thread on every OS.
//!
//! ## JS bridge contract
//!
//! ### webview -> Rust  (report now-playing state)
//! The page reports state by invoking two commands. Because the app loads a
//! **remote** origin, the webview reaches these via the global bridge
//! (`app.withGlobalTauri = true` -> `window.__TAURI__.core.invoke`) and a
//! capability that lists the origin under `remote.urls` (see the module report).
//!
//! On every track change:
//! ```js
//! __TAURI__.core.invoke('now_playing', { payload: {
//!   title:       'Song title',
//!   artist:      'Artist',
//!   album:       'Album or playlist',   // optional
//!   artUrl:      'https://i.ytimg.com/vi/<id>/hqdefault.jpg', // optional, absolute URL
//!   durationMs:  213000,                // optional
//!   positionMs:  0,                      // optional
//!   playing:     true                    // optional (defaults true)
//! }});
//! ```
//! On play/pause/seek and periodic position ticks (cheap; does not reload art):
//! ```js
//! __TAURI__.core.invoke('set_playback_state', { payload: {
//!   playing: false, positionMs: 91000, stopped: false
//! }});
//! ```
//! All string fields are optional; empty/whitespace values are treated as unset.
//!
//! ### Rust -> webview  (deliver OS media-key events)
//! When the OS sends a transport command, Rust evaluates a small controller call
//! on the main window. The page should implement `window.__skMediaControl(action)`;
//! if it is absent the eval is a guarded no-op and a `sk-media-control`
//! `CustomEvent` (`detail.action`) is dispatched on `window` as a fallback hook.
//! Both are always emitted, so the page may adopt either style. Bridge stub:
//! ```js
//! window.__skMediaControl = (action) => {
//!   switch (action) {
//!     case 'play':     PB.play();  break;
//!     case 'pause':    PB.pause(); break;
//!     case 'toggle':   PB.toggle(); break;
//!     case 'next':     next();     break;   // runs through songOK()/gate()
//!     case 'previous': prev();     break;
//!     case 'stop':     PB.stop();  break;
//!     default:
//!       if (action.startsWith('seekby:'))      PB.seekBy(+action.slice(7) / 1000);
//!       else if (action.startsWith('setposition:')) PB.seekTo(+action.slice(12) / 1000);
//!       else if (action.startsWith('setvolume:'))   PB.setVolume(+action.slice(10));
//!       else if (action === 'seekforward') PB.seekBy(10);
//!       else if (action === 'seekback')    PB.seekBy(-10);
//!   }
//! };
//! ```
//! Action strings: `play`, `pause`, `toggle`, `next`, `previous`, `stop`,
//! `seekforward`, `seekback`, `seekby:<ms>` (signed), `setposition:<ms>`,
//! `setvolume:<0..1>`. `Raise` focuses the window (handled natively, not
//! forwarded); `Quit`/`OpenUri` are ignored so background playback is never
//! killed by the OS tile.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use tauri::{Emitter, Manager};

thread_local! {
    /// Lives only on the Tauri main thread (created in `init`, mutated via
    /// `run_on_main_thread`). `MediaControls` need not be `Send` this way.
    static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
}

/// Last now-playing state, cached for the mini player. `now_playing` stores the full incoming
/// payload here (as the same camelCase JSON the webview sent) and `set_playback_state` patches the
/// live `playing`/`position_ms`, so a mini window that opens mid-song can paint instantly via the
/// `mini_sync` command instead of waiting for the next push.
struct Snapshot {
    now_playing: Option<serde_json::Value>,
    playing: bool,
    position_ms: Option<u64>,
}
impl Snapshot {
    const fn new() -> Self {
        Self { now_playing: None, playing: false, position_ms: None }
    }
}
static SNAPSHOT: Mutex<Snapshot> = Mutex::new(Snapshot::new());

/// Title of the last track we ran the toast/change check against — used to fire the "track changed"
/// notification at most once per track (independent of whether the toast was actually shown).
static LAST_TITLE: Mutex<Option<String>> = Mutex::new(None);

/// Wire up the OS media session. Best-effort: a failure here (no D-Bus, SMTC
/// unavailable, headless, ...) is logged and the app keeps running without
/// media-key integration. Must run on the main thread — it is called from
/// `main.rs`'s `.setup()`.
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    match build(app) {
        Ok(controls) => CONTROLS.with(|cell| *cell.borrow_mut() = Some(controls)),
        Err(e) => eprintln!(
            "[media] OS media controls unavailable ({e}); media keys / now-playing disabled"
        ),
    }
    Ok(())
}

fn build(app: &tauri::AppHandle) -> Result<MediaControls, String> {
    #[cfg(target_os = "windows")]
    let hwnd = {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        // Tauri returns `windows::Win32::Foundation::HWND`; `.0` is the raw
        // handle. The `as` cast covers both the pointer and legacy `isize` reprs.
        let handle = window.hwnd().map_err(|e| format!("failed to get HWND: {e}"))?;
        Some(handle.0 as *mut std::ffi::c_void)
    };

    // souvlaki's PlatformConfig.hwnd is a field on EVERY platform (Some on Windows, None elsewhere) — not
    // cfg-gated — so both branches must set it or non-Windows builds fail with a missing-field error.
    #[cfg(not(target_os = "windows"))]
    let hwnd: Option<*mut std::ffi::c_void> = None;

    let config = PlatformConfig {
        dbus_name: "sk_music",
        display_name: "SK Music",
        hwnd,
    };

    let mut controls = MediaControls::new(config).map_err(|e| format!("{e:?}"))?;

    let handle = app.clone();
    controls
        .attach(move |event| on_event(&handle, event))
        .map_err(|e| format!("{e:?}"))?;

    // Surface the transport controls immediately; the first `now_playing` from
    // the webview fills in real metadata.
    let _ = controls.set_playback(MediaPlayback::Paused { progress: None });

    Ok(controls)
}

/// OS transport event -> action string -> webview.
fn on_event(app: &tauri::AppHandle, event: MediaControlEvent) {
    use MediaControlEvent::*;
    let action = match event {
        Play => "play".to_string(),
        Pause => "pause".to_string(),
        Toggle => "toggle".to_string(),
        Next => "next".to_string(),
        Previous => "previous".to_string(),
        Stop => "stop".to_string(),
        Seek(SeekDirection::Forward) => "seekforward".to_string(),
        Seek(SeekDirection::Backward) => "seekback".to_string(),
        SeekBy(SeekDirection::Forward, d) => format!("seekby:{}", d.as_millis()),
        SeekBy(SeekDirection::Backward, d) => format!("seekby:-{}", d.as_millis()),
        SetPosition(pos) => format!("setposition:{}", pos.0.as_millis()),
        SetVolume(v) => format!("setvolume:{v}"),
        Raise => {
            focus_main(app);
            return;
        }
        // Never let the OS tile close the app / hijack navigation: background
        // playback must survive. Ignore.
        OpenUri(_) | Quit => return,
    };
    forward(app, &action);
}

fn forward(app: &tauri::AppHandle, action: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Encode the action as a JS string literal so it can never break out of the
    // call, even though every value is currently module-controlled.
    let a = serde_json::to_string(action).unwrap_or_else(|_| "\"\"".to_string());
    let js = format!(
        "(function(a){{\
           try{{if(typeof window.__skMediaControl==='function'){{window.__skMediaControl(a);}}}}catch(e){{}}\
           try{{window.dispatchEvent(new CustomEvent('sk-media-control',{{detail:{{action:a}}}}));}}catch(e){{}}\
         }})({a});"
    );
    let _ = window.eval(js);
}

/// Relay a transport action from the tray menu into the webview player — the same channel OS
/// media keys use. Public so `tray.rs` can drive Play/Pause/Next/Previous.
pub fn control(app: &tauri::AppHandle, action: &str) {
    forward(app, action);
}

fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn playback(playing: Option<bool>, stopped: Option<bool>, position_ms: Option<u64>) -> MediaPlayback {
    let progress = position_ms.map(|ms| MediaPosition(Duration::from_millis(ms)));
    if stopped.unwrap_or(false) {
        MediaPlayback::Stopped
    } else if playing.unwrap_or(true) {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    }
}

/// Run `f` against the live controls on the main thread; no-op if the session
/// never came up. Callers already provide a main-thread context.
fn with_controls<F: FnOnce(&mut MediaControls)>(f: F) {
    CONTROLS.with(|cell| {
        if let Some(controls) = cell.borrow_mut().as_mut() {
            f(controls);
        }
    });
}

fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// Cache a full now-playing payload for the mini player (see `Snapshot`).
fn store_now_playing(value: serde_json::Value, playing: bool, position_ms: Option<u64>) {
    if let Ok(mut s) = SNAPSHOT.lock() {
        s.now_playing = Some(value);
        s.playing = playing;
        s.position_ms = position_ms;
    }
}

/// Patch only the live playback fields of the cached snapshot (a position/play-pause tick carries no
/// metadata, so the last track stays put).
fn store_playback(playing: bool, position_ms: Option<u64>) {
    if let Ok(mut s) = SNAPSHOT.lock() {
        s.playing = playing;
        if position_ms.is_some() {
            s.position_ms = position_ms;
        }
    }
}

/// Whether the webview last reported active playback — gates the mini player's auto-show.
pub fn is_playing() -> bool {
    SNAPSHOT.lock().map(|s| s.playing).unwrap_or(false)
}

/// The last-known now-playing state as one JSON object, with `playing`/`positionMs` overlaid from the
/// most recent playback tick. Backs the mini player's `mini_sync` command so it can paint on open.
pub fn snapshot_value() -> serde_json::Value {
    let Ok(s) = SNAPSHOT.lock() else {
        return serde_json::json!({});
    };
    let mut v = s.now_playing.clone().unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert("playing".into(), serde_json::json!(s.playing));
        if let Some(p) = s.position_ms {
            obj.insert("positionMs".into(), serde_json::json!(p));
        }
    }
    v
}

/// Fire a native "track changed" toast — but only when the title actually changed, the toggle is on,
/// and the main window is hidden to the tray (otherwise the on-screen UI already shows it). The
/// last-seen title is recorded on every call regardless of the gates, so the change test stays right
/// even across periods where notifications are off.
fn notify_track_change(app: &tauri::AppHandle, title: Option<&str>, artist: Option<&str>) {
    let changed = {
        let Ok(mut last) = LAST_TITLE.lock() else {
            return;
        };
        let changed = last.as_deref() != title;
        *last = title.map(str::to_string);
        changed
    };
    if !changed || !crate::settings::notify_on_track() {
        return;
    }
    let Some(title) = title else {
        return;
    };
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(true) {
            return;
        }
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(format!("♪ {title}"))
        .body(artist.unwrap_or(""))
        .show();
}

/// Detect a system sleep/resume without native window subclassing: sample the monotonic clock and
/// the wall clock across a fixed sleep; if the wall clock advanced far more than the monotonic clock,
/// the machine was suspended in between. On resume the OS often restores the webview in a wedged
/// state (YouTube-IFrame audio silent though "playing"), so after a short grace we ask the web player
/// to self-heal via `resumecheck`. Cross-platform by construction — no Win32 message hooks. Spawned
/// from `.setup()`.
pub fn watch_resume(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        const STEP: Duration = Duration::from_secs(30);
        const SLEEP_THRESHOLD: Duration = Duration::from_secs(90);
        loop {
            let mono = Instant::now();
            let wall = SystemTime::now();
            std::thread::sleep(STEP);
            let mono_elapsed = mono.elapsed();
            // If the clock was set backwards, `duration_since` errors — treat that as "no jump".
            let wall_elapsed = SystemTime::now().duration_since(wall).unwrap_or(mono_elapsed);
            if wall_elapsed > mono_elapsed + SLEEP_THRESHOLD {
                std::thread::sleep(Duration::from_secs(3)); // let network/webview settle
                control(&app, "resumecheck");
            }
        }
    });
}

/// One upcoming track, as sent in `now_playing.queue`. Used to build the tray's "Up Next" submenu.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub title: Option<String>,
    pub artist: Option<String>,
}

// Serialize + Clone (in addition to Deserialize) so the same struct the webview sends can be cached
// and re-emitted verbatim to the mini player.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    art_url: Option<String>,
    duration_ms: Option<u64>,
    position_ms: Option<u64>,
    playing: Option<bool>,
    stopped: Option<bool>,
    // Extras the web bridge may include; all optional, tolerate absence. `video_id` is unused on the
    // Rust side today but carried through for forward-compat; `queue_base`/`queue` drive Up Next.
    video_id: Option<String>,
    queue_base: Option<u64>,
    queue: Option<Vec<QueueEntry>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    playing: Option<bool>,
    position_ms: Option<u64>,
    stopped: Option<bool>,
    /// Repeat-one state, carried through verbatim for the mini player's repeat toggle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repeat: Option<bool>,
}

/// The REMOTE SPA cannot invoke app commands (the capability remote grant covers core-plugin
/// permissions only — app commands are silently denied for remote origins). Events ARE allowed, so
/// the webview reports by `emit`ting these; Rust listens and routes into the same handlers. The
/// commands below stay for local pages and back-compat.
pub fn hook_report_events(app: &tauri::AppHandle) {
    use tauri::Listener;
    let h = app.clone();
    app.listen("sk-np-report", move |event| {
        if let Ok(payload) = serde_json::from_str::<NowPlaying>(event.payload()) {
            let _ = apply_now_playing(&h, payload);
        }
    });
    let h = app.clone();
    app.listen("sk-state-report", move |event| {
        if let Ok(payload) = serde_json::from_str::<PlaybackState>(event.payload()) {
            let _ = apply_playback_state(&h, payload);
        }
    });
    let h = app.clone();
    app.listen("sk-menu", move |_| {
        // Guard against a compromised/looping SPA queueing endless blocking modal popups: only one
        // sk-menu-driven popup at a time. Set before the (blocking) popup, cleared when it returns.
        if MENU_OPEN.swap(true, Ordering::SeqCst) {
            return;
        }
        crate::tray::show_app_menu_inner(&h);
        MENU_OPEN.store(false, Ordering::SeqCst);
    });
}

/// True while an `sk-menu`-driven tray popup is on screen — rate-limits the remote SPA to one.
static MENU_OPEN: AtomicBool = AtomicBool::new(false);

/// Set full metadata + playback state. Call on track change.
#[tauri::command]
pub fn now_playing(app: tauri::AppHandle, payload: NowPlaying) -> Result<(), String> {
    apply_now_playing(&app, payload)
}

fn apply_now_playing(app: &tauri::AppHandle, payload: NowPlaying) -> Result<(), String> {
    let app = app.clone();
    let playing = payload.playing.unwrap_or(true) && !payload.stopped.unwrap_or(false);
    let value = serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null);

    // Push the whole payload to the mini player (no-op if it isn't open) and cache it so a
    // freshly-opened mini window can paint immediately via `mini_sync`.
    let _ = app.emit_to(crate::mini::LABEL, "sk-np", &value);
    store_now_playing(value, playing, payload.position_ms);

    // Track-change toast while hidden (self-gated: change / toggle / visibility).
    notify_track_change(&app, nonempty(&payload.title), nonempty(&payload.artist));

    let app_main = app.clone();
    app.run_on_main_thread(move || {
        with_controls(|controls| {
            let meta = MediaMetadata {
                title: nonempty(&payload.title),
                artist: nonempty(&payload.artist),
                album: nonempty(&payload.album),
                cover_url: nonempty(&payload.art_url),
                duration: payload.duration_ms.map(Duration::from_millis),
            };
            if let Err(e) = controls.set_metadata(meta) {
                eprintln!("[media] set_metadata failed: {e:?}");
            }
            if let Err(e) =
                controls.set_playback(playback(payload.playing, payload.stopped, payload.position_ms))
            {
                eprintln!("[media] set_playback failed: {e:?}");
            }
        });
        // Mirror the track onto the tray (tooltip + now-playing line + icon), independent of SMTC
        // availability, and rebuild the "Up Next" submenu from the queue.
        crate::tray::set_now_playing(nonempty(&payload.title), nonempty(&payload.artist), playing);
        crate::tray::set_up_next(&app_main, payload.queue_base, payload.queue.as_deref());
    })
    .map_err(|e| e.to_string())
}

/// Update only playback status/position (no metadata reload). Call on
/// play/pause/seek and periodic position ticks.
#[tauri::command]
pub fn set_playback_state(app: tauri::AppHandle, payload: PlaybackState) -> Result<(), String> {
    apply_playback_state(&app, payload)
}

fn apply_playback_state(app: &tauri::AppHandle, payload: PlaybackState) -> Result<(), String> {
    let app = app.clone();
    let playing = payload.playing.unwrap_or(true) && !payload.stopped.unwrap_or(false);
    let value = serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null);

    // Keep the mini player and the cached snapshot in step with play/pause + position ticks.
    let _ = app.emit_to(crate::mini::LABEL, "sk-state", &value);
    store_playback(playing, payload.position_ms);

    app.run_on_main_thread(move || {
        with_controls(|controls| {
            if let Err(e) =
                controls.set_playback(playback(payload.playing, payload.stopped, payload.position_ms))
            {
                eprintln!("[media] set_playback failed: {e:?}");
            }
        });
        crate::tray::set_playing(playing);
    })
    .map_err(|e| e.to_string())
}
