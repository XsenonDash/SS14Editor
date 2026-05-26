# SS14 Editor

A standalone visual editor for [Space Station 14](https://github.com/space-wizards/space-station-14) prototype YAML files.
Works with **any SS14 fork** — just point it at your project folder.

> [!WARNING]
> Work in progress!
> The tool is still in active development. Expect bugs and missing features. Make backups before mass-editing.

> [!NOTE]
> Vibecoding!
> This entire project was created using generative AI technologies. If you don't like it, don't use it.

<img width="1919" height="747" alt="image" src="https://github.com/user-attachments/assets/f5e92e61-f329-4c3c-aba2-64ea7705eac7" />

---

## What it does

- Browse and edit prototype YAML files through a modern, themed UI
- Auto-completes entity IDs, component names and field types from your project's assemblies
- Shows inheritance chains, validates required fields, renders sprites inline
- Watches `Resources/Prototypes/` for external changes and live-reloads open files / the file tree (Server-Sent Events)
- Loads game DLLs through `System.Reflection.MetadataLoadContext` — **no game code is executed**
- Ships as either a self-contained CLI / HTTP server (any browser) or as a packaged Electron desktop app with a custom title bar and in-app updates

---

## Quick start

### Option A — Desktop app (recommended)

Grab the latest installer or portable build from the [Releases](../../releases) page:

| Platform | Installer | Portable |
|----------|-----------|----------|
| Windows  | `ss14-editor-v<version>-setup.exe` (NSIS) | `ss14-editor-v<version>-portable.exe` |
| Linux    | `ss14-editor-v<version>-linux-x64.AppImage` | — |
| macOS (Apple Silicon) | `ss14-editor-v<version>-osx-arm64.dmg` | — |

Launch the app — a splash window appears immediately, the bundled .NET server starts in the background, and the project picker opens as soon as it is ready. When a newer release is published an accent-coloured **Update** button appears in the header; click it to download and restart into the installer. Nothing is downloaded silently.

### Option B — CLI / browser

Prefer running the .NET server yourself? Download one of the standalone archives instead of the Electron installer:

| Platform | Archive |
|----------|---------|
| Windows  | `ss14-editor-v<version>-win-x64.zip` |
| Linux    | `ss14-editor-v<version>-linux-x64.tar.gz` |
| macOS (Apple Silicon) | `ss14-editor-v<version>-osx-arm64.tar.gz` |

The archive contains a single self-contained `ss14-editor` binary (the WebUI is embedded inside it, so nothing else is needed). Extract it anywhere and run:

```
ss14-editor               # starts in setup mode — open http://localhost:2701 in any browser
```

### Option C — Build from source

```bash
git clone https://github.com/your-org/ss14-editor
cd ss14-editor
dotnet run --project ss14-editor.csproj
```

Requires [.NET 10 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/10.0).

---

## Desktop app (Electron)

The `electron/` folder contains the Electron wrapper that owns the desktop window, the system-tray icon and the update flow.

Highlights:

- **Native window chrome is hidden.** `frame: false` means the OS title bar is gone; the WebUI draws its own header containing the Project menu, the Update button and the minimize / maximize / close window controls.
- **No silent auto-update.** The main process queries GitHub Releases on startup; if there is a newer version it sends `update-available` over IPC and the WebUI surfaces the Update button. Downloading and installing happens only after the user clicks it.
- **Renderer is hardened.** `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`. All cross-process traffic goes through the small surface exposed by [electron/preload.js](electron/preload.js) (`window.electronAPI`).
- **No CORS.** The .NET server and the WebUI share an origin (`http://localhost:2701`). Do not add `Access-Control-Allow-*` headers — they would let any website the user visits POST to `/api/file` and rewrite prototype files.

### Development

```bash
# 1. Build the .NET server (Debug is fine for dev, output lands in bin/)
dotnet build ss14-editor.csproj

# 2. Install Electron dependencies (once)
cd electron
npm install

# 3. Run
npm start
```

The main process spawns the .NET binary from `bin/`, `publish/win-x64/` or `publish/server/` (whichever it finds), waits for the HTTP server to respond, then opens the window.

### Packaging a distributable

```bash
# Publish the self-contained .NET binary first (from repo root)
dotnet publish ss14-editor.csproj -c Release -r win-x64 --self-contained -o publish/win-x64

# Then build the Electron installer (from electron/)
cd electron
npm run dist
```

Output goes to `electron/dist/` — an NSIS installer (`ss14-editor-vX.Y.Z-setup.exe`) and a portable executable (`ss14-editor-vX.Y.Z-portable.exe`). Optionally place a 256×256 `icon.ico` at the repo root to brand the build.

---

## How it works

- The .NET server uses `System.Reflection.MetadataLoadContext` to read the compiled game DLLs **without executing any game code** — safe and fast even on a fork you have never run before.
- The WebUI is vanilla HTML / CSS / JS embedded as resources via `<EmbeddedResource Include="WebUI\**\*">`. There is no bundler, no transpiler, no npm step.
- Live file-tree / file-content updates are delivered over Server-Sent Events from `/api/events`.
- All filesystem inputs from HTTP requests go through `PathSecurity.NormalizeRelative`, which rejects absolute paths and `..` traversal before any I/O happens.
