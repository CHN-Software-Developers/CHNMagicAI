"""First-run automatic setup. Run by the entry point (run.bat) before launching.

Idempotent: on subsequent runs it verifies quickly and returns fast. It performs, with no manual
steps required by the user:

  1. Verify the vendored engine source (ComfyUI + the 3 custom-node packages) is present. It ships
     inside the repo, so nothing is downloaded or cloned here; a missing source means a broken
     checkout, and we fail loudly rather than fetch anything from the network.
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

# Names of the vendored custom-node packages that ship inside engine/ComfyUI/custom_nodes. Used to
# verify their presence and to install their requirements; NOT to fetch them (they're committed).
CUSTOM_NODES = ["WhatDreamsCost-ComfyUI", "comfyui-kjnodes", "cinematic_audio_separation"]
TORCH_PKGS = ["torch", "torchsde", "torchvision", "torchaudio"]
# Deps required by vendored custom nodes that ship no requirements.txt.
# cinematic_audio_separation imports soundfile at module load, and its BandIt Plus
# inference subprocess (msst framework) top-level-imports librosa / omegaconf /
# pytorch_lightning / spafe / ml_collections. These are NOT ComfyUI-core deps, so they
# must be installed explicitly or the "Remove background music" option fails at runtime.
EXTRA_NODE_DEPS = ["soundfile", "librosa", "omegaconf", "pytorch-lightning",
                   "spafe", "ml-collections"]


def log(msg):
    print(f"[setup] {msg}", flush=True)


def phase(pct, msg):
    """Progress anchor for the Electron splash (see launcher.phase). Parsed from stdout."""
    print(f"AIVB_PHASE|{pct}|{msg}", flush=True)


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
    sys.path.insert(0, os.path.dirname(__file__))
    import env as env_mod
    env_mod.apply(settings)
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

def verify_engine_source():
    """Confirm the vendored engine source is present. ComfyUI and the three custom-node packages
    ship committed inside the repo, so a shipped app always has them; nothing is downloaded here.
    A missing source means an incomplete checkout (not a normal end-user state), so we fail loudly
    and point at the developer re-vendor tool instead of silently cloning anything from the network.
    We still create the runtime dirs ComfyUI expects, since their contents are git-ignored."""
    if not os.path.isfile(os.path.join(COMFY_DST, "main.py")):
        raise RuntimeError(
            f"Engine source missing at {COMFY_DST}. The app ships with ComfyUI vendored inside the "
            f"repo; this looks like an incomplete checkout. Restore it by re-cloning the repository "
            f"(or, for developers, run scripts/vendor_engine.py).")
    for name in CUSTOM_NODES:
        dst = os.path.join(NODES_DST, name)
        if not os.path.isdir(dst):
            raise RuntimeError(
                f"Vendored custom node '{name}' missing at {dst}. Restore the repository checkout "
                f"(or, for developers, run scripts/vendor_engine.py).")
    log("engine source present (vendored).")
    # runtime dirs ComfyUI expects (their contents are git-ignored, so recreate them)
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
    # --no-input: never drop into an interactive username/password prompt (e.g. when an index
    # returns 401). Unattended installs must fail fast, not block forever on stdin.
    cmd = [py, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
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
                  "fastapi", "uvicorn", "numpy", "transformers", "safetensors", "soundfile",
                  # cinematic_audio_separation (BandIt Plus) inference deps:
                  "librosa", "omegaconf", "pytorch_lightning", "spafe", "ml_collections"]


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
        phase(30, "Installing PyTorch (GPU) — please wait...")
        log("installing PyTorch (CUDA). Change setup.torch_index_url for a different GPU/CPU build.")
        pip(py, TORCH_PKGS + ["--index-url", setup["torch_index_url"]], trusted)

    comfy_req = os.path.join(COMFY_DST, "requirements.txt")
    if os.path.isfile(comfy_req):
        phase(45, "Installing engine dependencies...")
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


# ------------------------------- voice / TTS engine (optional, isolated) -------------------------------

# The voice engine install is NOT orchestrated inside this app. CosyVoice 3's requirements.txt is a
# consistent, upstream-tested pin set that its README installs as a single `pip install -r`. We simply
# generate a readable .bat that runs *that* command in a visible terminal the user can watch. Trying to
# filter/re-resolve the pins in-process is what made earlier installs backtrack for an hour. Only one
# tweak is baked in: PIP_CONSTRAINT=setuptools<81 so openai-whisper's old setup.py (which imports
# pkg_resources, removed from setuptools>=81) can still build. deepspeed / tensorrt-* / onnxruntime-gpu
# carry `; sys_platform == 'linux'` markers, so pip skips them on Windows automatically.
# faster-whisper isn't in CosyVoice's requirements; huggingface_hub backs our model download.
# truststore lets the service verify TLS against the OS certificate store, so model downloads succeed
# on networks that intercept TLS (where the bundled certifi CAs would fail cert verification).
_TTS_SERVER_DEPS = ["faster-whisper", "huggingface_hub", "truststore"]
_TTS_PROGRESS_FILE = "install-progress.txt"   # written by the installer, read by /api/tts/status
_TTS_SENTINEL_FILE = ".tts_installed"          # written on success


def _tts_venv_python(install_dir):
    for c in (os.path.join(install_dir, "python", "Scripts", "python.exe"),
              os.path.join(install_dir, "python", "bin", "python3"),
              os.path.join(install_dir, "python", "bin", "python")):
        if os.path.isfile(c):
            return c
    return None


def write_tts_install_script(install_dir):
    """Write a readable install_voice_engine.bat into `install_dir` and return its path.

    The script (run in a visible terminal, NOT as an in-app subprocess) locates Python 3.10, clones
    CosyVoice pristine, creates an isolated venv, runs CosyVoice's own `pip install -r requirements.txt`
    (with PIP_CONSTRAINT=setuptools<81 for the openai-whisper build), installs our service deps, and
    downloads the CosyVoice 3 + Whisper models. It writes coarse `stage|pct|message` lines to
    install-progress.txt so the UI can render a progress bar, and a sentinel file on success.
    """
    settings = load_settings()
    tts = settings.get("tts", {})
    install_dir = os.path.abspath(install_dir)
    cosy_dir = os.path.join(install_dir, "CosyVoice")
    models_dir = os.path.join(install_dir, "models")
    model_dir = os.path.join(models_dir, tts.get("model_dirname", "Fun-CosyVoice3-0.5B"))
    hf_cache = os.path.join(install_dir, "hf_cache")
    progress_file = os.path.join(install_dir, _TTS_PROGRESS_FILE)
    sentinel = os.path.join(install_dir, _TTS_SENTINEL_FILE)
    constraints = os.path.join(install_dir, "pip-constraints.txt")
    os.makedirs(models_dir, exist_ok=True)
    os.makedirs(hf_cache, exist_ok=True)

    repo = tts.get("repo", "https://github.com/FunAudioLLM/CosyVoice")
    commit = (tts.get("commit") or "").strip()
    model_repo = tts.get("model_repo", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512")
    whisper_model = tts.get("whisper_model", "base")
    mirror = tts.get("mirror", "https://mirrors.aliyun.com/pypi/simple/")
    trusted_host = tts.get("trusted_host", "mirrors.aliyun.com")
    gpu_index = tts.get("gpu_index", "https://download.pytorch.org/whl/cu128")
    # Pin the GPU torch build: 2.7.x supports newer GPUs (Blackwell/sm_120) via cu128 AND still ships
    # torchaudio's soundfile backend. torchaudio >= 2.9 drops it for torchcodec (needs FFmpeg DLLs,
    # poor on Windows), which breaks CosyVoice's audio I/O — so do NOT just --upgrade to latest.
    gpu_packages = tts.get("gpu_packages", "torch==2.7.1 torchaudio==2.7.1")
    server_deps = " ".join(_TTS_SERVER_DEPS)
    # Optional per-machine override: a Python 3.10 interpreter (e.g. a conda env's python.exe that the
    # `py` launcher can't see). Baked in as the first choice; must be a space-free path if set.
    py_pref = (tts.get("python310") or "").strip()

    if commit:
        commit_block = (
            'if exist "%COSY_DIR%\\.git" (\n'
            '  pushd "%COSY_DIR%"\n'
            f'  git fetch --depth 1 origin {commit}\n'
            f'  git checkout {commit}\n'
            '  git submodule update --init --recursive\n'
            '  popd\n'
            ')\n'
        )
    else:
        commit_block = "REM (no pinned commit configured)\n"

    script = f"""@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Voice engine installer (CosyVoice 3)

