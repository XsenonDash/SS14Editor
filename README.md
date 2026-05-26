# SS14 Editor

A standalone visual editor for [Space Station 14](https://github.com/space-wizards/space-station-14) prototype YAML files.  
Works with **any SS14 fork** — just point it at your project folder.

> [!WARNING]
> The tool is not yet ready for full use; it contains a large number of bugs and has many features that have not yet been implemented

<img width="1919" height="747" alt="image" src="https://github.com/user-attachments/assets/f5e92e61-f329-4c3c-aba2-64ea7705eac7" />

---

## What it does

- Browse and edit prototype YAML files through a browser-based UI
- Auto-completes entity IDs, component names, field types from your project's assemblies
- Shows inheritance chains, validates required fields, renders sprites inline
- Watches the `Resources/Prototypes/` folder for external changes and reloads open files
- Runs as a self-contained local HTTP server — no internet required, no install required

---

## Quick start

### Option A — Download a binary

Go to the [Releases](../../releases) page and download the binary for your platform:

| Platform | File |
|----------|------|
| Windows  | `ss14-editor-win-x64.zip` → extract → run `ss14-editor.exe` |
| Linux    | `ss14-editor-linux-x64.tar.gz` → extract → `./ss14-editor` |
| macOS (Apple Silicon) | `ss14-editor-osx-arm64.tar.gz` |

The binary is fully self-contained — no .NET runtime needed.

### Option B — Build from source

```bash
git clone https://github.com/your-org/ss14-editor
cd ss14-editor
dotnet run
```

Requires [.NET 10 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/10.0).

---

## Using the editor

1. **Build your SS14 project first** — the editor reads prototype metadata from the compiled game DLLs:
   ```
   cd your-ss14-fork
   dotnet build
   ```

2. **Run the redactor** (binary or `dotnet run` from this repo).  
   Your browser opens automatically at `http://localhost:2701`.

3. **Pick a project folder** in the setup screen that appears.  
   Enter the absolute path to your SS14 fork root (e.g. `C:\repos\space-station-14`).  
   The editor validates the path and extracts metadata automatically.

4. **Edit prototypes** — the file tree on the left shows all YAML files under `Resources/Prototypes/`. Click a file to open it, edit fields in the visual form on the right, save with **Ctrl+S**.

---

## CLI usage

```
ss14-editor                         # start editor, open browser (setup mode)
ss14-editor serve [path] [port]     # start editor pointing at a specific project
ss14-editor extract [path]          # extract metadata.json without starting the server
```

On `serve`/`extract` a fingerprint cache is consulted first: if every scanned DLL has the same size + mtime as last time and the editor's own version is unchanged, extraction is skipped entirely and the existing `metadata.json` is reused — re-opening a project after a build is near-instant.

The generated files (`metadata.json`, `metadata.cache.txt`) are stored in the OS user data folder **outside** the scanned project tree, under `%LOCALAPPDATA%\ss14-editor\<project>-<hash>\` (Windows) or `~/.local/share/ss14-editor/<project>-<hash>/` (Linux/macOS). Delete that folder to force a full rebuild.

---

## Desktop app (Electron)

The `electron/` folder contains an Electron wrapper that opens the editor in its own window instead of a browser tab.

### Development

```bash
# 1. Build the .NET server
dotnet build -c Release

# 2. Install Electron dependencies (once)
cd electron
npm install

# 3. Run
npm start
```

The main process starts `ss14-redactor.exe serve` as a child process (with `SS14_EDITOR_NO_BROWSER=1` to suppress the automatic browser launch), waits for the server to be ready, then opens a `BrowserWindow` pointed at `http://localhost:2701`.  
A tray icon lets you hide/show the window or quit.

### Packaging a distributable

```bash
# Publish the .NET binary first (from repo root)
dotnet publish -c Release -r win-x64 --self-contained -o publish/win-x64

# Then build the Electron installer (from electron/)
cd electron
npm run dist
```

Output goes to `electron/dist/`. Produces an NSIS installer (`*-Setup.exe`) and a portable executable.  
Optionally place a 256×256 `icon.ico` in `electron/` to use a custom app icon.

---

## How it works

The tool uses `System.Reflection.MetadataLoadContext` to read the compiled game DLLs **without executing any game code**. This makes it safe and fast to load.  
The web UI is embedded inside the binary as resources, so there are no external dependencies at runtime.
