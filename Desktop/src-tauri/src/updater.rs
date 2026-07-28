//! Auto-update: check the minisign-signed manifest on the skmusic origin, download
//! in the background, apply on next launch (never a forced mid-playback restart),
//! plus a user-driven "check now" / "restart to update" path.
//!
//! Flow:
//!   - `init` spawns a background thread that waits `STARTUP_CHECK_DELAY_SECS` then
//!     runs a silent check.
//!   - A found update is downloaded and staged (bytes kept in `PENDING`); the SPA is
//!     told via `updater://ready`.
//!   - The staged update is applied when the user clicks "Restart to update"
//!     (`updater_restart` / tray) or, best-effort, automatically on quit
//!     (`apply_pending_on_exit`), so it lands on the next launch without interrupting
//!     playback.
//!
//! ## Events emitted to the webview (payloads camelCase)
//!   `updater://checking`          `{ userInitiated, currentVersion }`
//!   `updater://update-available`  `{ userInitiated, currentVersion, version, notes }`
//!   `updater://download-progress` `{ downloaded, total, percent }`  (total/percent may be null)
//!   `updater://ready`             `{ userInitiated, currentVersion, version, notes }`
//!   `updater://up-to-date`        `{ userInitiated, currentVersion }`
//!   `updater://error`             `{ userInitiated, message }`
//!
//! Commands the SPA can `invoke`: `updater_check`, `updater_restart`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Tray menu ids/labels — the tray module builds items with these and routes their
/// events through `handle_menu_event`.
pub const MENU_ID_CHECK_UPDATES: &str = "updater_check_updates";
pub const MENU_LABEL_CHECK_UPDATES: &str = "Check for updates…";
pub const MENU_ID_RESTART_UPDATE: &str = "updater_restart_update";
#[allow(dead_code)] // used by the tray once a "restart to apply update" item is shown
pub const MENU_LABEL_RESTART_UPDATE: &str = "Restart to update";

/// Delay the launch check so it doesn't fight the initial shell/dataset load.
const STARTUP_CHECK_DELAY_SECS: u64 = 8;

/// Cap every check + download so a stalled request on a filtered network can't wedge the updater
/// shut forever (a hung check would otherwise leave `CHECK_IN_PROGRESS` true and no-op all later
/// "Check for updates" clicks).
const UPDATE_TIMEOUT_SECS: u64 = 30;

/// Guards against overlapping checks.
static CHECK_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Resets `CHECK_IN_PROGRESS` on drop, so any return path — including an early `?` or a panic that
/// unwinds — clears the guard rather than stranding it true and silently no-oping every later check.
struct CheckGuard;
impl Drop for CheckGuard {
    fn drop(&mut self) {
        CHECK_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}
/// Downloaded-but-not-installed update, awaiting an explicit restart/quit.
static PENDING: Mutex<Option<PendingUpdate>> = Mutex::new(None);

struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

/// Re-check cadence for a long-running (tray-resident) app — the startup check alone never fires
/// again for users who keep it open for weeks.
const RECHECK_INTERVAL_SECS: u64 = 60 * 60 * 24;

/// Kick off the silent check-on-startup, then re-check daily for as long as the app runs.
/// Called from `.setup()`.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(STARTUP_CHECK_DELAY_SECS));
        loop {
            check_for_updates(&handle, false);
            std::thread::sleep(Duration::from_secs(RECHECK_INTERVAL_SECS));
        }
    });
    Ok(())
}

/// Spawn the async check on Tauri's runtime. `user_initiated == false` stays quiet
/// unless an update exists; `true` also surfaces up-to-date and error feedback.
pub fn check_for_updates(app: &AppHandle, user_initiated: bool) {
    if CHECK_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return; // a check is already running
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Clears CHECK_IN_PROGRESS on every exit from this task (Ok, Err, or a panic that unwinds).
        let _guard = CheckGuard;
        if let Err(e) = run_check(&app, user_initiated).await {
            if user_initiated {
                let _ = app.emit(
                    "updater://error",
                    json!({ "userInitiated": user_initiated, "message": e }),
                );
            } else {
                eprintln!("[updater] check failed: {e}");
            }
        }
    });
}

