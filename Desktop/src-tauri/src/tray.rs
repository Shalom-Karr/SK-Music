//! System tray + close-to-tray. Builds the tray icon and its menu (now-playing line, an "Up Next"
//! queue submenu, transport + like/radio, mini-player, Show, Start-with-Windows / notify toggles,
//! Check for updates, Quit) and intercepts the main window's close so the app hides to the tray
//! instead of exiting — the webview (and therefore YouTube-IFrame audio) keeps running in the
//! background. Left-click / double-click the tray icon, or pick "Show SK Music", to restore + focus.
//!
//! The now-playing line + tooltip + Play/Pause label + tray-icon badge are updated live from
//! `media.rs` when the webview reports a track change (`set_now_playing`) or a play/pause
//! (`set_playing`); the queue submenu is rebuilt from the same track-change payload (`set_up_next`).
//! Those handles are stashed in a process-global so the update calls need no window/menu plumbing at
//! the call site.
//!
//! ## The "playing" tray icon
//! Rather than bundle a second asset, the playing-state icon is composited at startup: the app icon's
//! raw RGBA is decoded and a small red play-triangle-on-dark-disc badge is drawn into the
//! bottom-right corner (see `make_playing_icon`). Both variants are cached in the handles and the
//! tray swaps between them as playback starts/stops.

use std::sync::{Mutex, OnceLock};

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager, Wry,
};

use crate::media::QueueEntry;
use crate::{media, updater};

/// Label of the window declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// Live handles we mutate after the tray is built. Tauri's `TrayIcon`/`MenuItem`/`Submenu` are
/// thread-safe handles that proxy mutations to the main thread, so holding them in a global is sound;
/// every mutation is still driven from a main-thread context (media.rs calls in from inside
/// `run_on_main_thread`).
struct TrayHandles {
    tray: TrayIcon<Wry>,
    /// The whole tray menu — also popped up in-window by `show_app_menu` (right-click in the app).
    menu: Menu<Wry>,
    now_playing: MenuItem<Wry>,
    play_pause: MenuItem<Wry>,
    up_next: Submenu<Wry>,
    autostart: CheckMenuItem<Wry>,
    notify: CheckMenuItem<Wry>,
    auto_mini: CheckMenuItem<Wry>,
    /// App icon and its play-badged variant, built once. `None` if the app has no default icon.
    icon_idle: Option<Image<'static>>,
    icon_playing: Option<Image<'static>>,
    /// Which variant is currently shown, so we don't re-set the icon on every position tick.
    last_icon_playing: bool,
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

    // "Up Next" queue, rebuilt by `set_up_next`; starts with a disabled placeholder.
    let up_next_i = Submenu::with_id(app, "up_next", "Up Next", true)?;
    let up_next_placeholder =
        MenuItem::with_id(app, "upnext_end", "(end of queue)", false, None::<&str>)?;
    up_next_i.append(&up_next_placeholder)?;

    // Transport controls forward into the webview player via media.rs's bridge.
    let play_pause_i = MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
    let next_i = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev_i = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let like_i = MenuItem::with_id(app, "like", "Like this song", true, None::<&str>)?;
    let radio_i = MenuItem::with_id(app, "radio", "Start radio from this song", true, None::<&str>)?;

