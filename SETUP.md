# Setup & running

Setup is **automatic**. You do not run pip or install anything by hand.

## Run it

```bat
run.bat
```

The **engine source (ComfyUI + the 3 custom-node packages) is already bundled in this repository**,
so first run does not download or clone any code — it only builds the Python environment. On the
**first** run this automatically:
1. Creates a private Python environment at `engine/python`.
2. Installs **all** dependencies into it — CUDA PyTorch, ComfyUI's requirements (`sqlalchemy`,
   `filelock`, `blake3`, `Pillow`, `tqdm`, `comfy-aimdo`, `av`, …), the custom-node requirements,
   `soundfile`, and the backend. (pip uses `--trusted-host` to tolerate SSL/CA issues.)
3. Boots the hidden ComfyUI engine, waits until it is healthy, serves the UI at
   <http://127.0.0.1:8188>, and opens your browser.

(If `engine/ComfyUI` is ever missing — e.g. you deleted it — bootstrap falls back to cloning
ComfyUI at the pinned commit and copying the nodes, so the app still self-heals.)

Later runs skip straight to launching (setup state is cached in `engine/.setup_state.json`).

### GPU compatibility (important)
The installed PyTorch build must have compute kernels for **your** GPU architecture, or generation
fails immediately with `CUDA error: no kernel image is available for execution on the device`
(it "finishes" in seconds with no video and no GPU load). Match the build to your card:

| GPU family | Example cards | `setup.torch_index_url` |
|---|---|---|
| Blackwell (RTX 50-series) | RTX 5060/5070/5080/5090 | `https://download.pytorch.org/whl/cu128` |
| Ada / Ampere / Turing (RTX 20/30/40-series) | RTX 3090, 4090 | `cu124` or `cu128` |
| CPU only (no NVIDIA GPU) | — | `https://download.pytorch.org/whl/cpu` |

**Default is now `cu128`**, which covers RTX 20- through 50-series. After changing it, delete
`engine/.setup_state.json` and re-run so the correct PyTorch is reinstalled. Verify with:
`engine\python\Scripts\python.exe -c "import torch;print(torch.cuda.is_available(), torch.cuda.get_arch_list())"`
— your GPU's `sm_XX` (e.g. `sm_120` for RTX 5060) must appear in the arch list.

### Tuning first-run setup (optional, `config/settings.json` → `setup`)
- `torch_index_url` — PyTorch build. Default `cu128` (see GPU compatibility above).
- `local_comfy_source` — only used if `engine/ComfyUI` is missing: a local ComfyUI to copy from
  offline. Blank by default (the engine is already bundled).
- `comfy_repo` / `comfy_commit` — the pinned ComfyUI version used for the self-heal `git clone`
  fallback if the bundled engine is missing.
- `auto` — set `false` to skip the bootstrap entirely and use `python_exe` as-is.

## Provide the models (only thing that needs your input)

The pipeline uses **LTX-2.3** model files. In the app's **Models** panel:
- **Download** each (set/verify URLs in `config/models_manifest.json` first; see
  <https://github.com/wildminder/awesome-ltx2>). For gated repos (e.g. Gemma), set `HF_TOKEN`.
- or **Locate…** files you already have (external drive, existing ComfyUI) — they are hard-linked
  into `models/`, no copy or re-download.

The **Generate** button unlocks once all required models resolve.

### Optional: "Remove background music"
The editor has a **Remove background music** toggle. It runs a post-pass that splits the generated
audio into speech / music / effects and keeps everything **except** the music (dialogue and SFX are
preserved). It needs one extra, **optional** model — **BandIt Plus** (`bandit_music_removal` in the
manifest, ~142 MB). Download or **Locate…** it in the Models panel; it is placed under
`engine/ComfyUI/models/audio/bandit/`. The Python packages this feature needs (`librosa`,
`omegaconf`, `pytorch-lightning`, `spafe`, `ml-collections`) are installed automatically at first-run
setup. If you never enable the toggle, the model is not required and generation is unaffected.

---

## Verified end-to-end (on this machine)
- `run.bat` → automatic setup → **ComfyUI engine boots headless on :8199** (v0.27.0) and the app
  serves on **:8188**; setup is instant on repeat runs.
- **All required nodes load in the vendored engine**: `LTXDirector`, `LTXDirectorGuide`,
  `LTXDirectorCropGuides`, `VAELoaderKJ`, `ModelPreviewOverrideKJ`, `CinematicAudioSeparation`,
  and the LTXV / CreateVideo / SaveVideo core nodes.
- App shell: SPA + assets, `/api/config`, `/api/models`, model-status gating (Generate disabled and
  `/api/generate` → HTTP 400 until models resolve), **Locate** hard-links + flips status, workflow
  convert/inject unit-tested, UI verified in-browser with no console errors.

## Remaining (needs the LTX-2.3 model files)
- A real generation with live per-step preview + final video — provide models (above), then Generate.

> Note: `triton` isn't installed on Windows by default — you may see a harmless "PatchTritonVAE
> requires triton" warning. It's an optional speed optimization; the pipeline runs without it. For
> the speedup: `engine\python\Scripts\python.exe -m pip install triton-windows`.
