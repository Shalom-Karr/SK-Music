// SK Music — native desktop shell (Tauri 2).
//
// The window loads the already-deployed web app (https://skmusic.shalomkarr.workers.dev)
// directly; the SPA + search engine + YouTube IFrame player all run unchanged inside the
// system webview. Rust only adds what a browser can't: system tray + background play,
// OS media keys / now-playing, skmusic:// deep links, and a signed auto-updater.

// Hide the extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connectivity;
mod deeplink;
mod download;
#[cfg(target_os = "windows")]
mod jumplist;
mod media;
mod mini;
mod settings;
mod tray;
mod updater;

use tauri::Manager;

/// Fire a cold-start transport action into the remote SPA's media bridge once it exists. On a cold
/// launch the webview is still loading (index.html → connectivity probe → remote app), so
/// `window.__skMediaControl` may not be there yet. Poll the main webview for a bounded window and
/// inject a one-shot, sentinel-guarded snippet: it fires the action exactly once — surviving the
/// index.html→remote navigation and never double-firing even though we re-inject each tick.
fn forward_control_when_ready(app: tauri::AppHandle, action: String) {
    std::thread::spawn(move || {
        let a = serde_json::to_string(&action).unwrap_or_else(|_| "\"\"".to_string());
        let js = format!(
            "(function(a){{\
               if(window.__skColdControlDone)return;\
               if(typeof window.__skMediaControl!=='function')return;\
               window.__skColdControlDone=true;\
               try{{window.__skMediaControl(a);}}catch(e){{}}\
               try{{window.dispatchEvent(new CustomEvent('sk-media-control',{{detail:{{action:a}}}}));}}catch(e){{}}\
             }})({a});"
        );
        // ~20s budget: covers index.html's handoff (bounded by connectivity::WAIT) plus the remote SPA booting.
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval(js.clone());
            }
        }
    });
}

fn main() {
    // FIRST: start the connectivity probe, so it overlaps WebView2 environment creation (0.5–4s)
    // instead of running after it. index.html asks for the verdict on its first script tick and
    // hands off immediately; see src/connectivity.rs.
    connectivity::start();

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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Taskbar jump-list tasks relaunch the exe with --control=<action>; the forwarded argv
            // routes into the same handlers the tray uses, WITHOUT focusing the window.
            if let Some(action) = argv.iter().find_map(|a| a.strip_prefix("--control=")) {
                match action {
                    "mini" => mini::toggle(app),
                    "updates" => {
                        updater::open_update_window(app);
                        updater::check_for_updates(app, true);
                    }
                    "toggle" | "next" | "previous" | "like" | "radio" => media::control(app, action),
                    _ => {}
                }
                return;
            }
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
        // Opens off-site links in the OS browser. Rust-side only (deeplink::init_external_links) —
        // registering the plugin grants the remote SPA nothing, since capabilities are explicit.
        .plugin(tauri_plugin_opener::init())
        // Offline downloads: serve a downloaded song's local audio to the SPA's <audio> element.
        // Custom scheme so the remote-origin page can play it under its `media-src` CSP; supports
        // HTTP Range for scrubbing. All other download plumbing is event-driven (download::init).
        .register_uri_scheme_protocol("skdl", |ctx, req| {
            download::serve_protocol(ctx.app_handle(), &req)
        })
        .invoke_handler(tauri::generate_handler![
            connectivity::origin_status,
            connectivity::origin_recheck,
            media::now_playing,
            media::set_playback_state,
            updater::updater_check,
            updater::updater_restart,
            updater::updater_version,
            updater::updater_last_status,
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
            // The remote SPA reports playback via events, not commands (remote ACL) — hook them.
            media::hook_report_events(handle);
            // Sleep/resume self-heal watcher (cross-platform, no Win32).
            media::watch_resume(handle);
            // Auto-show/hide the mini player with the main window's focus.
            mini::init(handle);
            // Taskbar jump list mirroring the tray's controls.
            #[cfg(target_os = "windows")]
            jumplist::init();
            deeplink::init(handle)?;
            // Off-site links from the SPA → the OS default browser.
            deeplink::init_external_links(handle);
            updater::init(handle)?;
            // The About page's Updates card talks to the updater over events (remote ACL).
            updater::hook_spa_events(handle);
            // Offline downloads: event listeners + the single download worker (src/download.rs).
            download::init(handle)?;
            // Autostart launched us with "--minimized": come up hidden to the tray.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            // COLD-START jump-list task: the exe was launched with --control=<action> while NOT
            // already running, so the single-instance forward path (a 2nd launch) never sees it.
            // Route it here too, otherwise the click silently opens the full app and drops the
            // action. Window ops fire immediately; transport actions must wait for the remote SPA's
            // media bridge to exist, so we poll the webview and fire exactly once when it's ready.
            if let Some(action) =
                std::env::args().find_map(|a| a.strip_prefix("--control=").map(str::to_string))
            {
                let h = handle.clone();
                match action.as_str() {
                    "updates" => {
                        updater::open_update_window(&h);
                        updater::check_for_updates(&h, true);
                    }
                    "mini" => {
                        mini::toggle(&h);
                        if let Some(window) = h.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "toggle" | "next" | "previous" | "like" | "radio" => {
                        forward_control_when_ready(h, action);
                    }
                    _ => {}
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
