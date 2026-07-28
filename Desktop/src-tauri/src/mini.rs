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
const MINI_W: f64 = 380.0;
const MINI_H: f64 = 104.0;
const MARGIN: f64 = 24.0;
/// Slack (logical px) allowed around a monitor's usable area when validating a restored position.
const VIS_MARGIN: f64 = 8.0;

/// True while the mini is on screen because WE auto-showed it (main window unfocused during
/// playback) rather than the user opening it — only auto-shown minis auto-hide again.
static AUTO_SHOWN: AtomicBool = AtomicBool::new(false);

/// Auto-show/hide the mini with the main window's state. When a focus change should surface the mini
/// depends on the display setup — which the user asked us to distinguish:
///   • Single monitor   → losing focus means the main window got covered by whatever you switched to,
///                         so a focus change surfaces the mini (the classic "app not in front" behavior).
///   • Multiple monitors → the main window is probably still fully visible on another screen when it
///                         loses focus, so a focus change must NOT pop the mini — that flickered it on
///                         window drags and popped it whenever another screen was clicked. Only MINIMIZE
///                         surfaces the mini on a multi-monitor setup.
/// Minimize/restore is authoritative on any setup and is read on the resize event (minimizing can emit
/// Focused(false) before is_minimized() flips). Monitor count is queried live, so plugging/unplugging a
/// display is picked up on the next focus change. Hooked in `.setup()`.
pub fn init(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    main.on_window_event(move |event| match event {
        // Focus loss counts as "covered" only on a single-monitor setup (see above).
        tauri::WindowEvent::Focused(false) => {
            if monitor_count(&handle) <= 1 {
                auto_show(&handle);
            }
        }
        // Regaining focus (restore / reopen from tray / clicking back to the app) hides the auto-mini.
        tauri::WindowEvent::Focused(true) => auto_hide(&handle),
        // Minimize/restore arrives as a resize; on ANY monitor count, minimize surfaces the mini and
        // restore hides it. (Moving/dragging fires Moved, not Resized, so this never fires on a drag.)
        tauri::WindowEvent::Resized(_) => {
            if let Some(m) = handle.get_webview_window("main") {
                if m.is_minimized().unwrap_or(false) {
                    auto_show(&handle);
                } else {
                    auto_hide(&handle);
                }
            }
        }
        _ => {}
    });
}

/// Number of monitors currently attached. Falls back to 1 — the more-featureful "show on focus loss"
/// default — if the query fails.
fn monitor_count(app: &tauri::AppHandle) -> usize {
    app.get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .map(|m| m.len())
        .unwrap_or(1)
}

/// Surface the mini (subject to the setting + active playback). No-op if it's already visible.
pub(crate) fn auto_show(app: &tauri::AppHandle) {
    if !crate::settings::auto_mini() || !crate::media::is_playing() {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        if win.is_visible().unwrap_or(false) {
            return; // already up (user-opened or a previous auto-show) — leave ownership as-is
        }
        ensure_on_screen(&win); // a display change while hidden could have stranded it off-screen
        let _ = win.show(); // no set_focus: the user just minimized/hid the main on purpose
        AUTO_SHOWN.store(true, Ordering::SeqCst);
        return;
    }
    if create(app, false).is_ok() {
        AUTO_SHOWN.store(true, Ordering::SeqCst);
    }
}

fn auto_hide(app: &tauri::AppHandle) {
    if AUTO_SHOWN.swap(false, Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.hide();
        }
    }
}

/// Ensure the mini is on screen without toggling it away (tray LEFT-click — which also pops the
/// menu, so the mini is intentionally not focused).
pub fn show(app: &tauri::AppHandle) {
    AUTO_SHOWN.store(false, Ordering::SeqCst); // explicit action takes ownership
    if let Some(win) = app.get_webview_window(LABEL) {
        ensure_on_screen(&win);
        let _ = win.show();
        return;
    }
    if let Err(e) = create(app, false) {
        eprintln!("[mini] failed to create mini player: {e}");
    }
}