    let mini_i = MenuItem::with_id(app, "mini", "Mini player", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", "Show SK Music", true, None::<&str>)?;

    // Reflect the OS autostart registration + persisted notify setting in two check items.
    let autostart_enabled = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    };
    let autostart_i = CheckMenuItem::with_id(
        app,
        "autostart_toggle",
        "Start with Windows",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let notify_i = CheckMenuItem::with_id(
        app,
        "notify_toggle",
        "Notify on track change",
        true,
        crate::settings::notify_on_track(),
        None::<&str>,
    )?;
    let auto_mini_i = CheckMenuItem::with_id(
        app,
        "auto_mini_toggle",
        "Mini player when unfocused",
        true,
        crate::settings::auto_mini(),
        None::<&str>,
    )?;

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
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let sep5 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &now_playing_i,
            &sep1,
            &up_next_i,
            &sep2,
            &play_pause_i,
            &next_i,
            &prev_i,
            &like_i,
            &radio_i,
            &sep3,
            &mini_i,
            &show_i,
            &sep4,
            &autostart_i,
            &notify_i,
            &auto_mini_i,
            &sep5,
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
                "like" => media::control(app, "like"),
                "radio" => media::control(app, "radio"),
                "mini" => crate::mini::toggle(app),
                "autostart_toggle" => toggle_autostart(app),
                "notify_toggle" => toggle_notify(),
                "auto_mini_toggle" => toggle_auto_mini(),
                // The only real exit path: close-to-tray means the window's X never quits.
                // Destroy the webviews FIRST so WebView2 tears down its profile locks cleanly —
                // a hard process exit leaves them lingering and a fast relaunch hangs on them.
                "quit" => {
                    for (_, win) in app.webview_windows() {
                        let _ = win.destroy();
                    }
                    app.exit(0);
                }
                // "Up Next" entries: id is `upnext_<absoluteIndex>` -> jump the queue there.
                other => {
                    if let Some(idx) = other.strip_prefix("upnext_") {
                        if idx.parse::<u64>().is_ok() {
                            media::control(app, &format!("playindex:{idx}"));
                        }
                    }
                }
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

    // Cache the idle app icon + a composited "playing" variant (feature 3). Also seed the tray with
    // the idle icon so a missing app icon degrades to Tauri's default rather than panicking.
    let (icon_idle, icon_playing) = build_icons(app);
    if let Some(icon) = icon_idle.clone() {
        builder = builder.icon(icon);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    let _ = HANDLES.set(Mutex::new(TrayHandles {
        tray,
        menu,
        now_playing: now_playing_i,
        play_pause: play_pause_i,
        up_next: up_next_i,
        autostart: autostart_i,
        notify: notify_i,
        auto_mini: auto_mini_i,
        icon_idle,
        icon_playing,
        last_icon_playing: false,
    }));
    Ok(())
}

/// Right-click inside the main window pops the SAME menu as the tray. Reached two ways: the
/// `show_app_menu` command (local pages) and the `sk-menu` event (the REMOTE SPA — remote origins
/// can't invoke app commands, so it emits instead; see media::hook_report_events). Popup position
/// defaults to the cursor.
pub fn show_app_menu_inner(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else { return };
    if let Some(lock) = HANDLES.get() {
        if let Ok(h) = lock.lock() {
            let _ = window.popup_menu(&h.menu);
        }
    }
}

#[tauri::command]
pub fn show_app_menu(app: tauri::AppHandle) {
    show_app_menu_inner(&app);
}

/// Flip the persisted "Mini player when unfocused" setting and mirror it into the check item.
fn toggle_auto_mini() {
    let desired = !crate::settings::auto_mini();
    crate::settings::set_auto_mini(desired);
    if let Some(lock) = HANDLES.get() {
        if let Ok(h) = lock.lock() {
            let _ = h.auto_mini.set_checked(desired);
        }
    }
}

/// Reflect the current track in the tray: tooltip + the disabled header + the Play/Pause label + the
/// tray-icon badge. No-op until the tray is built. Safe to call from any thread (handles proxy to the
/// main thread).
pub fn set_now_playing(title: Option<&str>, artist: Option<&str>, playing: bool) {
    let Some(lock) = HANDLES.get() else { return };
    let Ok(mut h) = lock.lock() else { return };
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
    apply_icon(&mut h, playing);
}

/// Update only the Play/Pause label + tray-icon badge (on play/pause without a track change).
pub fn set_playing(playing: bool) {
    let Some(lock) = HANDLES.get() else { return };
    let Ok(mut h) = lock.lock() else { return };
    let _ = h.play_pause.set_text(if playing { "Pause" } else { "Play" });
    apply_icon(&mut h, playing);
}

/// Rebuild the "Up Next" submenu from a track-change payload's queue. `queue_base` is the absolute
/// queue index of the first entry; item ids are `upnext_<absoluteIndex>` so a click can jump straight
/// there via `playindex:<n>`. Up to 6 entries; an empty/absent queue shows a disabled placeholder.
pub fn set_up_next(app: &tauri::AppHandle, queue_base: Option<u64>, queue: Option<&[QueueEntry]>) {
    let Some(lock) = HANDLES.get() else { return };
    let Ok(h) = lock.lock() else { return };

    // Clear existing children (rebuild wholesale — the list is tiny).
    if let Ok(items) = h.up_next.items() {
        for _ in 0..items.len() {
            let _ = h.up_next.remove_at(0);
        }
    }

    let entries = queue.unwrap_or(&[]);
    if entries.is_empty() {
        if let Ok(end) =
            MenuItem::with_id(app, "upnext_end", "(end of queue)", false, None::<&str>)
        {
            let _ = h.up_next.append(&end);
        }
        return;
    }

    let base = queue_base.unwrap_or(0);
    for (i, e) in entries.iter().take(6).enumerate() {
        let abs = base + i as u64;
        let title = e
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Unknown");
        let label = match e.artist.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(artist) => format!("{}. {} — {}", i + 1, title, artist),
            None => format!("{}. {}", i + 1, title),
        };
        if let Ok(item) = MenuItem::with_id(app, format!("upnext_{abs}"), label, true, None::<&str>) {
            let _ = h.up_next.append(&item);
        }
    }
}

/// Flip OS autostart registration and mirror the result into the check item. The plugin manager
/// bypasses the ACL (Rust-side call), so no capability round-trip is needed.
fn toggle_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let result = if enabled { manager.disable() } else { manager.enable() };
    // Only claim the new state if the toggle actually took.
    let desired = if result.is_ok() { !enabled } else { enabled };
    if let Some(lock) = HANDLES.get() {
        if let Ok(h) = lock.lock() {
            let _ = h.autostart.set_checked(desired);
        }
    }
    if let Err(e) = result {
        eprintln!("[tray] autostart toggle failed: {e}");
    }
}

