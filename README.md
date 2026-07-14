# CHNMagicAI

The next-generation AI movie production software powered by ComfyUI, WhatDreamsCost LTX Director 2 and CosyVoice.

> **License:** GPL-3.0 (see `LICENSE`). CHNMagicAI bundles ComfyUI and the WhatDreamsCost LTX
> Director nodes, both GPL-3.0. See `THIRD_PARTY_NOTICES.md`.

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

## Quick start

If you are planning to make movies in your local environment for free of cost, you can use the desktop installer and set up the software on your own device. However, if your device doesn't meet the minimum required system requirements or is having issues running locally, you can try the app in a Runpod environment using our prebuild runpod template (extra costs from Runpod may apply based on your pod usage). 

| Type | Download |
|---|---|
| Desktop installer | ... |
| Runpod template | ... |

## Development

- Run the whole app: `run.bat` (first run auto-creates `engine/python/` and installs deps).
- Run just the orchestrator against an already-provisioned engine: `python backend/launcher.py`
- Re-vendor / update the bundled engine from a local ComfyUI or upstream: `python scripts/vendor_engine.py`
- Per-machine settings (interpreter path, located model paths) live in the git-ignored
  `config/settings.local.json`, which overrides `config/settings.json` at load time.
