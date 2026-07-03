"""First-run automatic setup. Run by the entry point (run.bat) before launching.

Idempotent: on subsequent runs it verifies quickly and returns fast. It performs, with no manual
steps required by the user:

  1. Vendor the engine source: copy ComfyUI from a local install if available (offline & fast),
     otherwise git-clone it. Copy the 3 required custom-node packages the same way.
  2. Create a private Python environment at engine/python.
  3. Install all dependencies into it: CUDA PyTorch, ComfyUI's requirements (sqlalchemy, filelock,
     blake3, Pillow, tqdm, comfy-aimdo, av, ...), each custom node's requirements, and our backend.
  4. Record the engine interpreter path (engine/python_path.txt + settings.python_exe).

Network note: pip calls use --trusted-host to tolerate corporate/self-signed CA setups that
otherwise fail with SSL: CERTIFICATE_VERIFY_FAILED.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENGINE = os.path.join(ROOT, "engine")
COMFY_DST = os.path.join(ENGINE, "ComfyUI")
NODES_DST = os.path.join(COMFY_DST, "custom_nodes")
VENV_DIR = os.path.join(ENGINE, "python")
STATE_FILE = os.path.join(ENGINE, ".setup_state.json")
PY_PATH_FILE = os.path.join(ENGINE, "python_path.txt")
CONFIG_PATH = os.path.join(ROOT, "config", "settings.json")
LOCAL_CONFIG_PATH = os.path.join(ROOT, "config", "settings.local.json")

CUSTOM_NODES = {
    "WhatDreamsCost-ComfyUI": "https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI",
    "comfyui-kjnodes": "https://github.com/kijai/ComfyUI-KJNodes",
    "cinematic_audio_separation": "",  # copied from local install; no known public git
}
TORCH_PKGS = ["torch", "torchsde", "torchvision", "torchaudio"]
# Deps required by vendored custom nodes that ship no requirements.txt
# (cinematic_audio_separation imports soundfile at module load).
EXTRA_NODE_DEPS = ["soundfile"]
# Top-level names to skip when copying a local ComfyUI (models/outputs/other people's nodes/etc.)
COPY_IGNORE = shutil.ignore_patterns(
    "models", "output", "input", "temp", "user", "custom_nodes",
    ".git", "__pycache__", "*.pyc", "venv", ".venv")


def log(msg):
    print(f"[setup] {msg}", flush=True)


def run(cmd, cwd=None):
    log("$ " + " ".join(str(c) for c in cmd))
    subprocess.check_call(cmd, cwd=cwd)


def load_settings():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        settings = json.load(f)
    # Per-machine overrides (git-ignored): python_exe, model paths, etc.
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH, "r", encoding="utf-8") as f:
            local = json.load(f)
        settings.update(local)
    return settings


def save_local(patch):
    """Merge per-machine values (e.g. python_exe) into the git-ignored settings.local.json,
    leaving the committed settings.json pristine."""
    local = {}
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH, "r", encoding="utf-8") as f:
            local = json.load(f)
    local.update(patch)
    with open(LOCAL_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(local, f, indent=2)


# ------------------------------- engine source -------------------------------

def _copy_tree(src, dst, ignore=None):
    log(f"copying {src} -> {dst}")
    shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)


def ensure_engine_source(setup):
    if os.path.isfile(os.path.join(COMFY_DST, "main.py")):
        log("ComfyUI source present.")
    else:
        os.makedirs(ENGINE, exist_ok=True)
        local = setup.get("local_comfy_source", "")
        if local and os.path.isfile(os.path.join(local, "main.py")):
            _copy_tree(local, COMFY_DST, ignore=COPY_IGNORE)
        else:
            log("cloning ComfyUI...")
            run(["git", "clone", "--depth", "1", setup["comfy_repo"], COMFY_DST])
            if setup.get("comfy_commit"):
                run(["git", "fetch", "--depth", "1", "origin", setup["comfy_commit"]], cwd=COMFY_DST)
                run(["git", "checkout", setup["comfy_commit"]], cwd=COMFY_DST)

    os.makedirs(NODES_DST, exist_ok=True)
    for name, url in CUSTOM_NODES.items():
        dst = os.path.join(NODES_DST, name)
        if os.path.isdir(dst):
            continue
        local = setup.get("local_comfy_source", "")
        local_node = os.path.join(local, "custom_nodes", name) if local else ""
        if local_node and os.path.isdir(local_node):
            _copy_tree(local_node, dst, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))
        elif url:
            run(["git", "clone", "--depth", "1", url, dst])
        else:
            log(f"WARNING: no source for {name}; place it in {dst} manually.")
    # dirs ComfyUI expects
    for d in ("input", "output", "user"):
        os.makedirs(os.path.join(COMFY_DST, d), exist_ok=True)


# ------------------------------- python env -------------------------------

def venv_python():
    for c in (os.path.join(VENV_DIR, "Scripts", "python.exe"),
              os.path.join(VENV_DIR, "bin", "python")):
        if os.path.isfile(c):
            return c
    return None


def ensure_venv(setup):
    py = venv_python()
    if py:
        return py
    base = setup.get("base_python") or sys.executable
    log(f"creating engine venv at {VENV_DIR} (base: {base})")
    run([base, "-m", "venv", VENV_DIR])
    py = venv_python()
    if not py:
        raise RuntimeError("Failed to create engine venv.")
    return py


# ------------------------------- dependencies -------------------------------

def pip(py, args, trusted):
    cmd = [py, "-m", "pip", "install", "--disable-pip-version-check"]
    for h in trusted:
        cmd += ["--trusted-host", h]
    cmd += args
    run(cmd)


def _module_present(py, mod):
    return subprocess.run([py, "-c", f"import {mod}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def _reqs_hash():
    parts = []
    for p in (os.path.join(COMFY_DST, "requirements.txt"),
              os.path.join(ROOT, "backend", "requirements.txt")):
        if os.path.isfile(p):
            parts.append(open(p, "rb").read())
    for name in CUSTOM_NODES:
        p = os.path.join(NODES_DST, name, "requirements.txt")
        if os.path.isfile(p):
            parts.append(open(p, "rb").read())
    parts.append(("extra:" + ",".join(EXTRA_NODE_DEPS)).encode())
    return hashlib.sha256(b"||".join(parts)).hexdigest()


def _load_state():
    if os.path.isfile(STATE_FILE):
        try:
            return json.load(open(STATE_FILE, encoding="utf-8"))
        except Exception:
            pass
    return {}


# Representative modules spanning torch, ComfyUI core, node deps and our backend. If all import,
# the env is already provisioned (e.g. user ran vendor_engine.py) and we skip pip entirely.
_PROBE_MODULES = ["torch", "sqlalchemy", "filelock", "blake3", "PIL", "tqdm", "av", "aiohttp",
                  "fastapi", "uvicorn", "numpy", "transformers", "safetensors", "soundfile"]


def _all_present(py):
    code = "import importlib.util,sys\n" + \
           "mods=%r\n" % _PROBE_MODULES + \
           "sys.exit(0 if all(importlib.util.find_spec(m) for m in mods) else 1)"
    return subprocess.run([py, "-c", code],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def ensure_deps(py, setup):
    trusted = setup.get("pip_trusted_hosts", [])
    state = _load_state()
    want = _reqs_hash()
    if state.get("reqs_hash") == want and _module_present(py, "torch") and _module_present(py, "sqlalchemy"):
        log("dependencies already satisfied.")
        return
    if _all_present(py):
        log("all required packages already installed; recording state.")
        json.dump({"reqs_hash": want}, open(STATE_FILE, "w", encoding="utf-8"))
        return

    pip(py, ["--upgrade", "pip"], trusted)

    if setup.get("auto_install_torch", True) and not _module_present(py, "torch"):
        log("installing PyTorch (CUDA). Change setup.torch_index_url for a different GPU/CPU build.")
        pip(py, TORCH_PKGS + ["--index-url", setup["torch_index_url"]], trusted)

    comfy_req = os.path.join(COMFY_DST, "requirements.txt")
    if os.path.isfile(comfy_req):
        log("installing ComfyUI requirements (sqlalchemy, filelock, blake3, Pillow, tqdm, comfy-aimdo, av, ...)")
        pip(py, ["-r", comfy_req], trusted)

    for name in CUSTOM_NODES:
        nreq = os.path.join(NODES_DST, name, "requirements.txt")
        if os.path.isfile(nreq):
            log(f"installing requirements for {name}")
            pip(py, ["-r", nreq], trusted)

    pip(py, ["-r", os.path.join(ROOT, "backend", "requirements.txt")], trusted)

    if EXTRA_NODE_DEPS:
        log("installing extra custom-node deps: " + ", ".join(EXTRA_NODE_DEPS))
        pip(py, EXTRA_NODE_DEPS, trusted)

    json.dump({"reqs_hash": want}, open(STATE_FILE, "w", encoding="utf-8"))
    log("dependencies installed.")


# ------------------------------- gpu self-check -------------------------------

# Run in the engine interpreter: confirms torch can actually launch a CUDA kernel on this GPU.
# Catches the "wrong PyTorch build for this GPU architecture" case (e.g. cu124 on an RTX 50-series),
# which otherwise only shows up as an opaque failure at generation time.
_GPU_CHECK = r"""
import torch
if not torch.cuda.is_available():
    print("GPU_CHECK: no CUDA GPU visible to torch (will run on CPU, very slow).")
