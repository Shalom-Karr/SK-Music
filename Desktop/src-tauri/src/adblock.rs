//! YouTube/Google ad blocking for the main webview.
//!
//! Songs play through YouTube's IFrame player, and YouTube can put an ad in front of (or in the middle
//! of) a song. The web app mutes and hides anything that looks like an ad (assets/ui.html, "Ad guard"),
//! but here we can do better: the webview never fetches the ad in the first place. WebView2's
//! WebResourceRequested hook answers every request matching `is_blocked` with an empty 204, so the ad
//! decision, the ad media and the ad beacons all die before they leave the machine.
//!
//! The rules are deliberately narrow. Ad-serving domains are blocked outright; on YouTube's own hosts
//! only ad endpoints are, so the player, the IFrame API, thumbnails (i.ytimg.com) and the media itself
//! (googlevideo.com/videoplayback) are never touched.

/// Ad-serving domains, blocked with every subdomain.
const BLOCKED_DOMAINS: &[&str] = &[
    "doubleclick.net",         // googleads.g., static. (instream/ad_status.js), ad., pubads.g., …
    "googlesyndication.com",   // pagead2., tpc.
    "googleadservices.com",    // conversion tracking
    "googletagservices.com",   // GPT ad tags
    "imasdk.googleapis.com",   // the IMA SDK the embed uses to run ads
    "adservice.google.com",
];

/// Hosts (and their subdomains) where only the ad paths below are blocked.
const AD_PATH_HOSTS: &[&str] = &["youtube.com", "youtube-nocookie.com", "google.com"];

/// Path prefixes on `AD_PATH_HOSTS` that only ever serve ads or ad measurement.
const AD_PATHS: &[&str] = &[
    "/pagead/",                     // ad view / conversion beacons, paralleladview, adview
    "/api/stats/ads",               // ad playback stats
    "/get_midroll_info",            // mid-roll ad decision
    "/pcs/activeview",              // ad viewability
    "/youtubei/v1/player/ad_break", // server-scheduled ad breaks
];

/// Split a URL into (lower-cased host, path). None for anything without an http(s) authority.
fn host_and_path(url: &str) -> Option<(String, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = host_port.split(':').next().unwrap_or(host_port).trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    let tail = &rest[end..];
    let path = if tail.starts_with('/') {
        &tail[..tail.find(['?', '#']).unwrap_or(tail.len())]
    } else {
        "/"
    };
    Some((host.to_ascii_lowercase(), path))
}

