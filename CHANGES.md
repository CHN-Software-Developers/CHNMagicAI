# Changes to Vendored Third-Party Code

Per GPL-3.0 §5(a), every modification to a vendored file (under `engine/`) is recorded here with a
date and description. Our own application code (`backend/`, `config/`, `workflows/`, `scripts/`)
is original and not listed here.

Vendored code under `engine/` is kept pristine — the files that remain are byte-for-byte upstream,
**with one inherited exception**: the MSST framework embedded in the `cinematic_audio_separation`
node arrived with `msst/models/bandit/core/__init__.py` already trimmed to inference-only by the
node's author (training-only imports `asteroid` / `pedalboard` / `pyloudnorm` /
`torch_audiomentations` removed, none of which the inference path uses). The unmodified original is
preserved beside it as `__init__.py.orig_bak`. MSST is MIT-licensed. We made no further edits.

## Files removed from the vendored trees (2026-07-03)

To keep the repository lean, non-runtime files were **deleted** (not edited) from the vendored
ComfyUI and custom-node copies. No remaining source file was altered. Removed:

- `engine/ComfyUI/.git/` (upstream git history — see `THIRD_PARTY_NOTICES.md` for the pinned commit)
- `engine/ComfyUI/tests/`, `tests-unit/`, `pytest.ini` (test suites)
- `engine/ComfyUI/.github/`, `.ci/`, `.coderabbit.yaml`, `.spectral.yaml`, `.gitattributes`,
  `.gitignore`, `CODEOWNERS`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md` (CI / contributor tooling)
- `engine/ComfyUI/script_examples/`, `QUANTIZATION.md`, `extra_model_paths.yaml.example`,
  `custom_nodes/example_node.py.example` (examples/docs)
- `custom_nodes/*/example_workflows/`, `comfyui-kjnodes/custom_dimensions_example.json` (sample data)
- all `__pycache__/` and `*.pyc` (bytecode caches)

Every upstream `LICENSE`/`COPYING` and copyright header is retained, and all code required to run
the program is intact. The complete upstream source for each component is available at its pinned
commit (see `THIRD_PARTY_NOTICES.md`).

## Extra dependencies installed by our bootstrap (not modifications)

The `cinematic_audio_separation` node ships no `requirements.txt`; our `backend/bootstrap.py`
installs the packages its code imports so it loads and runs. These are install-time additions, not
source modifications:

- `soundfile` — imported by the node at module load.
- `librosa`, `omegaconf`, `pytorch-lightning`, `spafe`, `ml-collections` — top-level imports of the
  embedded MSST BandIt Plus inference path (run in a subprocess for the "Remove background music"
  option). All are permissive-licensed (see `THIRD_PARTY_NOTICES.md`).

## Model config added (not a modification, 2026-07-03)

`engine/ComfyUI/models/audio/bandit/config_dnr_bandit_bsrnn_multi_mus64.yaml` (the BandIt Plus model
config, ~1.7 KB) is committed so the music-removal node has its config in place. The matching
checkpoint (`model_bandit_plus_dnr_sdr_11.47.chpt`, ~142 MB) is **not** committed — it is
downloaded/located by the user (git-ignored). Neither is a change to vendored source.

