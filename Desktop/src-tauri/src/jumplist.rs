//! Windows taskbar jump list — right-clicking the SK Music taskbar button shows the same controls
//! as the tray (transport, Like, Radio, Mini player, Check for updates).
//!
//! Jump-list tasks can't call into a running process; each entry LAUNCHES the exe with a
//! `--control=<action>` argument. The single-instance plugin forwards a second launch's argv to the
//! running app (see `main.rs`), which routes the action into the same handlers the tray uses — so a
//! task click behaves exactly like the tray item, without focusing the window.
//!
//! Registered once at startup via `ICustomDestinationList` (COM). Best-effort: any failure is
//! logged and the app runs with the default jump list.

#![cfg(target_os = "windows")]

use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

/// PKEY_Title — the display text of a jump-list entry ({F29F85E0-4FF9-1068-AB91-08002B27B3D9}, 2).
const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xF29F85E0_4FF9_1068_AB91_08002B27B3D9),
    pid: 2,
};

/// The tasks, top to bottom. Mirrors the tray's transport + feature items; check-state toggles
/// (autostart / notify) stay tray-only — a jump list can't render checkmarks.
const TASKS: &[(&str, &str)] = &[
    ("Play / Pause", "--control=toggle"),
    ("Next", "--control=next"),
    ("Previous", "--control=previous"),
    ("Like this song", "--control=like"),
    ("Start radio from this song", "--control=radio"),
    ("Mini player", "--control=mini"),
    ("Check for updates", "--control=updates"),
];

/// Register the jump list. Called once from `.setup()`; failures only cost the custom entries.
pub fn init() {
    if let Err(e) = register() {
        eprintln!("[jumplist] registration failed: {e}");
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Build a VT_LPWSTR PROPVARIANT (this crate version ships no string helpers). The string is
/// CoTaskMem-owned; release with `PropVariantClear` after `SetValue` copies it.
unsafe fn propvariant_string(s: &str) -> windows::core::Result<PROPVARIANT> {
    let w = wide(s);
    let mem = CoTaskMemAlloc(w.len() * 2) as *mut u16;
    if mem.is_null() {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-2147024882))); // E_OUTOFMEMORY
    }
    std::ptr::copy_nonoverlapping(w.as_ptr(), mem, w.len());
    let mut pv = PROPVARIANT::default();
    (*pv.Anonymous.Anonymous).vt = VT_LPWSTR;
    (*pv.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(mem);
    Ok(pv)
}

fn register() -> windows::core::Result<()> {
    unsafe {
        // Tauri's main thread already has COM (OLE) initialized; tolerate the mode mismatch.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let exe = std::env::current_exe().map_err(|_| windows::core::Error::empty())?;
        let exe_w = wide(&exe.to_string_lossy());

        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots: u32 = 0;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;

        let tasks: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        for (title, args) in TASKS {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(PCWSTR(exe_w.as_ptr()))?;
            let args_w = wide(args);
            link.SetArguments(PCWSTR(args_w.as_ptr()))?;
            link.SetIconLocation(PCWSTR(exe_w.as_ptr()), 0)?;
            let store: IPropertyStore = link.cast()?;
            let mut value = propvariant_string(title)?;
            let set = store.SetValue(&PKEY_TITLE, &value);
            let _ = PropVariantClear(&mut value);
            set?;
            store.Commit()?;
            tasks.AddObject(&link)?;
        }
        list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
        list.CommitList()?;
    }
    Ok(())
}
