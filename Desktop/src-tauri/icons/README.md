# Icons — PLACEHOLDERS

These files are auto-generated placeholders (indigo rounded square with "SK") so the
project compiles (`generate_context!` embeds `icon.ico` and parses the PNGs at build time)
and bundles produce something. **Replace them with the real SK Music brand icon before
any release.**

Required set (referenced by `tauri.conf.json`):

| File | Purpose |
|---|---|
| `32x32.png`, `128x128.png`, `128x128@2x.png` | Linux / general app icon set |
| `icon.png` | Tray icon source (`app.trayIcon.iconPath`) |
| `icon.ico` | Windows executable + installer icon (embedded at compile time) |
| `icon.icns` | macOS `.app` bundle icon |

Regenerate the full set from a single 1024×1024 master with the Tauri CLI:

```
npm run tauri icon path/to/sk-music-1024.png
```

which writes all sizes (including `Square*Logo` variants for Windows Store) into this folder.
