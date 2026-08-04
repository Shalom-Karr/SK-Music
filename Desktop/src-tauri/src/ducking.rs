//! Auto-duck (WINDOWS ONLY).
//!
//! Lower SK Music's volume while something ELSE on the machine is making noise — a WhatsApp voice
//! note, a video, a call — and put it back afterwards. The alternative is pausing and un-pausing all
//! day, which is what this exists to stop.
//!
//! ## Why this is native and not in the SPA
//! No web API can observe other applications' audio. A page can only see its own. So the detection
//! has to happen out here; the SPA is only told "duck" / "release".
//!
//! ## Why we don't just turn our own session down in Windows
//! `ISimpleAudioVolume` on our own session would be tempting, but the webview plays audio from CHILD
//! processes (msedgewebview2.exe), so "our session" is several sessions that come and go — and
//! writing to it would fight the user's own volume slider and the crossfade code, which both push
//! absolute values. Instead we emit an event and the SPA applies a multiplier on top of whatever the
//! user set. Their slider position never changes; only what comes out does.
//!
//! ## What counts as "something else is playing"
//! Every audio session on the default render endpoint carries a process id and a peak meter. A
//! session belonging to a process that is NOT in our own tree, in the Active state, with a peak
//! above the floor, is someone else making noise. The METER is what matters, not the state: plenty
//! of apps (Discord, a paused Spotify) hold an Active session that is completely silent, and ducking
//! for those would mean ducking permanently.
//!
//! ## What counts as "there is input"
//! An active CAPTURE session belonging to another process, with signal on it. Requiring both matters
//! in each direction: peak alone fires on room noise through an always-open mic, and an open session
//! alone fires on the apps that hold the mic forever without listening. Together they mean someone
//! opened the mic and is actually talking into it.
//!
//! ## Timing
//! Attack is immediate — by the time you hear the first syllable it should already be quiet. Release
//! waits out `HOLD`, so the gaps between words in a voice note don't make the music pump.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Listener};

/// How often the meters are read. Cheap (a COM call per session), and 5×/s is well under the
/// threshold where a duck feels late.
const POLL: Duration = Duration::from_millis(200);
/// Silence for this long before the music comes back. Long enough to bridge the pauses between words.
const HOLD: Duration = Duration::from_millis(1200);
/// Peak floor for "this session is audible". Above the dither/noise a silent-but-active session emits.
const PLAY_FLOOR: f32 = 0.008;
/// Capture floor. Higher than PLAY_FLOOR: a mic idling in a quiet room still reads a little.
const MIC_FLOOR: f32 = 0.045;
/// Our process tree is re-read this often — the webview spawns and retires child processes.
const TREE_TTL: Duration = Duration::from_secs(3);

/// Set by the SPA (Settings → auto-duck). Off means the poller idles without touching anything.
static ENABLED: AtomicBool = AtomicBool::new(true);
/// Duck target as a percentage of the user's volume, 0-100.
static AMOUNT: AtomicU32 = AtomicU32::new(25);
static STARTED: OnceLock<()> = OnceLock::new();

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}
pub fn set_amount(pct: u32) {
    AMOUNT.store(pct.clamp(0, 100), Ordering::Relaxed);
}

/// Listen for the SPA's settings and start the poller. Safe to call once from setup().
pub fn init(app: &AppHandle) {
    let h = app.clone();
    app.listen("sk-duck-config", move |ev| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
            if let Some(on) = v.get("enabled").and_then(|x| x.as_bool()) {
                set_enabled(on);
            }
            if let Some(pct) = v.get("amount").and_then(|x| x.as_u64()) {
                set_amount(pct as u32);
            }
            // Echo the accepted values back so the settings UI reflects what actually took effect.
            let _ = h.emit(
                "sk-duck-config-ack",
                serde_json::json!({ "enabled": ENABLED.load(Ordering::Relaxed), "amount": AMOUNT.load(Ordering::Relaxed) }),
            );
        }
    });
    start(app.clone());
}

#[cfg(not(target_os = "windows"))]
fn start(_app: AppHandle) {}

