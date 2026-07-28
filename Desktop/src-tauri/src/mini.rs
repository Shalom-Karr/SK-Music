//! Mini player — a small, borderless, always-on-top window (`mini.html`) that mirrors the main
//! player and drives it remotely.
//!
//! Unlike the main window (which loads the *remote* SPA), the mini player is a **local** page
//! bundled under `frontend/`, so it's a trusted origin and needs no `remote.urls` grant — just the
//! `mini` capability. It never touches the audio itself: every button forwards an action string
//! through `media::control` into the same webview bridge the tray and OS media keys use, and it
//! renders whatever `media.rs` pushes at it (`sk-np` / `sk-state` events, plus a `mini_sync` pull on
//! open). That keeps a single source of truth in the web player.
//!
//! State it owns: the last on-screen position (persisted via `settings.rs`, restored on next open),
//! with a small trailing-debounce so a drag doesn't hammer the disk.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Window label; also the event target `media.rs` emits `sk-np`/`sk-state` to.
pub const LABEL: &str = "mini";

/// Expanded footprint (logical px) + screen-edge margin for the default placement.
const MINI_W: f64 = 340.0;
const MINI_H: f64 = 92.0;
const MARGIN: f64 = 24.0;

/// Show/hide the mini player, creating it on first use. Wired to the tray's "Mini player" item.
pub fn toggle(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }
    if let Err(e) = create(app) {
        eprintln!("[mini] failed to create mini player: {e}");
    }
}

fn create(app: &tauri::AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("mini.html".into()))
        .title("SK Music — Mini")
        .inner_size(MINI_W, MINI_H)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(true)
        .build()?;

    // Restore the last position; fall back to the primary monitor's bottom-right corner, then to a
    // safe constant. Set *after* build via LogicalPosition — the builder's initial `position` is
    // treated as physical on some Windows setups, which would misplace it on HiDPI displays.
    let (x, y) = crate::settings::mini_pos()
        .or_else(|| default_position(&win))
        .unwrap_or((MARGIN, MARGIN));
    let _ = win.set_position(LogicalPosition::new(x, y));

    hook_move(&win);
    Ok(())
}

/// Bottom-right of the primary monitor's usable area (approximated by full size minus margins).
fn default_position(win: &WebviewWindow) -> Option<(f64, f64)> {
    let monitor = win.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);
    let x = origin.x + size.width - MINI_W - MARGIN;
    let y = origin.y + size.height - MINI_H - MARGIN;
    Some((x, y))
}

/// Persist the position as the window is dragged. `Moved` fires in physical pixels; we convert to
/// logical (so it round-trips through `set_position`) and hand it to the debounced saver.
fn hook_move(win: &WebviewWindow) {
    let w = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(pos) = event {
            let scale = w.scale_factor().unwrap_or(1.0);
            let logical = pos.to_logical::<f64>(scale);
            queue_save(logical.x, logical.y);
        }
    });
}

/// Latest un-persisted position + a flag ensuring exactly one draining worker thread.
static PENDING_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static SAVER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Trailing-debounce the position write: record the newest position, and if no worker is draining,
/// spawn one that flushes every ~400ms until moves stop. Coalesces a whole drag into a handful of
/// writes and always persists the final resting spot.
fn queue_save(x: f64, y: f64) {
    if let Ok(mut p) = PENDING_POS.lock() {
        *p = Some((x, y));
    }
    if SAVER_RUNNING.swap(true, Ordering::SeqCst) {
        return; // a worker is already running
    }
    std::thread::spawn(|| {
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let latest = PENDING_POS.lock().ok().and_then(|mut p| p.take());
            match latest {
                Some((x, y)) => crate::settings::set_mini_pos(x, y),
                None => break, // settled
            }
        }
        SAVER_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// Transport/like/radio from the mini player, whitelisted before it reaches the webview bridge.
#[tauri::command]
pub fn mini_control(app: tauri::AppHandle, action: String) {
    const ALLOWED: [&str; 5] = ["toggle", "next", "previous", "like", "radio"];
    if ALLOWED.contains(&action.as_str()) {
        crate::media::control(&app, &action);
    }
}

/// Pull the last-known now-playing state so a just-opened mini window paints without waiting for the
/// next push. Returns the cached payload with live `playing`/`positionMs` overlaid.
#[tauri::command]
pub fn mini_sync() -> serde_json::Value {
    crate::media::snapshot_value()
}

/// Surface the main window (restore-from-tray / unminimize / focus).
#[tauri::command]
pub fn mini_open_main(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Hide the mini player (the × button); reopened later via the tray.
#[tauri::command]
pub fn mini_hide(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}
