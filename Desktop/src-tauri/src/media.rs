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
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use tauri::Manager;

thread_local! {
    /// Lives only on the Tauri main thread (created in `init`, mutated via
    /// `run_on_main_thread`). `MediaControls` need not be `Send` this way.
    static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
}

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

#[derive(serde::Deserialize)]
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
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    playing: Option<bool>,
    position_ms: Option<u64>,
    stopped: Option<bool>,
}

/// Set full metadata + playback state. Call on track change.
#[tauri::command]
pub fn now_playing(app: tauri::AppHandle, payload: NowPlaying) -> Result<(), String> {
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
        // Mirror the track onto the tray (tooltip + now-playing line), independent of SMTC availability.
        let playing = payload.playing.unwrap_or(true) && !payload.stopped.unwrap_or(false);
        crate::tray::set_now_playing(nonempty(&payload.title), nonempty(&payload.artist), playing);
    })
    .map_err(|e| e.to_string())
}

/// Update only playback status/position (no metadata reload). Call on
/// play/pause/seek and periodic position ticks.
#[tauri::command]
pub fn set_playback_state(app: tauri::AppHandle, payload: PlaybackState) -> Result<(), String> {
    app.run_on_main_thread(move || {
        with_controls(|controls| {
            if let Err(e) =
                controls.set_playback(playback(payload.playing, payload.stopped, payload.position_ms))
            {
                eprintln!("[media] set_playback failed: {e:?}");
            }
        });
        crate::tray::set_playing(payload.playing.unwrap_or(true) && !payload.stopped.unwrap_or(false));
    })
    .map_err(|e| e.to_string())
}
