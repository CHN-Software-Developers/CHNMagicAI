# CHNMagicAI — desktop app (Electron)

A one-click desktop wrapper around the local FastAPI app. It spawns `backend/launcher.py`, shows a
splash with a progress bar while setup + the engine come up, then loads the app UI in a window. The web
UI stays reachable from a normal browser at the same URL.

## Develop

```
cd desktop
npm install
npm start
```

`npm start` runs against the repo in place. To avoid colliding with a live app already serving on
`8188`, start it on override ports:

```
# PowerShell
$env:AIVB_APP_PORT=8190; $env:AIVB_COMFY_PORT=8201; npm start
```

The splash reads progress from the launcher's stdout (`AIVB_PHASE|pct|msg` anchors plus the human
`[setup]`/`[launcher]` lines). When `GET /healthz` returns 200 the main window opens on
`http://127.0.0.1:<port>/` and the splash closes.

In dev the shell uses a system Python (`python`/`py`) as the engine venv base. Models/output/projects
go under `%LOCALAPPDATA%\CHNMagicAI` (via `AIVB_DATA_DIR`), keeping the repo clean.

## Build a portable .exe

```
cd desktop
npm install
npm run fetch-python      # downloads a standalone Python 3.10 into desktop/python (bundled)
npm run build             # electron-builder → dist/CHNMagicAI-portable-<version>.exe
```

`npm run build` bundles `desktop/python` (the zero-prerequisite interpreter) and the app source
(`backend/`, `config/`, `engine/ComfyUI`, `workflows/`) as `extraResources`. On first launch the
packaged app materializes the source into `%LOCALAPPDATA%\CHNMagicAI\app` (a writable location for the
engine venv + ComfyUI's `input/temp/user`) and runs from there. The first launch still pip-installs the
multi-GB GPU dependencies behind the splash — that is unavoidable.

Put an app icon at `desktop/build/icon.ico` before building (electron-builder default otherwise).

## Environment variables honored by the launcher

| Var                                   | Purpose                                      |
| ------------------------------------- | -------------------------------------------- |
| `AIVB_ENV`                            | `desktop` \| `runpod`                        |
| `AIVB_APP_HOST` / `AIVB_APP_PORT`     | web server bind                              |
| `AIVB_COMFY_HOST` / `AIVB_COMFY_PORT` | hidden engine bind                           |
| `AIVB_OPEN_BROWSER`                   | `0` to suppress the system-browser auto-open |
| `AIVB_DATA_DIR`                       | writable base for models/output/registry     |
| `AIVB_BASE_PYTHON`                    | interpreter the engine venv is created from  |
