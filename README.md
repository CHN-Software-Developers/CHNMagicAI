# CHNMagicAI

The next-generation AI movie production software powered by ComfyUI, WhatDreamsCost LTX Director 2 and CosyVoice.

> **License:** GPL-3.0 (see `LICENSE`). CHNMagicAI bundles ComfyUI and the WhatDreamsCost LTX
> Director nodes, both GPL-3.0. See `THIRD_PARTY_NOTICES.md`.

## Layout

```
backend/         FastAPI orchestrator + launcher + first-run bootstrap
backend/static/  No-build vanilla-JS SPA — the timeline UI, served as-is
engine/          Bundled ComfyUI + LTX Director / KJNodes / audio-separation nodes (GPL-3.0)
models/          App-managed model weights, downloaded/located on first use (git-ignored)
output/          Generated videos (git-ignored)
config/          settings.json and models_manifest.json
workflows/       ltx_director_2.api.json (the LTX Director 2 pipeline in ComfyUI API format)
scripts/         Maintenance tools (re-vendor the engine, convert a workflow)
```

## Features

- Facility to arrange prompts and assets in an interactive timeline for better AI generation results (Powered by LTX Director).
- Voice consistency and cloning.
- Moods generator for voice cloning.
- Extend videos and link to the last frame.
- Full character generator (Coming in the future).
- Timeline edit and export full movies (Coming in the future).

## Quick start

If you are planning to make movies in your local environment for free of cost, you can use the desktop installer and set up the software on your own device. However, if your device doesn't meet the minimum required system requirements or is having issues running locally, you can try the app in a Runpod environment using our prebuild runpod template (extra costs from Runpod may apply based on your pod usage). 

<table>
  <tr>
    <td>Desktop installer</td>
    <td>...</td>
  </tr>
  <tr>
    <td>Try on Runpod</td>
    <td>...</td>
  </tr>
</table>

## Minimum system requirements

> It is recommended to go up with maximum 720p 10sec max videos (20 steps and 4 upscaler steps) if your system is limited to the following minimum requirements.

<table>
  <tr>
    <td>VRAM</td>
    <td>8GB or more</td>
  </tr>
  <tr>
    <td>RAM</td>
    <td>32GB more more</td>
  </tr>
  <tr>
    <td>Virtual Memory</td>
    <td>Enabled with Fast SSD to avoid freezing the device with minimum requirements (i.e., Windows paging)</td>
  </tr>
</table>

## Development

- Run the whole app: `run.bat` (first run auto-creates `engine/python/` and installs deps).
- Run just the orchestrator against an already-provisioned engine: `python backend/launcher.py`
- Re-vendor / update the bundled engine from a local ComfyUI or upstream: `python scripts/vendor_engine.py`
- Per-machine settings (interpreter path, located model paths) live in the git-ignored
  `config/settings.local.json`, which overrides `config/settings.json` at load time.