set "INSTALL_DIR={install_dir}"
set "COSY_DIR={cosy_dir}"
set "MODEL_DIR={model_dir}"
set "HF_CACHE={hf_cache}"
set "PROGRESS_FILE={progress_file}"
set "SENTINEL={sentinel}"
set "CONSTRAINTS={constraints}"
set "REPO={repo}"
set "MODEL_REPO={model_repo}"
set "WHISPER_MODEL={whisper_model}"
set "MIRROR={mirror}"
set "TRUSTED_HOST={trusted_host}"
set "GPU_INDEX={gpu_index}"
set "GPU_PACKAGES={gpu_packages}"

echo ============================================================
echo   CHNMagicAI - Voice engine (CosyVoice 3) installer
echo   Install location: %INSTALL_DIR%
echo ============================================================
echo.
call :progress start 0 "Starting voice engine install..."

REM ---- 1) locate Python 3.10 (CosyVoice requires 3.10) ----
call :progress python 5 "Locating Python 3.10..."
set "PY310={py_pref}"
if not defined PY310 (
  py -3.10 --version >nul 2>&1 && set "PY310=py -3.10"
)
if not defined PY310 (
  where python3.10 >nul 2>&1 && set "PY310=python3.10"
)
if not defined PY310 (
  for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do echo %%v| findstr /b /c:"3.10" >nul && set "PY310=python"
)
if not defined PY310 (
  call :progress error 5 "Python 3.10 not found - install it from python.org and re-run."
  echo.
  echo [ERROR] Python 3.10 was not found on this machine.
  echo         CosyVoice requires Python 3.10. Install it from
  echo         https://www.python.org/downloads/release/python-31011/
  echo         Tick "Add python.exe to PATH", then re-run this installer.
  goto :fail
)
for /f "delims=" %%v in ('%PY310% --version 2^>^&1') do echo Using %%v

