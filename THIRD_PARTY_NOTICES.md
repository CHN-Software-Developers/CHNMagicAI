# Third-Party Notices

CHNMagicAI is distributed under the **GNU General Public License v3.0** (see `LICENSE`).
It bundles and builds upon the following third-party components. Each is used under its own
license; all are GPL-3.0 or GPL-compatible. Their original license files are preserved inside
their vendored directories under `engine/`.

| Component | Source | License | Vendored at | Pinned commit |
|---|---|---|---|---|
| ComfyUI | https://github.com/comfyanonymous/ComfyUI | GPL-3.0 | `engine/ComfyUI` | `1e04ced089758f1855b84abad739be503c7dc9cd` |
| WhatDreamsCost-ComfyUI (LTX Director) | https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI | GPL-3.0 | `engine/ComfyUI/custom_nodes/WhatDreamsCost-ComfyUI` | `0dfa657a8676f2c56ecc84b735402dcfd6c1eae5` (v2.0.2) |
| ComfyUI-KJNodes | https://github.com/kijai/ComfyUI-KJNodes | GPL-3.0 | `engine/ComfyUI/custom_nodes/comfyui-kjnodes` | `eca4757d653654deb5744edf16a862f352800fdc` |
| MSST — Music-Source-Separation-Training (ZFTurbo) | https://github.com/ZFTurbo/Music-Source-Separation-Training | MIT | `engine/ComfyUI/custom_nodes/cinematic_audio_separation/msst` | — |

## What was stripped from the vendored copies

To keep this repository lean, the vendored trees under `engine/` have had **non-runtime** files
removed: each component's `.git` history, CI/workflow configs (`.github/`, `.ci/`), test suites
(`tests/`, `tests-unit/`), example workflows/nodes, and Python bytecode caches. **All source code
required to build, install, and run the program — plus every upstream `LICENSE`/`COPYING` and
copyright notice — is retained.** For each component's complete, unmodified upstream source, see its
Source URL at the pinned commit above (GPL-3.0 §6: the complete corresponding source remains
available upstream, and this repository ships the full runtime source).

## Background-music removal — model & runtime dependencies

The optional "Remove background music" feature runs the `CinematicAudioSeparation` node, which
invokes the vendored **MSST** framework's BandIt Plus model in an isolated subprocess.

- **Model weights** — `model_bandit_plus_dnr_sdr_11.47.chpt` (BandIt Plus, trained on the
  Divide-and-Remaster dataset), distributed via ZFTurbo's MSST. **Not committed** to this
  repository (≈142 MB); the user downloads or locates it (see `config/models_manifest.json`,
  id `bandit_music_removal`). It is placed at `engine/ComfyUI/models/audio/bandit/`. The small
  companion `config_dnr_bandit_bsrnn_multi_mus64.yaml` **is** committed there. Verify the model
  weights' own usage terms with the MSST project before redistribution.
- **Extra Python packages** installed at first-run setup for this feature (permissive licenses,
  fetched by pip — not vendored as source in this repo):

  | Package | License |
  |---|---|
  | librosa | ISC |
  | omegaconf | BSD-3-Clause |
  | pytorch-lightning | Apache-2.0 |
  | spafe | BSD-3-Clause |
  | ml-collections | Apache-2.0 |

## Voice / text-to-speech (optional, isolated install)

The optional voice feature ("Generate speech" in the Add-audio dialog) installs and runs
**CosyVoice 3** in its own isolated Python environment under a user-chosen directory (default
`tts_engine/`), fully separate from the ComfyUI engine. It is driven over localhost by our own
service wrapper `tts_service/server.py` (GPL-3.0), which imports the **unmodified** upstream
packages — no vendored TTS source is patched. Because the isolated environment lives outside the
committed tree and is fetched at install time, these components are **not vendored as source** in
this repository:

| Component | Source | License | Notes |
|---|---|---|---|
| CosyVoice (code) | https://github.com/FunAudioLLM/CosyVoice | Apache-2.0 | Cloned pristine into `<install_dir>/CosyVoice` at first install. Apache-2.0 is one-way compatible with GPL-3.0; the combined work remains GPL-3.0. |
| Fun-CosyVoice3-0.5B (model weights) | https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512 | Apache-2.0 | Downloaded into `<install_dir>/models/`; commercial use permitted. |
| faster-whisper | https://github.com/SYSTRAN/faster-whisper | MIT | Auto-transcribes the reference clip for voice cloning. |
| Whisper model (Systran/faster-whisper-*) | https://huggingface.co/Systran | MIT | Small ASR model, downloaded at install. |

**Voice-cloning ethics/consent:** the cloning path synthesizes speech in the likeness of a supplied
reference voice. Only clone voices you have the right to use, and follow CosyVoice's own usage
notice. CHNMagicAI surfaces this caveat in the install panel. Verify each model's usage terms
before redistribution.

## Bundled Python runtime (desktop app only)

The **desktop (Electron)** build ships a self-contained Python 3.10 interpreter so end users need no
prior Python installation. It is **not committed** to this repository — `desktop/fetch-python.mjs`
downloads it at build time into `desktop/python/`, and `electron-builder` packages that tree into the
`.exe`. The **RunPod** image instead uses the base image's distro Python (Ubuntu 22.04 `python3.10`),
and the **repo/dev** run uses the developer's own Python — neither redistributes a Python runtime.

The bundled interpreter is **python-build-standalone**, a relocatable redistribution of upstream
CPython (not modified by us). It is a *build* of standard CPython plus statically-bundled support
libraries; each retains its own license:

| Component | Source | License | Notes |
|---|---|---|---|
| CPython | https://www.python.org | PSF License (BSD-style, GPL-compatible) | The interpreter and standard library. |
| python-build-standalone | https://github.com/astral-sh/python-build-standalone | MPL-2.0 (build tooling) | astral-sh's build scripts that produce the relocatable distribution. MPL-2.0 is file-scoped copyleft and GPL-compatible; we redistribute the unmodified prebuilt artifact, not the build sources. |
| Bundled support libs (OpenSSL, SQLite, libffi, zlib, bzip2, xz/liblzma, ncurses/readline, Tcl/Tk, …) | see the distribution's `licenses/` manifest | Various permissive (Apache-2.0 / BSD / MIT / OpenSSL / TCL, …) | Statically bundled into the interpreter by python-build-standalone. |

The complete, authoritative per-component license texts ship **inside** the downloaded distribution
(the `python/licenses/` directory and `PYTHON.json` manifest) and are packaged with the desktop app;
that folder must not be stripped during packaging. All of the above are permissive or file-scoped and
compatible with CHNMagicAI's GPL-3.0. We ship the prebuilt runtime **unmodified** — the MPL-2.0 build
sources are available upstream at the URL above.

## Modification policy (GPL-3.0 §5a)

Vendored code under `engine/` is kept **pristine**. Application logic lives in our own files
(`backend/`, `config/`, `workflows/`, `scripts/`). If a vendored file must be patched, the file
carries a dated notice:

```
# Modified by CHNMagicAI on <YYYY-MM-DD>: <what changed and why>
```

and the change is logged in `CHANGES.md`. **Exception:** the vendored MSST tree inside the
`cinematic_audio_separation` node arrived with one upstream-author modification —
`msst/models/bandit/core/__init__.py` was trimmed to inference-only (training-only imports
removed); the original is preserved beside it as `__init__.py.orig_bak`. MSST is MIT-licensed,
which permits this. No other vendored files have been modified.

## Corresponding source

The complete corresponding source for CHNMagicAI and all bundled GPL components is available
in this repository (the vendored components retain their upstream source under `engine/`).
