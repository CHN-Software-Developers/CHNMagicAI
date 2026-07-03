# Third-Party Notices

AIVideoBuilder is distributed under the **GNU General Public License v3.0** (see `LICENSE`).
It bundles and builds upon the following third-party components. Each is used under its own
license; all are GPL-3.0 or GPL-compatible. Their original license files are preserved inside
their vendored directories under `engine/`.

| Component | Source | License | Vendored at | Pinned commit |
|---|---|---|---|---|
| ComfyUI | https://github.com/comfyanonymous/ComfyUI | GPL-3.0 | `engine/ComfyUI` | `1e04ced089758f1855b84abad739be503c7dc9cd` |
| WhatDreamsCost-ComfyUI (LTX Director) | https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI | GPL-3.0 | `engine/ComfyUI/custom_nodes/WhatDreamsCost-ComfyUI` | `0dfa657a8676f2c56ecc84b735402dcfd6c1eae5` (v2.0.2) |
| ComfyUI-KJNodes | https://github.com/kijai/ComfyUI-KJNodes | GPL-3.0 | `engine/ComfyUI/custom_nodes/comfyui-kjnodes` | `eca4757d653654deb5744edf16a862f352800fdc` |
| ComfyUI Cinematic Audio Separation (node wrapper) | custom-built; vendored from a local ComfyUI install (no known public git remote) | check upstream headers | `engine/ComfyUI/custom_nodes/cinematic_audio_separation` | — |
| └ MSST — Music-Source-Separation-Training (ZFTurbo) | https://github.com/ZFTurbo/Music-Source-Separation-Training | MIT | `engine/ComfyUI/custom_nodes/cinematic_audio_separation/msst` | — |

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

## Modification policy (GPL-3.0 §5a)

Vendored code under `engine/` is kept **pristine**. Application logic lives in our own files
(`backend/`, `config/`, `workflows/`, `scripts/`). If a vendored file must be patched, the file
carries a dated notice:

```
# Modified by AIVideoBuilder on <YYYY-MM-DD>: <what changed and why>
```

and the change is logged in `CHANGES.md`. **Exception:** the vendored MSST tree inside the
`cinematic_audio_separation` node arrived with one upstream-author modification —
`msst/models/bandit/core/__init__.py` was trimmed to inference-only (training-only imports
removed); the original is preserved beside it as `__init__.py.orig_bak`. MSST is MIT-licensed,
which permits this. No other vendored files have been modified.

## Corresponding source

The complete corresponding source for AIVideoBuilder and all bundled GPL components is available
in this repository (the vendored components retain their upstream source under `engine/`).
