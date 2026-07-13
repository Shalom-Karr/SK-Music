//! System tray + close-to-tray. Builds the tray icon and its menu (now-playing line, transport
//! controls, Show / Check for updates / Quit), and intercepts the main window's close so the app
//! hides to the tray instead of exiting — the webview (and therefore YouTube-IFrame audio) keeps
//! running in the background. Left-click / double-click the tray icon, or pick "Show SK Music", to
//! restore + focus.
//!
//! The now-playing line + tooltip + Play/Pause label are updated live from `media.rs` when the
//! webview reports a track change (`set_now_playing`) or a play/pause (`set_playing`). Those handles
//! are stashed in a process-global so the update calls need no window/menu plumbing at the call site.

use std::sync::{Mutex, OnceLock};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager, Wry,
};

use crate::{media, updater};

/// Label of the window declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// Live handles we mutate after the tray is built (tooltip + the two dynamic menu items). Tauri's
/// `TrayIcon`/`MenuItem` are thread-safe handles that proxy mutations to the main thread, so holding
/// them in a global is sound; every mutation is still driven from a main-thread context (media.rs
/// calls in from inside `run_on_main_thread`).
struct TrayHandles {
    tray: TrayIcon<Wry>,
    now_playing: MenuItem<Wry>,
    play_pause: MenuItem<Wry>,
}
static HANDLES: OnceLock<Mutex<TrayHandles>> = OnceLock::new();

pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    build_tray(app)?;
    hook_close_to_tray(app);
    Ok(())
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Disabled header showing the current track; updated by `set_now_playing`.
    let now_playing_i = MenuItem::with_id(app, "np_label", "Not playing", false, None::<&str>)?;
    // Transport controls forward into the webview player via media.rs's bridge.
    let play_pause_i = MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
    let next_i = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev_i = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", "Show SK Music", true, None::<&str>)?;
    let check_updates_i = MenuItem::with_id(
        app,
        updater::MENU_ID_CHECK_UPDATES,
        updater::MENU_LABEL_CHECK_UPDATES,
        true,
        None::<&str>,
    )?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &now_playing_i,
            &sep1,
            &play_pause_i,
            &next_i,
            &prev_i,
            &sep2,
            &show_i,
            &check_updates_i,
            &quit_i,
        ],
    )?;

    // Same id the config tray used, so `app.tray_by_id("main")` keeps resolving.
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("SK Music")
        .menu(&menu)
        // Left-click restores the window (handled below); the menu is right-click only,
        // matching the Windows tray convention.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            // Updater owns "Check for updates" / "Restart to update"; let it claim first.
            if updater::handle_menu_event(app, id) {
                return;
            }
            match id {
                "show" => show_and_focus(app),
                // Transport: relay into the webview player (runs through songOK()/gate()).
                "play_pause" => media::control(app, "toggle"),
                "next" => media::control(app, "next"),
                "previous" => media::control(app, "previous"),
                // The only real exit path: close-to-tray means the window's X never quits.
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_and_focus(tray.app_handle()),
            _ => {}
        });

    // Reuse the app icon compiled in from `bundle.icon`; guarded so a missing icon
    // degrades to Tauri's default rather than panicking.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    let _ = HANDLES.set(Mutex::new(TrayHandles {
        tray,
        now_playing: now_playing_i,
        play_pause: play_pause_i,
    }));
    Ok(())
}

/// Reflect the current track in the tray: tooltip + the disabled header + the Play/Pause label.
/// No-op until the tray is built. Safe to call from any thread (handles proxy to the main thread).
pub fn set_now_playing(title: Option<&str>, artist: Option<&str>, playing: bool) {
    let Some(lock) = HANDLES.get() else { return };
    let Ok(h) = lock.lock() else { return };
    let line = match (title, artist) {
        (Some(t), Some(a)) => format!("{t} — {a}"),
        (Some(t), None) => t.to_string(),
        _ => "SK Music".to_string(),
    };
    let _ = h.tray.set_tooltip(Some(line.as_str()));
    let label = if title.is_some() {
        format!("♪ {line}")
    } else {
        "Not playing".to_string()
    };
    let _ = h.now_playing.set_text(label.as_str());
    let _ = h.play_pause.set_text(if playing { "Pause" } else { "Play" });
}

/// Update only the Play/Pause label (on play/pause without a track change).
pub fn set_playing(playing: bool) {
    let Some(lock) = HANDLES.get() else { return };
    let Ok(h) = lock.lock() else { return };
    let _ = h.play_pause.set_text(if playing { "Pause" } else { "Play" });
}

/// Intercept the main window's close request: hide instead of destroy, so playback
/// (and the whole webview) survives in the background until the user picks Quit.
fn hook_close_to_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let win = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
            }
        });
    }
}

fn show_and_focus(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
