//! Tiny persisted settings — a single JSON file in the OS app-config dir.
//!
//! Two things currently outlive a run and want persistence: the "Notify on track change"
//! tray toggle (default OFF) and the mini player's last on-screen position. Rather than a
//! plugin/store dependency for a couple of scalars, this is a hand-rolled load/save of one
//! small struct.
//!
//! The struct is cached in a process-global behind a `Mutex` so hot paths (every track change
//! reads `notify_on_track`, every mini-window drag writes a position) never touch the disk
//! synchronously more than they must: reads hit memory; writes update memory *and* flush the
//! whole file (it's a handful of bytes). `#[serde(default)]` makes every field optional on load,
//! so an older/partial/corrupt file degrades to defaults instead of failing the app.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Show a native toast when the track changes while the window is hidden.
    pub notify_on_track: bool,
    /// Auto-show the mini player while music plays and the main window is unfocused/minimized.
    pub auto_mini: bool,
    /// Last mini-player window position (logical pixels). `None` until it's moved once.
    /// (The collapsed/expanded flag lives in the mini page's localStorage, not here.)
    pub mini_x: Option<f64>,
    pub mini_y: Option<f64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { notify_on_track: false, auto_mini: true, mini_x: None, mini_y: None }
    }
}

struct State {
    path: PathBuf,
    settings: Settings,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

/// Load `settings.json` from the app-config dir into the in-memory cache. Best-effort: a
/// missing/unreadable/garbled file just yields defaults. Call once from `.setup()`, before the
/// tray is built (it reads `notify_on_track` for the initial check state).
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    let dir = app.path().app_config_dir()?;
    let path = dir.join("settings.json");
    let settings = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .unwrap_or_default();
    let _ = STATE.set(Mutex::new(State { path, settings }));
    Ok(())
}

/// Read a snapshot of the current settings (defaults if `init` never ran).
pub fn get() -> Settings {
    STATE
        .get()
        .and_then(|m| m.lock().ok().map(|s| s.settings.clone()))
        .unwrap_or_default()
}

/// Mutate the cached settings under the lock, then flush to disk OUTSIDE the lock. The mutation runs
/// inside the lock so concurrent writers (tray toggle vs. mini drag) can't clobber each other's
/// fields, but the disk I/O (`create_dir_all` + `write`) must not block `get()` — which runs on the
/// main thread on every track/focus change — so we snapshot a clone, drop the guard, then serialize
/// and write.
fn update(f: impl FnOnce(&mut Settings)) {
    let Some(state) = STATE.get() else { return };
    let (path, snapshot) = {
        let Ok(mut guard) = state.lock() else { return };
        f(&mut guard.settings);
        (guard.path.clone(), guard.settings.clone())
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&snapshot) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn notify_on_track() -> bool {
    get().notify_on_track
}

pub fn set_notify_on_track(value: bool) {
    update(|s| s.notify_on_track = value);
}

pub fn auto_mini() -> bool {
    get().auto_mini
}

pub fn set_auto_mini(value: bool) {
    update(|s| s.auto_mini = value);
}

pub fn mini_pos() -> Option<(f64, f64)> {
    let s = get();
    Some((s.mini_x?, s.mini_y?))
}

pub fn set_mini_pos(x: f64, y: f64) {
    update(|s| {
        s.mini_x = Some(x);
        s.mini_y = Some(y);
    });
}
