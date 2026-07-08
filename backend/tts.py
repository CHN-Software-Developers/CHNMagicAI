"""Voice/TTS service manager (part of the FastAPI orchestrator).

Owns the lifecycle of the hidden CosyVoice 3 subprocess (tts_service/server.py) that runs in its
own isolated environment, and proxies synthesize/transcribe calls to it over 127.0.0.1. The
orchestrator never imports CosyVoice itself — this keeps CosyVoice's heavy, version-pinned deps out
of the ComfyUI/LTX engine, and makes the whole voice feature optional: if it isn't installed (or its
Windows deps failed to build), the video app is entirely unaffected.

Lifecycle is lazy: the subprocess is started on first use and auto-stopped after an idle period, so
it does not hold VRAM/RAM during video generation. Mirrors the ComfyUI subprocess pattern in
launcher.py (Popen + poll a health endpoint).
"""
import asyncio
import os
import socket
import subprocess
import sys
import time

import aiohttp

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TTS_SERVER = os.path.join(ROOT, "tts_service", "server.py")


def _port_in_use(host, port):
    """True if something is already accepting TCP connections on host:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, int(port))) == 0


def _pid_is_python(pid):
    """Best-effort check that `pid` is a live python process — a guard against PID reuse before we
    kill a recorded PID to reclaim the port. Only ever used together with a port-in-use check."""
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=5).stdout.lower()
        else:
            out = subprocess.run(["ps", "-p", str(pid), "-o", "comm="],
                                 capture_output=True, text=True, timeout=5).stdout.lower()
        return "python" in out
    except Exception:
        return False


def _kill_pid(pid):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=10)
        else:
            os.kill(int(pid), 9)
    except Exception:
        pass


def _abs_install_dir(tts_cfg):
    # Shared with the installer so the running service and setup_tts always agree on the location
    # (empty/unset -> per-user app-data dir outside the repo; relative -> repo-relative back-compat).
    import bootstrap
    return bootstrap.resolve_tts_install_dir(tts_cfg)


def _venv_python(install_dir):
    for c in (os.path.join(install_dir, "python", "Scripts", "python.exe"),
              os.path.join(install_dir, "python", "bin", "python3"),
              os.path.join(install_dir, "python", "bin", "python")):
        if os.path.isfile(c):
            return c
    return None


def _read_install_progress(install_dir):
    """Read the installer's 'stage|pct|message' marker (written by install_voice_engine.bat).

    Returns {stage, pct, message} or None. Tolerant of a partially-written line (the terminal
    overwrites this file as it runs, concurrently with our read)."""
    fp = os.path.join(install_dir, "install-progress.txt")
    try:
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            line = f.read().strip()
    except OSError:
        return None
    if not line:
        return None
    parts = line.split("|", 2)
    if len(parts) < 3:
        return None
    stage, pct, message = parts
    try:
        pct = int(pct)
    except ValueError:
        pct = None
    return {"stage": stage.strip(), "pct": pct, "message": message.strip()}


def paths(tts_cfg):
    """Resolve all on-disk locations for the isolated TTS install."""
    install_dir = _abs_install_dir(tts_cfg)
    return {
        "install_dir": install_dir,
        "python": _venv_python(install_dir),
        "cosyvoice_dir": os.path.join(install_dir, "CosyVoice"),
        "model_dir": os.path.join(install_dir, "models", tts_cfg.get("model_dirname", "Fun-CosyVoice3-0.5B")),
    }


class TtsService:
    def __init__(self, settings):
        self._settings = settings
        self.proc = None
        self._start_lock = asyncio.Lock()
        self._last_used = 0.0
        self._idle_task = None

    # ---- config helpers (re-read each call so a changed install_dir takes effect) ----
    def _cfg(self):
        return self._settings.get("tts", {})

    def _base_url(self):
        c = self._cfg()
        return f"http://{c.get('host', '127.0.0.1')}:{c.get('port', 50000)}"

    def is_installed(self):
        p = paths(self._cfg())
        return bool(p["python"]) and os.path.isdir(p["cosyvoice_dir"]) and os.path.isdir(p["model_dir"])

    # ---- lifecycle ----
    async def _healthy(self, timeout=2):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as s:
                async with s.get(self._base_url() + "/health") as r:
                    if r.status == 200:
                        return await r.json()
        except Exception:
            return None
        return None

    async def ensure_running(self):
        """Start the subprocess if needed and wait until it answers /health. Returns health dict."""
        if not self.is_installed():
            raise RuntimeError("The voice engine is not installed yet. Open the Models panel to install it.")
        health = await self._healthy()
        if health:
            self._touch()
            return health
        async with self._start_lock:
            health = await self._healthy()
            if health:
                self._touch()
                return health
            c = self._cfg()
            host = c.get("host", "127.0.0.1")
            port = int(c.get("port", 50000))
            own_alive = bool(self.proc and self.proc.poll() is None)
            if not own_alive:
                if _port_in_use(host, port):
                    # The port is held but nothing answered /health above. If it's a stale voice-engine
                    # process we started in a previous run, reclaim it; otherwise refuse to launch a
                    # duplicate that would just fail to bind, and say so clearly.
                    if not self._reclaim_orphan(host, port):
                        raise RuntimeError(
                            f"Port {port} is in use by an unresponsive process. Close whatever is using "
                            f"{host}:{port} (or restart your machine) and try again.")
                self._spawn()
            deadline = time.time() + int(c.get("startup_timeout_seconds", 300))
            while time.time() < deadline:
                # Only a real failure if our process exited AND nothing is serving the port.
                if self.proc and self.proc.poll() is not None and not _port_in_use(host, port):
                    raise RuntimeError("The voice engine failed to start (subprocess exited). See the console log.")
                health = await self._healthy()
                if health:
                    self._touch()
                    self._start_idle_watch()
                    return health
                await asyncio.sleep(1.5)
            raise RuntimeError("The voice engine did not become ready in time. If a previous voice-engine "
                               "process is stuck, close it and retry.")

    def _pid_path(self):
        return os.path.join(_abs_install_dir(self._cfg()), "tts_service.pid")

    def _read_pid(self):
        try:
            with open(self._pid_path(), "r", encoding="utf-8") as f:
                return int(f.read().strip())
        except (OSError, ValueError):
            return None

    def _reclaim_orphan(self, host, port):
        """A previous run left our voice-engine process bound to the port but unresponsive. Kill only
        the PID we recorded (and only if it's still a python process) so we can start fresh, without
        touching an unrelated program that merely happens to hold the port. Returns True if freed."""
        pid = self._read_pid()
        if not pid or not _pid_is_python(pid):
            return False
        print(f"[tts] reclaiming stale voice-engine process pid={pid} on {host}:{port}", flush=True)
        _kill_pid(pid)
        for _ in range(20):  # up to ~5s for the port to be released
            if not _port_in_use(host, port):
                return True
            time.sleep(0.25)
        return not _port_in_use(host, port)

    def _spawn(self):
        p = paths(self._cfg())
        c = self._cfg()
        cmd = [
            p["python"], TTS_SERVER,
            "--host", c.get("host", "127.0.0.1"),
            "--port", str(c.get("port", 50000)),
            "--cosyvoice-dir", p["cosyvoice_dir"],
            "--model-dir", p["model_dir"],
            "--whisper-model", c.get("whisper_model", "base"),
        ]
        print("[tts] starting voice engine:", " ".join(cmd), flush=True)
        # cwd = CosyVoice repo so its relative asset/third_party lookups resolve.
        self.proc = subprocess.Popen(cmd, cwd=p["cosyvoice_dir"])
        # Record the PID so a later run can reclaim this exact process if the app restarts while it's
        # still bound to the port (Windows doesn't kill child processes when the parent dies).
        try:
            with open(self._pid_path(), "w", encoding="utf-8") as f:
                f.write(str(self.proc.pid))
        except OSError:
            pass

    def _touch(self):
        self._last_used = time.time()

    def _start_idle_watch(self):
        if self._idle_task and not self._idle_task.done():
            return
        self._idle_task = asyncio.ensure_future(self._idle_watch())

    async def _idle_watch(self):
        idle = int(self._cfg().get("idle_shutdown_seconds", 600))
        if idle <= 0:
            return
        while self.proc and self.proc.poll() is None:
            await asyncio.sleep(30)
            if time.time() - self._last_used > idle:
                print("[tts] idle timeout; stopping voice engine to free memory.", flush=True)
                self.stop()
                return

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except Exception:
                self.proc.kill()
        self.proc = None
        try:
            os.remove(self._pid_path())
        except OSError:
            pass

    # ---- calls ----
    async def status(self):
        installed = self.is_installed()
        health = await self._healthy() if installed else None
        p = paths(self._cfg())
        progress = _read_install_progress(p["install_dir"])
        # "installing" while the terminal is running: a progress marker exists, it isn't a terminal
        # state, and the install hasn't finished yet.
        installing = bool(progress) and not installed and progress.get("stage") not in ("error", "done")
        return {
            "enabled": self._cfg().get("enabled", True),
            "installed": installed,
            "running": bool(health),
            "install_dir": p["install_dir"],
            "model_present": os.path.isdir(p["model_dir"]),
            "python_present": bool(p["python"]),
            "installing": installing,
            "install_progress": progress,
            "available_spks": (health or {}).get("available_spks", []),
            "sample_rate": (health or {}).get("sample_rate"),
        }

    async def synthesize(self, payload):
        await self.ensure_running()
        self._touch()
        # Generation can be slow on first call (model load); allow a generous timeout.
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=600)) as s:
            async with s.post(self._base_url() + "/synthesize", json=payload) as r:
                data = await r.json()
                return data, r.status

    async def transcribe(self, payload):
        await self.ensure_running()
        self._touch()
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as s:
            async with s.post(self._base_url() + "/transcribe", json=payload) as r:
                data = await r.json()
                return data, r.status
