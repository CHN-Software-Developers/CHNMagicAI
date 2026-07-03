#!/usr/bin/env python3
"""Vendor a fresh, private ComfyUI engine for AIVideoBuilder.

Produces `engine/ComfyUI` (pristine ComfyUI) + the three custom-node packages the LTX Director 2
workflow needs, and (optionally) a Python venv with all dependencies. Records provenance
(commit hashes / source) so GPL-3.0 §5 obligations are met.

Custom nodes are copied from a detected local ComfyUI install when available (that gives the exact
versions this workflow was authored against); otherwise they are cloned from GitHub.

Usage:
    python scripts/vendor_engine.py                 # clone ComfyUI + vendor nodes (no heavy pip)
    python scripts/vendor_engine.py --install-deps  # also create venv and pip install (incl. torch)
    python scripts/vendor_engine.py --local-comfy "E:/path/to/ComfyUI/ComfyUI"
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENGINE = os.path.join(ROOT, "engine")
COMFY_DST = os.path.join(ENGINE, "ComfyUI")
NODES_DST = os.path.join(COMFY_DST, "custom_nodes")

COMFY_REPO = "https://github.com/comfyanonymous/ComfyUI"  # canonical; comfy-org/ComfyUI mirrors it
# Pin a commit for reproducibility; empty = default branch tip (hash is recorded afterward).
COMFY_COMMIT = ""

# id -> (local folder name, git url) ; local copy preferred when present.
CUSTOM_NODES = {
    "WhatDreamsCost-ComfyUI": "https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI",
    "comfyui-kjnodes": "https://github.com/kijai/ComfyUI-KJNodes",
    "cinematic_audio_separation": "",  # no known public git; copied from local install
}

DEFAULT_LOCAL_COMFY = "E:/ProgramData/ComfyUI-Installs/ComfyUI/ComfyUI"

IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".git")


def run(cmd, cwd=None):
    print("  $", " ".join(cmd))
    subprocess.check_call(cmd, cwd=cwd)


def git_rev(path):
    try:
        return subprocess.check_output(["git", "-C", path, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def clone_comfy():
    if os.path.isdir(os.path.join(COMFY_DST, ".git")) or os.path.isfile(os.path.join(COMFY_DST, "main.py")):
        print("[vendor] ComfyUI already present, skipping clone.")
        return
    os.makedirs(ENGINE, exist_ok=True)
    print("[vendor] cloning ComfyUI...")
    run(["git", "clone", "--depth", "1", COMFY_REPO, COMFY_DST])
    if COMFY_COMMIT:
        run(["git", "fetch", "--depth", "1", "origin", COMFY_COMMIT], cwd=COMFY_DST)
        run(["git", "checkout", COMFY_COMMIT], cwd=COMFY_DST)


def vendor_nodes(local_comfy):
    os.makedirs(NODES_DST, exist_ok=True)
    provenance = {}
    for name, url in CUSTOM_NODES.items():
        dst = os.path.join(NODES_DST, name)
        if os.path.isdir(dst):
            print(f"[vendor] {name} already present, skipping.")
            provenance[name] = {"source": "existing", "commit": git_rev(dst)}
            continue
        local_src = os.path.join(local_comfy, "custom_nodes", name) if local_comfy else None
        if local_src and os.path.isdir(local_src):
            print(f"[vendor] copying {name} from local install...")
            commit = git_rev(local_src)
            shutil.copytree(local_src, dst, ignore=IGNORE)
            provenance[name] = {"source": local_src, "commit": commit}
        elif url:
            print(f"[vendor] cloning {name}...")
            run(["git", "clone", "--depth", "1", url, dst])
            provenance[name] = {"source": url, "commit": git_rev(dst)}
        else:
            print(f"[vendor] WARNING: no source for {name}; place it manually in {dst}")
            provenance[name] = {"source": "MISSING", "commit": "n/a"}
    return provenance


def write_provenance(provenance):
    provenance["ComfyUI"] = {"source": COMFY_REPO, "commit": git_rev(COMFY_DST)}
    with open(os.path.join(ENGINE, "VENDOR_PROVENANCE.json"), "w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2)
    print("[vendor] wrote engine/VENDOR_PROVENANCE.json (record these in THIRD_PARTY_NOTICES.md)")


def install_deps():
    venv_dir = os.path.join(ENGINE, "python")
    if not os.path.isdir(venv_dir):
        print("[vendor] creating venv at engine/python ...")
        run([sys.executable, "-m", "venv", venv_dir])
    py = os.path.join(venv_dir, "Scripts", "python.exe")
    if not os.path.isfile(py):
        py = os.path.join(venv_dir, "bin", "python")
    run([py, "-m", "pip", "install", "--upgrade", "pip"])
    print("[vendor] installing PyTorch (CUDA). Adjust index-url for your GPU/CPU if needed.")
    run([py, "-m", "pip", "install", "torch", "torchvision", "torchaudio",
         "--index-url", "https://download.pytorch.org/whl/cu124"])
    req = os.path.join(COMFY_DST, "requirements.txt")
    if os.path.isfile(req):
        run([py, "-m", "pip", "install", "-r", req])
    run([py, "-m", "pip", "install", "-r", os.path.join(ROOT, "backend", "requirements.txt")])
    for name in CUSTOM_NODES:
        nreq = os.path.join(NODES_DST, name, "requirements.txt")
        if os.path.isfile(nreq):
            print(f"[vendor] installing requirements for {name}")
            run([py, "-m", "pip", "install", "-r", nreq])
    print("[vendor] done. Set config/settings.json python_exe to:", py)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--install-deps", action="store_true", help="create venv and pip install (heavy)")
    ap.add_argument("--local-comfy", default=DEFAULT_LOCAL_COMFY,
                    help="path to an existing ComfyUI to copy custom nodes from")
    args = ap.parse_args()

    clone_comfy()
    local = args.local_comfy if os.path.isdir(args.local_comfy) else None
    provenance = vendor_nodes(local)
    write_provenance(provenance)
    if args.install_deps:
        install_deps()
    else:
        print("\n[vendor] Source vendored. Re-run with --install-deps to build the Python env,")
        print("        or point config/settings.json python_exe at an existing ComfyUI Python.")


if __name__ == "__main__":
    main()
