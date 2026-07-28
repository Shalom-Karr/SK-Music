// SK Music — native desktop shell (Tauri 2).
//
// The window loads the already-deployed web app (https://skmusic.shalomkarr.workers.dev)
// directly; the SPA + search engine + YouTube IFrame player all run unchanged inside the
// system webview. Rust only adds what a browser can't: system tray + background play,
// OS media keys / now-playing, skmusic:// deep links, and a signed auto-updater.

// Hide the extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deeplink;
mod media;
mod mini;
mod settings;
mod tray;
mod updater;

use tauri::Manager;

fn main() {
    // Keep playing while hidden to the tray. WebView2/Chromium otherwise throttles background timers and
    // suspends occluded/hidden renderers, which freezes the YouTube-IFrame audio. These flags disable that
    // — they MUST be set before the webview is created.
    #[cfg(target_os = "windows")]
    {
        let mut args = String::from("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion");
        // Debug builds expose CDP so the webview (incl. the invoke bridge) can be inspected live.
        #[cfg(debug_assertions)]
        args.push_str(" --remote-debugging-port=9333");
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    }

    tauri::Builder::default()
        // single-instance MUST be registered BEFORE deep-link: a second launch
        // (including one triggered by a skmusic:// deep link) is forwarded here so the
        // deep-link plugin can re-emit the URL, and we focus the running window instead
        // of opening a duplicate copy of the app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            deeplink::focus_main_window(app);
        }))
        // Registers the skmusic:// handler; deeplink::init() attaches on_open_url.
        .plugin(tauri_plugin_deep_link::init())
        // Reads endpoints + pubkey from tauri.conf.json; updater::init() drives it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Launch-on-login (optionally minimized). Cross-platform; LaunchAgent is the macOS strategy.
        // The tray's "Start with Windows" item toggles it; the "--minimized" arg is passed to the
        // registered launch command so a login-start comes up hidden to the tray.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // Native "track changed" toasts while hidden (driven from media.rs).
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            media::now_playing,
            media::set_playback_state,
            updater::updater_check,
            updater::updater_restart,
            updater::updater_version,
            mini::mini_control,
            mini::mini_sync,
            mini::mini_open_main,
            mini::mini_hide,
            tray::show_app_menu,
        ])
        .setup(|app| {
            let handle = app.handle();
            // Settings first: the tray reads the persisted notify + autostart state when it builds.
            settings::init(handle)?;
            tray::init(handle)?;
            media::init(handle)?;
            // Sleep/resume self-heal watcher (cross-platform, no Win32).
            media::watch_resume(handle);
            // Auto-show/hide the mini player with the main window's focus.
            mini::init(handle);
            deeplink::init(handle)?;
            updater::init(handle)?;
            // Autostart launched us with "--minimized": come up hidden to the tray.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the SK Music desktop app")
        .run(|_app, event| {
            // Apply a silently-downloaded update on quit so it lands next launch,
            // never mid-playback.
            if let tauri::RunEvent::Exit = event {
                updater::apply_pending_on_exit();
            }
        });
}