fn on_domain(host: &str, domain: &str) -> bool {
    host == domain || (host.len() > domain.len() && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

/// True if a request to `url` is an ad request that must never be fetched.
pub fn is_blocked(url: &str) -> bool {
    let Some((host, path)) = host_and_path(url) else { return false };
    if BLOCKED_DOMAINS.iter().any(|d| on_domain(&host, d)) {
        return true;
    }
    AD_PATH_HOSTS.iter().any(|h| on_domain(&host, h))
        && AD_PATHS.iter().any(|p| path.starts_with(p) || (p.ends_with('/') && path == &p[..p.len() - 1]))
}

/// WebView2 URI filters that pre-select candidate requests, so ordinary traffic (the media segments
/// included) never crosses into the event handler. They are a coarse superset; `is_blocked` decides.
#[cfg(any(windows, test))]
fn filters() -> Vec<String> {
    let mut f = Vec::new();
    for d in BLOCKED_DOMAINS {
        f.push(format!("*://{d}/*"));
        f.push(format!("*://*.{d}/*"));
    }
    for h in AD_PATH_HOSTS {
        for p in AD_PATHS {
            f.push(format!("*://{h}{p}*"));
            f.push(format!("*://*.{h}{p}*"));
        }
    }
    f
}

/// Install the blocker on a webview window. Must run before the page that embeds YouTube loads; the
/// filters live on the CoreWebView2, so they survive the window's index.html → remote-app navigation.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    let res = window.with_webview(|wv| {
        if let Err(e) = unsafe { install_webview2(&wv.controller()) } {
            eprintln!("[adblock] failed to install the ad filter: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("[adblock] webview unavailable: {e}");
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
unsafe fn install_webview2(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
    use windows::core::{Interface, HSTRING, PWSTR};

    let webview = controller.CoreWebView2()?;
    let env = webview.cast::<ICoreWebView2_2>()?.Environment()?;
    // _22 also covers requests from shared/service workers; iframes are covered by both APIs.
    let webview_22 = webview.cast::<ICoreWebView2_22>().ok();
    for f in filters() {
        let f = HSTRING::from(f);
        match &webview_22 {
            Some(w) => w.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &f,
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?,
            None => webview.AddWebResourceRequestedFilter(&f, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?,
        }
    }

    // wry has its own WebResourceRequested handler (custom protocols); it ignores these URIs, and
    // ours ignores everything is_blocked rejects, so the two never answer the same request.
    let mut token = Default::default();
    webview.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Request()?.Uri(&mut uri)?;
            if is_blocked(&take_pwstr(uri)) {
                let response = env.CreateWebResourceResponse(
                    None,
                    204,
                    &HSTRING::from("No Content"),
                    &HSTRING::new(),
                )?;
                args.SetResponse(&response)?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_ad_requests() {
        for url in [
            "https://googleads.g.doubleclick.net/pagead/id",
            "https://static.doubleclick.net/instream/ad_status.js",
            "https://ad.doubleclick.net/ddm/trackclk/N123",
            "https://doubleclick.net/",
            "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
            "https://tpc.googlesyndication.com/simgad/123",
            "https://www.googleadservices.com/pagead/conversion/123/",
            "https://www.googletagservices.com/tag/js/gpt.js",
            "https://imasdk.googleapis.com/js/sdkloader/ima3.js",
            "https://adservice.google.com/ddm/fls/z/",
            "https://www.youtube.com/pagead/paralleladview?ai=x",
            "https://www.youtube.com/pagead/viewthroughconversion/962985656/",
            "https://www.youtube.com/api/stats/ads?ver=2&ns=1",
            "https://www.youtube.com/get_midroll_info?ei=x",
            "https://www.youtube-nocookie.com/pagead/adview?ai=x",
            "https://www.youtube-nocookie.com/api/stats/ads?ver=2",
            "https://www.youtube-nocookie.com/get_midroll_info?ei=x",
            "https://www.youtube.com/pcs/activeview?xai=x",
            "https://www.youtube.com/youtubei/v1/player/ad_break?key=x",
            "https://youtube.com/pagead/adview",
            "https://www.google.com/pagead/1p-user-list/123/",
            "HTTPS://GOOGLEADS.G.DOUBLECLICK.NET/pagead/id",
            "https://googleads.g.doubleclick.net:443/pagead/id",
            "https://www.youtube.com/pagead",
        ] {
            assert!(is_blocked(url), "should block {url}");
        }
    }

    #[test]
    fn allows_playback_and_app_requests() {
        for url in [
            "https://rr3---sn-ab5l6nr6.googlevideo.com/videoplayback?expire=1&itag=251&mime=audio%2Fwebm",
            "https://www.youtube.com/iframe_api",
            "https://www.youtube.com/s/player/abc123/www-widgetapi.vflset/www-widgetapi.js",
            "https://www.youtube.com/s/player/abc123/player_ias.vflset/en_US/base.js",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1",
            "https://www.youtube-nocookie.com/youtubei/v1/player?key=x",
            "https://www.youtube.com/youtubei/v1/player?key=x",
            "https://www.youtube.com/api/stats/qoe?cpn=x",
            "https://www.youtube.com/api/stats/watchtime?cpn=x",
            "https://www.youtube.com/ptracking?video_id=x",
            "https://www.youtube.com/generate_204",
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            "https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp",
            "https://yt3.ggpht.com/abc=s88",
            "https://fonts.googleapis.com/css2?family=Hanken+Grotesk",
            "https://fonts.gstatic.com/s/x.woff2",
            "https://skmusic.shalomkarr.com/",
            "https://skmusic.shalomkarr.com/pagead/not-a-google-host",
            "https://www.youtube.com/watch?v=x&list=/pagead/",
            "https://notdoubleclick.net/",
            "https://doubleclick.net.example.com/",
            "https://example.com/?u=https://googleads.g.doubleclick.net/",
            "https://www.youtube.com/pageadx",
            "http://skdl.localhost/abc",
            "tauri://localhost/index.html",
            "data:text/plain,doubleclick.net",
            "blob:https://skmusic.shalomkarr.com/123",
            "",
        ] {
            assert!(!is_blocked(url), "should allow {url}");
        }
    }

    #[test]
    fn every_blocked_rule_is_reachable_through_a_filter() {
        // The handler only sees what the filters pre-select: each rule needs at least one filter.
        let f = filters();
        for d in BLOCKED_DOMAINS {
            assert!(f.iter().any(|x| x == &format!("*://*.{d}/*")));
            assert!(f.iter().any(|x| x == &format!("*://{d}/*")));
        }
        assert!(f.iter().any(|x| x == "*://*.youtube-nocookie.com/get_midroll_info*"));
        assert!(f.iter().all(|x| !x.contains("googlevideo") && !x.contains("ytimg")));
    }
}
