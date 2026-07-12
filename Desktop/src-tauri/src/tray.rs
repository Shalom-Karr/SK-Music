//! System tray + close-to-tray. Builds the tray icon and its Show/Quit menu, and
//! intercepts the main window's close so the app hides to the tray instead of exiting
//! — the webview (and therefore YouTube-IFrame audio) keeps running in the background.
//! Left-click / double-click the tray icon, or pick "Show SK Music", to restore + focus.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use crate::updater;

/// Label of the window declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    build_tray(app)?;
    hook_close_to_tray(app);
    Ok(())
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show SK Music", true, None::<&str>)?;
    let check_updates_i = MenuItem::with_id(
        app,
        updater::MENU_ID_CHECK_UPDATES,
        updater::MENU_LABEL_CHECK_UPDATES,
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &check_updates_i, &sep, &quit_i])?;

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

    builder.build(app)?;
    Ok(())
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