/// Flip the persisted "Notify on track change" setting and mirror it into the check item. Reading the
/// stored value (not the item's auto-toggled state) keeps settings the single source of truth.
fn toggle_notify() {
    let desired = !crate::settings::notify_on_track();
    crate::settings::set_notify_on_track(desired);
    if let Some(lock) = HANDLES.get() {
        if let Ok(h) = lock.lock() {
            let _ = h.notify.set_checked(desired);
        }
    }
}

/// Swap the tray icon to match playback state, skipping the OS call when nothing changed.
fn apply_icon(h: &mut TrayHandles, playing: bool) {
    if h.last_icon_playing == playing {
        return;
    }
    // Confine the immutable borrow of the cached icons to this block so the mutable write below
    // is unambiguously fine. `None` (app has no icon) counts as applied so we stop retrying.
    let applied = {
        let icon = if playing {
            h.icon_playing.as_ref()
        } else {
            h.icon_idle.as_ref()
        };
        match icon {
            Some(icon) => h.tray.set_icon(Some(icon.clone())).is_ok(),
            None => true,
        }
    };
    if applied {
        h.last_icon_playing = playing;
    }
}

/// The bundled 128px icon, decoded and Lanczos-resized to tray size at startup. Handing the tray
/// the full-size window icon leaves the downscale to Windows, which renders it blurry.
const TRAY_SOURCE: &[u8] = include_bytes!("../icons/128x128.png");
const TRAY_SIZE: u32 = 32;

/// Build the idle + "playing" tray icon variants. Returns `(None, None)` only if both the bundled
/// PNG decode AND the default-window-icon fallback are unavailable.
fn build_icons(app: &tauri::AppHandle) -> (Option<Image<'static>>, Option<Image<'static>>) {
    let idle = image::load_from_memory(TRAY_SOURCE)
        .ok()
        .map(|img| {
            let small = img
                .resize_exact(TRAY_SIZE, TRAY_SIZE, image::imageops::FilterType::Lanczos3)
                .into_rgba8();
            Image::new_owned(small.into_raw(), TRAY_SIZE, TRAY_SIZE)
        })
        .or_else(|| {
            app.default_window_icon()
                .map(|b| Image::new_owned(b.rgba().to_vec(), b.width(), b.height()))
        });
    let Some(idle) = idle else {
        return (None, None);
    };
    let playing = make_playing_icon(&idle).unwrap_or_else(|| idle.clone());
    (Some(idle), Some(playing))
}

