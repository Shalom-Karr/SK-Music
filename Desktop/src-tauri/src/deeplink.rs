//! Deep links: register the `skmusic://` scheme and route `/song/:id`,
//! `/artists/:id`, `/albums/:id`, `/zemer-playlists/:id`, ... into the SPA.
//!
//! The window loads a **remote** origin (the deployed worker). A deep link is
//! turned into a relative path and driven with `WebviewWindow::navigate` against
//! the fixed worker origin, so a crafted link can never point the webview off the
//! already-whitelisted host (no open-redirect). The relative path is also emitted
//! as a `deep-link` Tauri event so a future bundled-origin build can do
//! client-side routing instead of a full navigation.
//!
//! Accepted link forms (all resolve against the worker origin):
//!   - `skmusic://song/<id>`        (authority form)
//!   - `skmusic:///song/<id>`       (empty-authority / path form)
//!   - `skmusic:song/<id>`          (opaque form)
//!   - `https://skmusic.shalomkarr.workers.dev/song/<id>` (OS-intercepted https)
//! Query + fragment are preserved.

use tauri::{Emitter, Manager, Url};

const WORKER_ORIGIN: &str = "https://skmusic.shalomkarr.workers.dev";
const WORKER_HOST: &str = "skmusic.shalomkarr.workers.dev";
const MAIN_WINDOW: &str = "main";

pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Runtime registration is only effective on Linux and on Windows debug builds;
    // release Windows (installer) and macOS (Info.plist) get the scheme from config
    // (`plugins.deep-link.desktop.schemes`). Best-effort — ignore failures.
    #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
    {
        let _ = app.deep_link().register("skmusic");
    }

    // Links delivered to the already-running app (incl. a second launch that the
    // single-instance plugin forwards here).
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            route(&handle, &url);
        }
    });

    // Cold-start launch URL. macOS already delivers the launch URL through
    // `on_open_url`, so only handle it here on the other platforms to avoid a
    // double navigation.
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            for url in urls {
                route(app, &url);
            }
        }
    }

    Ok(())
}

/// Surface the running window (restores a close-to-tray-hidden window, unminimizes,
/// focuses). Called by the single-instance callback so a second launch focuses
/// instead of duplicating.
pub fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Resolve a deep link to a trusted target and navigate the webview to it.
fn route(app: &tauri::AppHandle, url: &Url) {
    let Some(rel) = map_to_relative(url) else {
        return;
    };
    let Some(target) = resolve(&rel) else {
        return;
    };

    focus_main_window(app);

    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.navigate(target);
    }

    // Additive, non-load-bearing: lets a bundled-origin build route client-side.
    let _ = app.emit("deep-link", rel);
}

/// Extract the app-relative path (with query/fragment) from any accepted link form.
/// Returns `None` for schemes/hosts we don't trust.
fn map_to_relative(url: &Url) -> Option<String> {
    match url.scheme() {
        "skmusic" => {
            let mut segs: Vec<&str> = Vec::new();
            // Authority form: `skmusic://song/<id>` puts "song" in the host.
            if let Some(host) = url.host_str() {
                if !host.is_empty() {
                    segs.push(host);
                }
            }
            for s in url.path().split('/') {
                if !s.is_empty() {
                    segs.push(s);
                }
            }
            let mut rel = if segs.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", segs.join("/"))
            };
            append_query_fragment(&mut rel, url);
            Some(rel)
        }
        "http" | "https" => {
            // Only the whitelisted worker host passes through.
            if url.host_str() == Some(WORKER_HOST) {
                let mut rel = url.path().to_string();
                append_query_fragment(&mut rel, url);
                Some(rel)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn append_query_fragment(rel: &mut String, url: &Url) {
    if let Some(q) = url.query() {
        rel.push('?');
        rel.push_str(q);
    }
    if let Some(f) = url.fragment() {
        rel.push('#');
        rel.push_str(f);
    }
}

/// Resolve a relative path against the fixed worker origin and re-check the result
/// is still on the trusted host — the open-redirect backstop.
fn resolve(rel: &str) -> Option<Url> {
    let base = Url::parse(WORKER_ORIGIN).ok()?;
    let target = base.join(rel).ok()?;
    if target.scheme() == "https" && target.host_str() == Some(WORKER_HOST) {
        Some(target)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(link: &str) -> Option<String> {
        map_to_relative(&Url::parse(link).unwrap())
    }

    #[test]
    fn authority_form() {
        assert_eq!(rel("skmusic://song/abc123").as_deref(), Some("/song/abc123"));
    }

    #[test]
    fn empty_authority_form() {
        assert_eq!(rel("skmusic:///song/abc123").as_deref(), Some("/song/abc123"));
    }

    #[test]
    fn opaque_form() {
        assert_eq!(rel("skmusic:song/abc123").as_deref(), Some("/song/abc123"));
    }

    #[test]
    fn other_routes() {
        assert_eq!(rel("skmusic://artists/UC123").as_deref(), Some("/artists/UC123"));
        assert_eq!(rel("skmusic://albums/xyz").as_deref(), Some("/albums/xyz"));
        assert_eq!(
            rel("skmusic://zemer-playlists/p1").as_deref(),
            Some("/zemer-playlists/p1")
        );
    }

    #[test]
    fn query_and_fragment_preserved() {
        assert_eq!(
            rel("skmusic://song/abc?t=30#x").as_deref(),
            Some("/song/abc?t=30#x")
        );
    }

    #[test]
    fn https_worker_passthrough() {
        assert_eq!(
            rel("https://skmusic.shalomkarr.workers.dev/song/abc").as_deref(),
            Some("/song/abc")
        );
    }

    #[test]
    fn foreign_host_rejected() {
        assert_eq!(rel("https://evil.example.com/song/abc"), None);
        assert_eq!(rel("http://skmusic.shalomkarr.workers.dev/x"), Some("/x".to_string()));
    }

    #[test]
    fn foreign_scheme_rejected() {
        assert_eq!(rel("javascript:alert(1)"), None);
        assert_eq!(rel("file:///etc/passwd"), None);
    }

    #[test]
    fn resolve_backstop_blocks_offsite() {
        // Even if a relative-ish string tried to jump host, join keeps it on-origin.
        assert_eq!(
            resolve("/song/abc").map(|u| u.to_string()).as_deref(),
            Some("https://skmusic.shalomkarr.workers.dev/song/abc")
        );
        // A protocol-relative // path would change host — must be rejected.
        assert_eq!(resolve("//evil.example.com/x"), None);
    }
}
