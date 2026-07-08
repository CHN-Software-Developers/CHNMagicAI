# CHNMagicAI

A standalone, one-click desktop web app that runs the **LTX Director 2** AI-video pipeline
(LTX-2.3) locally — **no ComfyUI installation required**. It embeds a private, headless ComfyUI as
its hidden inference engine and puts a simple, colorful web UI in front of it: a timeline director,
basic settings (resolution / frames / steps), live per-step generation preview, model
auto-download, and an output video player.

> **License:** GPL-3.0 (see `LICENSE`). CHNMagicAI bundles ComfyUI and the WhatDreamsCost LTX
> Director nodes, both GPL-3.0. See `THIRD_PARTY_NOTICES.md`.

## Quick start

```
run.bat          # Windows: boots the hidden engine + app, opens http://127.0.0.1:8188
```

On first run, open the **Models** panel and either click **Download** for each required model or
**Locate existing file** to point at models you already have (e.g. on an external drive). Edit
`config/models_manifest.json` first if you want to change any download URL, version, or filename.

## Layout

```
backend/         FastAPI orchestrator + launcher + first-run bootstrap (our code)
backend/static/  No-build vanilla-JS SPA (our code) — the timeline UI, served as-is
engine/          Bundled ComfyUI + LTX Director / KJNodes / audio-separation nodes (GPL-3.0)
models/          App-managed model weights, downloaded/located on first use (git-ignored)
output/          Generated videos (git-ignored)
config/          settings.json, models_manifest.json (user-editable)
workflows/       ltx_director_2.api.json (the LTX Director 2 pipeline in ComfyUI API format)
scripts/         Maintenance tools (re-vendor the engine, convert a workflow)
```

The **engine source is committed** with the app, so a fresh clone is self-contained. The only
things fetched on first run are the Python packages (into `engine/python/`) and the model weights
(into `models/`) — both git-ignored. There is no build step for the UI.

## Voice / speech (optional)

The **+ Audio** dialog can either upload an audio file or **generate speech** — type dialog and pick
a tone/language, or **clone a voice** from a short reference clip (the reference is auto-transcribed
with Whisper; the transcript stays editable). Generated speech is previewed and can be regenerated
before you drop it on the timeline; ticking **Lip-sync** then syncs the video to that voice.

Speech uses **CosyVoice 3** (Apache-2.0), installed on demand from the **Models** panel into its own
isolated environment (location is user-selectable, default `tts_engine/`). It stays separate from
the video engine, so it's fully optional — if it isn't installed, everything else works unchanged.
**Only clone voices you have the right to use.** See `THIRD_PARTY_NOTICES.md`.

## Development

- Run the whole app: `run.bat` (first run auto-creates `engine/python/` and installs deps).
- Run just the orchestrator against an already-provisioned engine: `python backend/launcher.py`
- Re-vendor / update the bundled engine from a local ComfyUI or upstream: `python scripts/vendor_engine.py`
- Per-machine settings (interpreter path, located model paths) live in the git-ignored
  `config/settings.local.json`, which overrides `config/settings.json` at load time.