/// Composite a play-triangle-on-dark-disc badge into the bottom-right corner of the app icon.
/// Operates on the raw RGBA the icon already carries — no codec, no bundled asset.
fn make_playing_icon(base: &Image) -> Option<Image<'static>> {
    let (w, h) = (base.width(), base.height());
    let mut img = image::RgbaImage::from_raw(w, h, base.rgba().to_vec())?;

    let dim = w.min(h) as f32;
    let radius = dim * 0.30;
    let margin = dim * 0.06;
    let cx = w as f32 - radius - margin;
    let cy = h as f32 - radius - margin;

    let disc = [22u8, 16, 18, 235]; // near-opaque dark disc
    let rim = [255u8, 240, 235, 255]; // faint light edge
    let tri = [255u8, 93, 107, 255]; // primary red #ff5d6b

    // Bounding box around the disc, clamped to the image.
    let x0 = (cx - radius - 1.0).floor().max(0.0) as u32;
    let y0 = (cy - radius - 1.0).floor().max(0.0) as u32;
    let x1 = ((cx + radius + 1.0).ceil() as u32).min(w);
    let y1 = ((cy + radius + 1.0).ceil() as u32).min(h);

    // Disc with a 1px anti-aliased edge + a subtle rim.
    for y in y0..y1 {
        for x in x0..x1 {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let cov = (radius - dist + 0.5).clamp(0.0, 1.0);
            if cov > 0.0 {
                let px = img.get_pixel_mut(x, y);
                blend(px, disc, cov);
                let rim_cov = (1.0 - (dist - (radius - 1.25)).abs()).clamp(0.0, 1.0) * 0.4;
                blend(px, rim, rim_cov);
            }
        }
    }

    // Play triangle (points right), 2x2 supersampled for smooth edges.
    let top = (cx - radius * 0.34, cy - radius * 0.44);
    let bot = (cx - radius * 0.34, cy + radius * 0.44);
    let apex = (cx + radius * 0.46, cy);
    for y in y0..y1 {
        for x in x0..x1 {
            let mut hits = 0u8;
            for sy in 0..2 {
                for sx in 0..2 {
                    let p = (x as f32 + 0.25 + sx as f32 * 0.5, y as f32 + 0.25 + sy as f32 * 0.5);
                    if in_triangle(p, top, apex, bot) {
                        hits += 1;
                    }
                }
            }
            if hits > 0 {
                blend(img.get_pixel_mut(x, y), tri, hits as f32 / 4.0);
            }
        }
    }

    Some(Image::new_owned(img.into_raw(), w, h))
}

/// Source-over alpha blend of `src` (premultiplied by `cov`) onto `dst`.
fn blend(dst: &mut image::Rgba<u8>, src: [u8; 4], cov: f32) {
    let a = (src[3] as f32 / 255.0) * cov.clamp(0.0, 1.0);
    if a <= 0.0 {
        return;
    }
    for i in 0..3 {
        dst.0[i] = (src[i] as f32 * a + dst.0[i] as f32 * (1.0 - a))
            .round()
            .clamp(0.0, 255.0) as u8;
    }
    let da = dst.0[3] as f32 / 255.0;
    dst.0[3] = ((a + da * (1.0 - a)) * 255.0).round().clamp(0.0, 255.0) as u8;
}

/// Point-in-triangle via the half-plane sign test.
fn in_triangle(p: (f32, f32), a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let sign = |p1: (f32, f32), p2: (f32, f32), p3: (f32, f32)| {
        (p1.0 - p3.0) * (p2.1 - p3.1) - (p2.0 - p3.0) * (p1.1 - p3.1)
    };
    let d1 = sign(p, a, b);
    let d2 = sign(p, b, c);
    let d3 = sign(p, c, a);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Intercept the main window's close request: hide instead of destroy, so playback
/// (and the whole webview) survives in the background until the user picks Quit.
fn hook_close_to_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let win = window.clone();
        let handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
                // Hiding doesn't emit a Focused(false) the mini's focus hook could see — surface
                // the mini explicitly so close-to-tray keeps a control on screen while playing.
                crate::mini::auto_show(&handle);
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