REM ---- 2) clone CosyVoice (pristine) ----
if exist "%COSY_DIR%\\cosyvoice\\cli\\cosyvoice.py" (
  echo CosyVoice source already present, skipping clone.
) else (
  call :progress clone 10 "Downloading CosyVoice source..."
  git clone --recursive --depth 1 "%REPO%" "%COSY_DIR%"
  if errorlevel 1 goto :fail
)
{commit_block}
REM ---- 3) create isolated venv ----
set "VENV_PY=%INSTALL_DIR%\\python\\Scripts\\python.exe"
if exist "%VENV_PY%" (
  echo Python environment already exists, skipping.
) else (
  call :progress venv 20 "Creating isolated Python environment..."
  %PY310% -m venv "%INSTALL_DIR%\\python"
  if errorlevel 1 goto :fail
)
if not exist "%VENV_PY%" goto :fail

REM ---- 4) upgrade pip ----
call :progress deps 25 "Upgrading pip..."
"%VENV_PY%" -m pip install --upgrade pip
if errorlevel 1 goto :fail

REM ---- 5) install CosyVoice requirements (CosyVoice's official command) ----
REM Pin setuptools<81 for the build so openai-whisper's setup.py (imports pkg_resources,
REM removed from setuptools>=81) can build. PIP_CONSTRAINT applies to build-isolation envs too.
>"%CONSTRAINTS%" echo setuptools^<81
set "PIP_CONSTRAINT=%CONSTRAINTS%"
call :progress deps 40 "Installing CosyVoice requirements (this can take a while)..."
"%VENV_PY%" -m pip install -r "%COSY_DIR%\\requirements.txt" -i %MIRROR% --trusted-host=%TRUSTED_HOST%
if errorlevel 1 goto :fail
set "PIP_CONSTRAINT="

REM ---- 6) service deps (faster-whisper + huggingface_hub) ----
call :progress deps 60 "Installing speech-recognition dependencies..."
"%VENV_PY%" -m pip install {server_deps} -i %MIRROR% --trusted-host=%TRUSTED_HOST%
if errorlevel 1 goto :fail

REM ---- 6b) GPU acceleration for newer GPUs ----
REM CosyVoice pins torch cu121, which has no kernels for RTX 50-series (Blackwell / sm_120) and
REM similar newer cards. If such a GPU is present, reinstall torch/torchaudio from the cu128 index so
REM synthesis runs on the GPU instead of falling back to CPU. Detected by comparing the GPU's compute
REM capability against the arch list the installed torch was built for. Non-fatal: CPU still works.
call :progress gpu 66 "Checking GPU compatibility..."
"%VENV_PY%" -c "import torch,sys; sys.exit(0 if (torch.cuda.is_available() and ('sm_%%d%%d' %% torch.cuda.get_device_capability(0)) not in torch.cuda.get_arch_list()) else 1)"
if not errorlevel 1 (
  call :progress gpu 68 "Newer GPU detected - installing CUDA PyTorch for acceleration..."
  echo Installing GPU PyTorch (%GPU_PACKAGES%) from %GPU_INDEX% ...
  "%VENV_PY%" -m pip install %GPU_PACKAGES% --index-url %GPU_INDEX%
  if errorlevel 1 echo [warning] GPU PyTorch install failed; the engine will run on CPU.
) else (
  echo GPU either already supported by the installed PyTorch, or no CUDA GPU present.
)

REM ---- 7) download CosyVoice 3 model ----
call :progress model 70 "Downloading CosyVoice 3 model (~2 GB)..."
"%VENV_PY%" -c "import os; os.environ['HF_HOME']=r'%HF_CACHE%'; from huggingface_hub import snapshot_download; snapshot_download('%MODEL_REPO%', local_dir=r'%MODEL_DIR%')"
if errorlevel 1 goto :fail