/// Show/hide the mini player, creating it on first use. Wired to the tray's "Mini player" item.
pub fn toggle(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let visible = win.is_visible().unwrap_or(false);
        // Read ownership BEFORE clearing it: opening the tray menu unfocuses main → auto_show pops
        // the mini (AUTO_SHOWN=true); the user's "Mini player" click that follows must ADOPT that
        // window (keep + focus it), not immediately hide what it never meant to open.
        let was_auto = AUTO_SHOWN.swap(false, Ordering::SeqCst);
        if visible && was_auto {
            ensure_on_screen(&win);
            let _ = win.set_focus();
        } else if visible {
            let _ = win.hide();
        } else {
            ensure_on_screen(&win);
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }
    AUTO_SHOWN.store(false, Ordering::SeqCst); // an explicit toggle takes ownership either way
    if let Err(e) = create(app, true) {
        eprintln!("[mini] failed to create mini player: {e}");
    }
}

fn create(app: &tauri::AppHandle, focused: bool) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("mini.html".into()))
        .title("SK Music — Mini")
        .inner_size(MINI_W, MINI_H)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(true)
        .focused(focused)
        .build()?;

    // Restore the last position, but only if it still lands on a connected monitor — a monitor
    // unplug / resolution drop can leave the saved point off every screen, stranding this
    // borderless, skip-taskbar window with no way to drag it back. Fall back to the primary
    // monitor's bottom-right corner, then to a safe constant. Set *after* build via LogicalPosition
    // — the builder's initial `position` is treated as physical on some Windows setups, which would
    // misplace it on HiDPI displays.
    let (x, y) = crate::settings::mini_pos()
        .filter(|&(x, y)| position_visible(&win, x, y))
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

/// True if the logical top-left `(x, y)` lands on some currently-connected monitor (within a small
/// margin). The off-screen guard for both the restored position and every later show.
fn position_visible(win: &WebviewWindow, x: f64, y: f64) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let o = m.position().to_logical::<f64>(scale);
        let s = m.size().to_logical::<f64>(scale);
        x >= o.x - VIS_MARGIN
            && y >= o.y - VIS_MARGIN
            && x <= o.x + s.width - VIS_MARGIN
            && y <= o.y + s.height - VIS_MARGIN
    })
}

/// Before showing an existing mini window, make sure it isn't stranded off-screen (a display change
/// while it was hidden). If its current top-left is no longer on any monitor, snap it back to the
/// default corner so "show" can never surface an invisible window.
fn ensure_on_screen(win: &WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let on_screen = win
        .outer_position()
        .ok()
        .map(|p| p.to_logical::<f64>(scale))
        .is_some_and(|p| position_visible(win, p.x, p.y));
    if on_screen {
        return;
    }
    let (x, y) = default_position(win).unwrap_or((MARGIN, MARGIN));
    let _ = win.set_position(LogicalPosition::new(x, y));
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
                None => {
                    // Nothing pending: release the flag, then re-check. A queue_save that raced in
                    // between the take() and here saw us still "running" and didn't spawn its own
                    // worker — so reclaim ownership and keep draining; otherwise we're settled and
                    // exit. Without this re-check the final resting position could be lost.
                    SAVER_RUNNING.store(false, Ordering::SeqCst);
                    let straggler = PENDING_POS.lock().map(|p| p.is_some()).unwrap_or(false);
                    if !straggler {
                        break;
                    }
                    if SAVER_RUNNING.swap(true, Ordering::SeqCst) {
                        break; // another worker already reclaimed it
                    }
                }
            }
        }
    });
}

/// Transport/like/radio/seek from the mini player, whitelisted before it reaches the webview bridge.
#[tauri::command]
pub fn mini_control(app: tauri::AppHandle, action: String) {
    const ALLOWED: [&str; 6] = ["toggle", "next", "previous", "like", "radio", "repeat"];
    let seek_ok = action
        .strip_prefix("setposition:")
        .is_some_and(|v| v.parse::<u64>().is_ok());
    if ALLOWED.contains(&action.as_str()) || seek_ok {
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

/// Hide the mini player (the × button); reopened later via the tray. An explicit hide also drops
/// auto-shown ownership so the next main-window focus change starts from a clean slate.
#[tauri::command]
pub fn mini_hide(app: tauri::AppHandle) {
    AUTO_SHOWN.store(false, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}