async fn run_check(app: &AppHandle, user_initiated: bool) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let _ = app.emit(
        "updater://checking",
        json!({ "userInitiated": user_initiated, "currentVersion": current }),
    );

    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(UPDATE_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => {
            let _ = app.emit(
                "updater://up-to-date",
                json!({ "userInitiated": user_initiated, "currentVersion": current }),
            );
            return Ok(());
        }
    };

    let version = update.version.clone();
    let notes = update.body.clone();

    // Already staged this exact version? Skip the (identical) re-download the daily loop would
    // otherwise repeat every 24h, and just re-announce readiness so the UI can offer the restart.
    if PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|p| p.update.version == version)
    {
        let _ = app.emit(
            "updater://ready",
            json!({
                "userInitiated": user_initiated,
                "currentVersion": current,
                "version": version,
                "notes": notes,
            }),
        );
        return Ok(());
    }

    let _ = app.emit(
        "updater://update-available",
        json!({
            "userInitiated": user_initiated,
            "currentVersion": current,
            "version": version,
            "notes": notes,
        }),
    );

    let app_dl = app.clone();
    let bytes = update
        .download(
            move |downloaded, total| {
                let percent = total.and_then(|t| {
                    if t > 0 {
                        Some((downloaded as f64 / t as f64) * 100.0)
                    } else {
                        None
                    }
                });
                let _ = app_dl.emit(
                    "updater://download-progress",
                    json!({ "downloaded": downloaded, "total": total, "percent": percent }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    *PENDING.lock().unwrap() = Some(PendingUpdate { update, bytes });

    let _ = app.emit(
        "updater://ready",
        json!({
            "userInitiated": user_initiated,
            "currentVersion": current,
            "version": version,
            "notes": notes,
        }),
    );

    Ok(())
}

/// Install the staged update then relaunch. If nothing is staged, fall back to a
/// fresh (user-initiated) check.
pub fn install_pending_and_restart(app: &AppHandle) {
    let pending = PENDING.lock().unwrap().take();
    match pending {
        Some(p) => {
            // Tear the webviews down BEFORE installing — mirrors the tray Quit path. `install()` on
            // Windows runs the NSIS installer + a hard process::exit(0) with WebView2 still alive,
            // which leaves the profile locked and hangs the immediate NSIS-triggered relaunch.
            for (_, win) in app.webview_windows() {
                let _ = win.destroy();
            }
            match p.update.install(&p.bytes) {
                Ok(()) => {
                    app.restart();
                }
                Err(e) => {
                    let _ = app.emit(
                        "updater://error",
                        json!({ "userInitiated": true, "message": format!("install failed: {e}") }),
                    );
                }
            }
        }
        None => check_for_updates(app, true),
    }
}

/// Best-effort install of a staged update on quit — no-op if nothing pending (also a
/// no-op after `install_pending_and_restart` already consumed it, so no double-install).
pub fn apply_pending_on_exit() {
    if let Some(p) = PENDING.lock().unwrap().take() {
        let _ = p.update.install(&p.bytes);
    }
}

/// Label of the small update-status dialog window.
const WINDOW_LABEL: &str = "updater";

/// Open (or refocus) the update dialog — a local `update.html` that shows the current
/// version and mirrors the live check via the `updater://*` events this module already
/// broadcasts to every window. Created lazily on the first "Check for updates…".
pub fn open_update_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    if let Err(e) = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("update.html".into()),
    )
    .title("SK Music — Updates")
    .inner_size(380.0, 232.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .center()
    .build()
    {
        eprintln!("[updater] failed to open update window: {e}");
    }
}

/// Route tray menu items owned by this module. Returns `true` when handled so the
/// tray module can early-return.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        MENU_ID_CHECK_UPDATES => {
            open_update_window(app); // the dialog narrates the check the next line kicks off
            check_for_updates(app, true);
            true
        }
        MENU_ID_RESTART_UPDATE => {
            install_pending_and_restart(app);
            true
        }
        _ => false,
    }
}

/// SPA "check now" button.
#[tauri::command]
pub fn updater_check(app: AppHandle) {
    check_for_updates(&app, true);
}

/// SPA "restart to apply" button.
#[tauri::command]
pub fn updater_restart(app: AppHandle) {
    install_pending_and_restart(&app);
}

/// The update dialog paints the installed version before any check event arrives.
#[tauri::command]
pub fn updater_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
