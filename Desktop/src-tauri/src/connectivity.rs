//! Startup connectivity probe — answers "is the SK Music origin reachable?" before the webview is
//! ready to ask.
//!
//! The shell can't hand the window to the remote app until it knows the origin is up: if it isn't,
//! the user must get `frontend/index.html`'s retry card instead of WebView2's raw error page. That
//! check used to live *inside* index.html — a cross-origin `<img>` against `/favicon.ico` with a 9s
//! failure ceiling — so it could only start once WebView2 had booted, fetched the local page and
//! painted it. Every launch therefore paid a full round trip to Cloudflare *after* the slowest part
//! of startup had already finished, in series.
//!
//! Here it runs on the async runtime, kicked off from the first line of `main()` — concurrently with
//! WebView2 environment creation, which measured 0.5–4s on a loaded machine and dwarfs the probe. By
//! the time index.html exists to ask, the verdict is already sitting in this module, so the handoff
//! costs one IPC round trip instead of a network one. Running it early also warms the OS DNS cache
//! for the origin, which the webview's own navigation then reuses.
//!
//! Deliberately NOT persisted across launches: a remembered "last launch was online" flag is wrong
//! exactly when it matters (the laptop that was online yesterday and is on a plane today), and it
//! would buy nothing here — a probe that overlaps WebView2 startup is already free.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::watch;

/// Cheap, always-present object on the origin. A real GET (not a HEAD/TCP connect) is what proves a
/// network filter isn't intercepting us: a filter's proxy completes the handshake happily and then
/// serves its own block page, which fails the status check below.
const PROBE_URL: &str = "https://skmusic.shalomkarr.workers.dev/favicon.ico";
/// Failure ceiling for one probe. index.html used to wait 9s before offering "Try again"; nothing
/// about a reachable Cloudflare edge takes that long, and a blocked launch shouldn't sit on a spinner.
const TIMEOUT: Duration = Duration::from_secs(3);
/// How long a webview asker waits on a still-running probe. A shade over `TIMEOUT` so the probe gets
/// to report its own verdict rather than losing a race to this deadline.
const WAIT: Duration = Duration::from_millis(3_400);

#[derive(Clone, Copy, PartialEq)]
enum Verdict {
    Running,
    Up,
    Down,
}

/// A `watch` rather than a `Mutex` + `Condvar`: askers arrive *after* the probe has usually already
/// landed, and `wait_for` handles both cases (settled → returns immediately; in flight → parks) with
/// no blocking thread held open. The receiver is kept alive in here so `send` can never fail.
static CHANNEL: OnceLock<(watch::Sender<Verdict>, watch::Receiver<Verdict>)> = OnceLock::new();

fn channel() -> &'static (watch::Sender<Verdict>, watch::Receiver<Verdict>) {
    CHANNEL.get_or_init(|| watch::channel(Verdict::Running))
}

/// Kick off a probe. Called once from `main()` before the Tauri builder, and again by the retry
/// button; a re-probe simply re-publishes over whatever the last verdict was.
pub fn start() {
    let _ = channel().0.send(Verdict::Running);
    tauri::async_runtime::spawn(async {
        let reachable = probe().await;
        let _ = channel()
            .0
            .send(if reachable { Verdict::Up } else { Verdict::Down });
    });
}

async fn probe() -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(TIMEOUT).build() else {
        return false;
    };
    match client.get(PROBE_URL).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

async fn verdict() -> bool {
    let mut rx = channel().1.clone();
    // Bound to a local (declared after `rx`) so the borrow it holds is dropped first.
    let landed = tokio::time::timeout(WAIT, rx.wait_for(|v| *v != Verdict::Running)).await;
    match landed {
        Ok(Ok(v)) => *v == Verdict::Up,
        // Timed out, or the sender vanished (it can't — see CHANNEL): treat as unreachable so the
        // window shows the retry card rather than hanging on the splash.
        _ => false,
    }
}

/// index.html's first script tick: "can I hand the webview to the remote app?".
#[tauri::command]
pub async fn origin_status() -> bool {
    verdict().await
}

/// index.html's "Try again" button: probe again from scratch and report the fresh verdict.
#[tauri::command]
pub async fn origin_recheck() -> bool {
    start();
    verdict().await
}
