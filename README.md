# SS14 Prototype Redactor

A standalone visual editor for [Space Station 14](https://github.com/space-wizards/space-station-14) prototype YAML files.  
Works with **any SS14 fork** — just point it at your project folder.

> [!WARNING]
> The tool is not yet ready for full use; it contains a large number of bugs and has many features that have not yet been implemented

<img width="1006" height="605" alt="image" src="https://github.com/user-attachments/assets/ddd65bf1-a847-4add-8662-6dce6246d469" />
<img width="759" height="815" alt="image" src="https://github.com/user-attachments/assets/a57eea99-3874-4101-a863-b3fdcc9890b2" />

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
| Windows  | `ss14-redactor-win-x64.zip` → extract → run `ss14-redactor.exe` |
| Linux    | `ss14-redactor-linux-x64.tar.gz` → extract → `./ss14-redactor` |
| macOS (Apple Silicon) | `ss14-redactor-osx-arm64.tar.gz` |

The binary is fully self-contained — no .NET runtime needed.

### Option B — Build from source

```bash
git clone https://github.com/your-org/ss14-redactor
cd ss14-redactor
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
ss14-redactor                         # start editor, open browser (setup mode)
ss14-redactor serve [path] [port]     # start editor pointing at a specific project
ss14-redactor extract [path]          # extract metadata.json without starting the server
```

On `serve`/`extract` the metadata cache (`Redactor/metadata.cache.txt`) is consulted first: if every scanned DLL has the same size + mtime as last time and the redactor's own version is unchanged, extraction is skipped entirely and the existing `Redactor/metadata.json` is reused — re-opening a project after a build is near-instant. Delete `Redactor/metadata.cache.txt` (or `Redactor/`) to force a full rebuild.

---

## How it works

The tool uses `System.Reflection.MetadataLoadContext` to read the compiled game DLLs **without executing any game code**. This makes it safe and fast to load.  
The web UI is embedded inside the binary as resources, so there are no external dependencies at runtime.
