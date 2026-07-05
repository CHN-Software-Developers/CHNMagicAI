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
import subprocess
import sys
import time

import aiohttp

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TTS_SERVER = os.path.join(ROOT, "tts_service", "server.py")


def _abs_install_dir(tts_cfg):
    d = tts_cfg.get("install_dir") or "tts_engine"
    return d if os.path.isabs(d) else os.path.join(ROOT, d)


def _venv_python(install_dir):
    for c in (os.path.join(install_dir, "python", "Scripts", "python.exe"),
              os.path.join(install_dir, "python", "bin", "python3"),
              os.path.join(install_dir, "python", "bin", "python")):
        if os.path.isfile(c):
            return c
    return None


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
            self._spawn()
            c = self._cfg()
            deadline = time.time() + int(c.get("startup_timeout_seconds", 300))
            while time.time() < deadline:
                if self.proc and self.proc.poll() is not None:
                    raise RuntimeError("The voice engine failed to start (subprocess exited). See the console log.")
                health = await self._healthy()
                if health:
                    self._touch()
                    self._start_idle_watch()
                    return health
                await asyncio.sleep(1.5)
            raise RuntimeError("The voice engine did not become ready in time.")

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

    # ---- calls ----
    async def status(self):
        installed = self.is_installed()
        health = await self._healthy() if installed else None
        p = paths(self._cfg())
        return {
            "enabled": self._cfg().get("enabled", True),
            "installed": installed,
            "running": bool(health),
            "install_dir": p["install_dir"],
            "model_present": os.path.isdir(p["model_dir"]),
            "python_present": bool(p["python"]),
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