else:
    name = torch.cuda.get_device_name(0)
    cap = "sm_%d%d" % torch.cuda.get_device_capability(0)
    archs = torch.cuda.get_arch_list()
    try:
        x = torch.randn(64, 64, device="cuda"); (x @ x).sum().item()
        print("GPU_CHECK OK: %s (%s), torch %s" % (name, cap, torch.__version__))
    except Exception as e:
        print("GPU_CHECK FAIL: %s (%s) is NOT supported by torch %s (builds: %s)."
              % (name, cap, torch.__version__, " ".join(archs)))
        print("GPU_CHECK FIX: set setup.torch_index_url to a matching CUDA build "
              "(cu128 for RTX 50-series), delete engine/.setup_state.json, and re-run. See SETUP.md.")
"""


def verify_gpu(py):
    try:
        out = subprocess.run([py, "-c", _GPU_CHECK], capture_output=True, text=True, timeout=120)
        for line in (out.stdout or "").splitlines():
            log(line)
        if "GPU_CHECK FAIL" in (out.stdout or ""):
            log("WARNING: the installed PyTorch cannot run on this GPU (see fix above).")
    except Exception as e:
        log(f"GPU self-check skipped: {e}")


# ------------------------------- main -------------------------------

def main():
    settings = load_settings()
    setup = settings.get("setup", {})
    if not setup.get("auto", True):
        log("setup.auto is false; skipping bootstrap.")
        py = settings.get("python_exe") or venv_python() or sys.executable
    else:
        ensure_engine_source(setup)
        py = ensure_venv(setup)
        ensure_deps(py, setup)

    save_local({"python_exe": py})
    with open(PY_PATH_FILE, "w", encoding="utf-8") as f:
        f.write(py)
    verify_gpu(py)
    log(f"setup complete. Engine Python: {py}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
