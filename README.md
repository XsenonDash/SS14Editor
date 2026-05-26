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

## Using the editor

1. **Build your SS14 project first** — the editor reads prototype metadata from the compiled game DLLs:
   ```
   cd your-ss14-fork
   dotnet build
   ```

2. **Run the editor** (desktop app or CLI). Open `http://localhost:2701/` in a browser if you used the CLI build.

3. **Pick a project folder** in the setup screen. Enter the absolute path to your SS14 fork root (e.g. `C:\repos\space-station-14`). The editor validates the path and extracts metadata automatically.

4. **Edit prototypes** — the file tree on the left shows all YAML files under `Resources/Prototypes/`. Click a file to open it, edit fields in the visual form on the right, save with **Ctrl+S**.

5. **Switch projects** any time via the custom header: **Project → Open other repository** drops the current project and re-shows the picker. When a new release is published, an accent-coloured **Update** button appears next to the Project menu — click it to download and restart into the installer.

---

## CLI usage

```
ss14-editor                              start in setup mode (project picker in the browser)
ss14-editor serve [solutionRoot] [port]  start the visual editor pointing at a project
                                         (omit solutionRoot to start in setup mode; default port: 2701)
ss14-editor extract [solutionRoot]       extract metadata.json without starting the server
```

> [!IMPORTANT]
> `serve` does **not** auto-detect the project from the current working directory. Either pass an explicit `solutionRoot` or let the WebUI pick one. (Earlier versions walked up the CWD looking for an SS14-shaped folder; that was removed because it silently loaded sibling forks and skipped the picker.)

On `serve` / `extract` a fingerprint cache is consulted first: if every scanned DLL has the same size + mtime as last time and the editor's own version is unchanged, extraction is skipped entirely and the existing `metadata.json` is reused — re-opening a project after a build is near-instant.

The generated files (`metadata.json`, `metadata.cache.txt`) are stored in the OS user data folder **outside** the scanned project tree, under `%LOCALAPPDATA%\ss14-editor\<project>-<hash>\` (Windows) or `~/.local/share/ss14-editor/<project>-<hash>/` (Linux/macOS). Delete that folder to force a full rebuild.

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

---

## Project layout

```
src/              C# server (single csproj, namespace Content.Editor.Editor):
  Program.cs            CLI entry + argument parsing
  Api/                  ApiRouter + partial-class endpoint groups
                        (StatusApi, TreeApi, FileApi, FolderApi,
                         AssetApi, SourceApi, EventsApi)
  Core/                 PathSecurity, RedactorContext (refcounted lifecycle)
  Http/                 HttpJson, RedactorServer (HttpListener glue), StaticMime
  Services/             ProtoIndexService, FileTreeService, FileWatcherService,
                        EventStreamService, GitStatusService, SourceLocator,
                        ModernFolderPicker, YamlPrototypeScanner
  Metadata/             MetadataExtractor, FieldExtractor, CtorDefaultsScanner,
                        XmlDocReader, MetadataModels, ApiModels
WebUI/            HTML / CSS / JS embedded into the binary
electron/         Electron wrapper (main.js, preload.js, package.json)
tests/ss14-editor.Tests/   xUnit project (net10)
```

---

## Tests

```bash
dotnet test tests\ss14-editor.Tests\ss14-editor.Tests.csproj
```

The main csproj's default SDK glob would otherwise pull `tests/**/*.cs` into the main project; `<Compile Remove="tests\**\*" />` in [ss14-editor.csproj](ss14-editor.csproj) keeps them out. Do not remove that block.