REM ---- 8) pre-fetch Whisper model (non-fatal) ----
call :progress whisper 90 "Fetching speech-recognition model..."
"%VENV_PY%" -c "import os; os.environ['HF_HOME']=r'%HF_CACHE%'; from faster_whisper import WhisperModel; WhisperModel('%WHISPER_MODEL%', device='cpu', compute_type='int8')"
if errorlevel 1 echo [warning] could not pre-fetch the Whisper model; it will download on first use.

REM ---- done ----
>"%SENTINEL%" echo installed
call :progress done 100 "Voice engine ready."
echo.
echo ============================================================
echo   Voice engine installed successfully.
echo   You can close this window - the app will detect it shortly.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo ============================================================
echo   Voice engine install FAILED. See the messages above.
echo ============================================================
if not exist "%SENTINEL%" call :progress error 0 "Install failed - see the terminal window."
pause
exit /b 1

:progress
>"%PROGRESS_FILE%" echo %~1^|%~2^|%~3
goto :eof
"""
    script_path = os.path.join(install_dir, "install_voice_engine.bat")
    with open(script_path, "w", encoding="ascii", errors="replace", newline="\r\n") as f:
        f.write(script)
    return script_path


def _launch_in_new_console(script_path):
    """Open `script_path` in its own visible terminal window and return immediately."""
    if os.name == "nt":
        os.startfile(script_path)  # opens a new console; the script's `pause` keeps it visible
    else:  # dev fallback on non-Windows
        subprocess.Popen(["sh", script_path])


def app_data_dir(*parts):
    """Return a platform-appropriate per-user app-data path under CHNMagicAI/, joined with *parts.

    This is the shared home for anything that must live OUTSIDE the repo working copy (voice-engine
    install, the projects registry, etc.) so defaults never dump large trees into the checkout.

    When AIVB_DATA_DIR is set (Electron desktop / RunPod /workspace), everything is relocated there
    so app data lands on the writable/persistent volume instead of the OS app-data dir."""
    override = (os.environ.get("AIVB_DATA_DIR") or "").strip()
    if override:
        return os.path.join(os.path.abspath(override), *parts)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "CHNMagicAI", *parts)


def default_tts_install_dir():
    """Per-machine home for the voice engine (CosyVoice clone + private venv + downloaded model
    weights and caches) when the user hasn't chosen a location. Deliberately OUTSIDE the app repo —
    a platform-appropriate per-user app-data dir — so a default install never dumps a multi-GB tree
    into the working copy (which showed up as an untracked `tts_engine/`). The user can still point
    this anywhere via the Models panel (persisted to settings.local.json)."""
    return app_data_dir("tts_engine")


def resolve_tts_install_dir(tts_cfg):
    """Turn a configured tts.install_dir into an absolute path. Empty/unset -> the app-data default.
    A relative value stays repo-relative (back-compat for anyone who set one)."""
    d = (tts_cfg or {}).get("install_dir")
    if not d:
        return default_tts_install_dir()
    return d if os.path.isabs(d) else os.path.join(ROOT, d)


def setup_tts(install_dir=None, progress_cb=None):
    """Launch the voice-engine installer in a new terminal window. Returns (ok, message).

    This no longer installs anything in-process: it writes install_voice_engine.bat into `install_dir`
    and opens it in a visible console the user can watch. Completion/progress are observed via the
    install-progress.txt / .tts_installed files that the script writes (see /api/tts/status).
    `progress_cb` is accepted for backward compatibility but unused.
    """
    settings = load_settings()
    tts = settings.get("tts", {})

    if not install_dir:
        install_dir = resolve_tts_install_dir(tts)
    install_dir = os.path.abspath(install_dir)

    try:
        os.makedirs(install_dir, exist_ok=True)
        # Clear any stale progress marker so the UI reflects THIS run, not a previous one.
        try:
            os.remove(os.path.join(install_dir, _TTS_PROGRESS_FILE))
        except OSError:
            pass
        script_path = write_tts_install_script(install_dir)
        _launch_in_new_console(script_path)
    except Exception as e:
        log(f"[tts] failed to launch installer: {e}")
        return False, f"Could not launch the voice engine installer: {e}"

    return True, "Installer launched in a new terminal window."


# ------------------------------- main -------------------------------

def main():
    settings = load_settings()
    setup = settings.get("setup", {})
    if not setup.get("auto", True):
        log("setup.auto is false; skipping bootstrap.")
        py = settings.get("python_exe") or venv_python() or sys.executable
    else:
        phase(10, "Verifying the engine source...")
        verify_engine_source()
        phase(20, "Creating the Python environment...")
        py = ensure_venv(setup)
        ensure_deps(py, setup)
        phase(55, "Finalizing setup...")

    save_local({"python_exe": py})
    with open(PY_PATH_FILE, "w", encoding="utf-8") as f:
        f.write(py)
    verify_gpu(py)
    log(f"setup complete. Engine Python: {py}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
