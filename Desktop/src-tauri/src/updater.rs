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

/// Last phase-defining `updater://*` broadcast, kept so a dialog that opens (or reloads) after the
/// fact can still paint a verdict. Without it the dialog is only as good as its listeners' timing:
/// `open_update_window` returns as soon as the window is *created*, so a check that resolves before
/// `update.html` finishes loading lands on nobody and leaves the dialog spinning "Checking for
/// updates…" forever. Progress ticks are deliberately not recorded — only phases.
static LAST_STATUS: Mutex<Option<serde_json::Value>> = Mutex::new(None);

/// Broadcast a phase and remember it for `updater_last_status`.
fn emit_status(app: &AppHandle, event: &str, payload: serde_json::Value) {
    *LAST_STATUS.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(json!({ "event": event, "payload": payload }));
    let _ = app.emit(event, payload);
}

/// Spawn the async check on Tauri's runtime. `user_initiated == false` stays quiet in the *SPA*
/// (the payload carries the flag), but every phase is still broadcast so the update dialog can
/// narrate a check it didn't start — including a silent one that failed.
pub fn check_for_updates(app: &AppHandle, user_initiated: bool) {
    if CHECK_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        // A check is already running. Re-announce the phase rather than returning silently: a user
        // who clicks "Check for updates" during the startup check would otherwise get a dialog that
        // never resolves. The in-flight check's own terminal event still lands on the dialog.
        if user_initiated {
            let current = app.package_info().version.to_string();
            emit_status(
                app,
                "updater://checking",
                json!({ "userInitiated": true, "currentVersion": current }),
            );
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Clears CHECK_IN_PROGRESS on every exit from this task (Ok, Err, or a panic that unwinds).
        let _guard = CheckGuard;
        if let Err(e) = run_check(&app, user_initiated).await {
            if !user_initiated {
                eprintln!("[updater] check failed: {e}");
            }
            // Emitted either way: a silent failure must still leave a terminal state behind, or a
            // dialog opened afterwards sits on a stale "Checking…". The SPA keys off userInitiated.
            emit_status(
                &app,
                "updater://error",
                json!({ "userInitiated": user_initiated, "message": e }),
            );
        }
    });
}

async fn run_check(app: &AppHandle, user_initiated: bool) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    emit_status(
        app,
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
            emit_status(
                app,
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
        emit_status(
            app,
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

    emit_status(
        app,
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

    emit_status(
        app,
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
                    emit_status(
                        app,
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

/// Bridge the About page's Updates card. The main window is REMOTE content, so it can't invoke
/// `updater_check` / `updater_version` (the default capability grants core events only) — it emits
/// instead, and we answer:
///   SPA -> Rust : `sk-check-updates {}` · `sk-app-version-request {}`
///   Rust -> SPA : `sk-app-version { version }`
/// The existing `updater://*` broadcasts and the update dialog narrate the check itself, so this is
/// only the trigger + the installed-version readout. Deliberately no "restart to update" event —
/// that button lives on the local dialog (which can invoke `updater_restart` directly), so a
/// compromised remote page can't force a restart mid-playback.
pub fn hook_spa_events(app: &AppHandle) {
    use tauri::Listener;

    let h = app.clone();
    app.listen("sk-check-updates", move |_| {
        open_update_window(&h); // the dialog narrates the check the next line kicks off
        check_for_updates(&h, true);
    });
    let h = app.clone();
    app.listen("sk-app-version-request", move |_| {
        let _ = h.emit(
            "sk-app-version",
            json!({ "version": h.package_info().version.to_string() }),
        );
    });
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

/// The last `updater://*` phase, as `{ event, payload }` (null if nothing has run yet). The dialog
/// calls this on load so it paints a verdict even when the check it was opened alongside resolved
/// before its listeners were attached — the "opens, then spins forever" bug.
#[tauri::command]
pub fn updater_last_status() -> Option<serde_json::Value> {
    LAST_STATUS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
