# Changes to Vendored Third-Party Code

Per GPL-3.0 §5(a), every modification to a vendored file (under `engine/`) is recorded here with a
date and description. Our own application code (`backend/`, `config/`, `workflows/`, `scripts/`)
is original and not listed here.

_No vendored **source** files have been modified._ (Vendored code under `engine/` is kept pristine —
the files that remain are byte-for-byte upstream.)

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
installs its one module-level dependency `soundfile` so it loads. This is an install-time addition,
not a source modification.