#[cfg(target_os = "windows")]
fn start(app: AppHandle) {
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // MTA on our own thread: this never touches the UI apartment.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let mut ducked = false;
        let mut last_loud: Option<Instant> = None;
        let mut tree: Vec<u32> = own_tree();
        let mut tree_at = Instant::now();

        loop {
            std::thread::sleep(POLL);

            if !ENABLED.load(Ordering::Relaxed) {
                if ducked {
                    ducked = false;
                    emit(&app, false, "");
                }
                continue;
            }

            if tree_at.elapsed() > TREE_TTL {
                tree = own_tree();
                tree_at = Instant::now();
            }

            // A COM failure here is not worth tearing the thread down for — an unplugged headset
            // invalidates the endpoint and the next tick picks up the new default device.
            let playing = others_playing(&tree).unwrap_or(false);
            let mic = others_capturing(&tree).unwrap_or(false);
            let loud = playing || mic;

            if loud {
                last_loud = Some(Instant::now());
                if !ducked {
                    ducked = true;
                    emit(&app, true, if mic { "mic" } else { "audio" });
                }
            } else if ducked {
                let quiet_for = last_loud.map(|t| t.elapsed()).unwrap_or(HOLD);
                if quiet_for >= HOLD {
                    ducked = false;
                    emit(&app, false, "");
                }
            }
        }
    });
}

fn emit(app: &AppHandle, on: bool, reason: &str) {
    let _ = app.emit(
        "sk-duck",
        serde_json::json!({ "on": on, "reason": reason, "amount": AMOUNT.load(Ordering::Relaxed) }),
    );
}

// ---------------------------------------------------------------------------
// Windows internals
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn own_tree() -> Vec<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let me = std::process::id();
    let mut pairs: Vec<(u32, u32)> = Vec::new(); // (pid, parent)
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return vec![me];
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                pairs.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
    }
    // Walk down from our pid. The webview's audio comes from a grandchild, not a child, so this has
    // to be transitive — a one-level check would duck against our own music.
    let mut ours = vec![me];
    let mut grew = true;
    while grew {
        grew = false;
        for (pid, parent) in &pairs {
            if ours.contains(parent) && !ours.contains(pid) {
                ours.push(*pid);
                grew = true;
            }
        }
    }
    ours
}

#[cfg(target_os = "windows")]
fn others_playing(ours: &[u32]) -> windows::core::Result<bool> {
    scan(ours, true, PLAY_FLOOR)
}

#[cfg(target_os = "windows")]
fn others_capturing(ours: &[u32]) -> windows::core::Result<bool> {
    scan(ours, false, MIC_FLOOR)
}

/// True when some session on the given endpoint belongs to another process, is Active, and is
/// carrying signal above `floor`.
#[cfg(target_os = "windows")]
fn scan(ours: &[u32], render: bool, floor: f32) -> windows::core::Result<bool> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        eCapture, eMultimedia, eRender, AudioSessionStateActive, IAudioSessionControl2,
        IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    unsafe {
        let denum: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let flow = if render { eRender } else { eCapture };
        // No default endpoint (no mic at all, for instance) is a normal state, not an error.
        let Ok(device) = denum.GetDefaultAudioEndpoint(flow, eMultimedia) else {
            return Ok(false);
        };
        let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = mgr.GetSessionEnumerator()?;
        let n = sessions.GetCount()?;
        for i in 0..n {
            let Ok(ctl) = sessions.GetSession(i) else { continue };
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            // The system sounds session reports pid 0; never duck against it, and never against us.
            let pid = ctl2.GetProcessId().unwrap_or(0);
            if pid == 0 || ours.contains(&pid) {
                continue;
            }
            if ctl.GetState().unwrap_or(AudioSessionStateActive) != AudioSessionStateActive {
                continue;
            }
            let Ok(meter) = ctl2.cast::<IAudioMeterInformation>() else { continue };
            if meter.GetPeakValue().unwrap_or(0.0) > floor {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "windows"))]
fn own_tree() -> Vec<u32> {
    vec![std::process::id()]
}
