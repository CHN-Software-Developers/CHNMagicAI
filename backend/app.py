"""FastAPI orchestrator: serves the SPA, exposes REST + a WebSocket progress relay, and drives
the hidden ComfyUI engine. The browser only ever talks to this app (same origin); this app proxies
to ComfyUI.
"""
import asyncio
import json
import os

import aiohttp
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles

import bootstrap
import comfy_client
import models as model_mgr
import tts as tts_mod
import workflow as wf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONFIG_PATH = os.path.join(ROOT, "config", "settings.json")
LOCAL_CONFIG_PATH = os.path.join(ROOT, "config", "settings.local.json")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".gif")

# ComfyUI node id -> friendly stage label for the progress bar
STAGE_LABELS = {
    "35": "Stage 0: Loading models", "12": "Stage 0: Loading models", "6": "Stage 0: Loading models",
    "8": "Stage 0: Loading models", "36": "Stage 0: Loading models", "13": "Stage 0: Loading models", "10": "Stage 0: Loading models",
    "131": "Stage 0: Preparing timeline",
    "133": "Stage 0: Encoding guides", "132": "Stage 0: Encoding guides",
    "31": "Stage 1: Crafting", "19": "Stage 2: Upscaling", "14": "Stage 2: Upscaling latents",
    "24": "Decoding audio", "1": "Decoding video",
    "2": "Encoding video", "158": "Encoding video", "37": "Saving video",
    "156": "Post-processing audio", "157": "Post-processing audio",
}


def _deep_merge(base, override):
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def load_settings():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        settings = json.load(f)
    # Per-machine overrides (git-ignored): model paths, python_exe, etc.
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH, "r", encoding="utf-8") as f:
            _deep_merge(settings, json.load(f))
    return settings


# Keys that are per-machine and must never be written back to the committed settings.json.
LOCAL_KEYS = ("model_overrides", "python_exe")


def save_local(settings):
    """Persist only the per-machine keys into the git-ignored settings.local.json."""
    local = {}
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH, "r", encoding="utf-8") as f:
            local = json.load(f)
    for k in LOCAL_KEYS:
        if k in settings:
            local[k] = settings[k]
    with open(LOCAL_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(local, f, indent=2)


def save_local_tts_dir(path):
    """Persist only the per-machine voice-engine install location into settings.local.json."""
    local = {}
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with open(LOCAL_CONFIG_PATH, "r", encoding="utf-8") as f:
            local = json.load(f)
    local.setdefault("tts", {})["install_dir"] = path
    with open(LOCAL_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(local, f, indent=2)


def _engine_input_path(rel_or_abs):
    """Resolve a timeline media reference (e.g. 'whatdreamscost/clip.wav') to an absolute path in
    the engine input dir. Absolute paths are returned as-is."""
    if not rel_or_abs:
        return None
    if os.path.isabs(rel_or_abs):
        return rel_or_abs
    return os.path.join(ROOT, settings["engine_dir"], "input", rel_or_abs)


class Hub:
    """Fan-out of JSON messages to all connected frontend websockets."""
    def __init__(self):
        self.clients = set()

    async def register(self, ws):
        self.clients.add(ws)

    def unregister(self, ws):
        self.clients.discard(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unregister(ws)


app = FastAPI(title="AIVideoBuilder")
hub = Hub()
settings = load_settings()
comfy = comfy_client.ComfyClient(settings["comfy_host"], settings["comfy_port"])
tts_svc = tts_mod.TtsService(settings)
_tts_setup = {"running": False}
# Tracks the in-flight prompt. `errored` is set when ComfyUI reports an execution_error for it,
# so the trailing `executing {node: null}` (which ComfyUI sends even after a failure) is not
# mistaken for a successful completion.
_current = {"prompt_id": None, "errored": False}


@app.on_event("startup")
async def _startup():
    # Relay ComfyUI websocket -> our hub, transforming into UI-friendly messages.
    queue: asyncio.Queue = asyncio.Queue()
    asyncio.create_task(_listen_comfy(queue))
    asyncio.create_task(_consume(queue))


async def _listen_comfy(queue):
    while True:
        try:
            await comfy.listen(queue)
        except Exception:
            await asyncio.sleep(2)  # reconnect


async def _consume(queue):
    import base64
    while True:
        item = await queue.get()
        if item["kind"] == "preview":
            b64 = base64.b64encode(item["data"]).decode("ascii")
            await hub.broadcast({"type": "preview", "image": f"data:image/jpeg;base64,{b64}"})
            continue

        msg = item["data"]
        mtype = msg.get("type")
        data = msg.get("data", {})
        if mtype == "kj_preview_override":
            # ModelPreviewOverrideKJ streams its live per-step preview as a custom JSON message
            # (NOT the binary event-1 preview): a base64 frame + its mime (image/jpeg, image/webp,
            # or video/mp4 for the animated multi-frame preview). Relay it to the UI as a data URL.
            img = data.get("image")
            if img:
                mime = data.get("mime") or "image/jpeg"
                await hub.broadcast({"type": "preview", "mime": mime,
                                     "image": f"data:{mime};base64,{img}"})
        elif mtype == "progress":
            await hub.broadcast({"type": "progress", "value": data.get("value"),
                                 "max": data.get("max")})
        elif mtype == "executing":
            node = data.get("node")
            if node is None and data.get("prompt_id") == _current["prompt_id"]:
                # ComfyUI sends this end-of-run marker even after a failure. Only treat it as a
                # real completion if no execution_error was reported for this prompt.
                if _current["errored"]:
                    _current["errored"] = False
                else:
                    await _on_complete(data.get("prompt_id"))
            else:
                await hub.broadcast({"type": "stage", "node": node,
                                     "label": STAGE_LABELS.get(str(node), "Working")})
        elif mtype in ("execution_error",):
            if data.get("prompt_id") == _current["prompt_id"]:
                _current["errored"] = True
            await hub.broadcast({"type": "error",
                                 "message": _format_error(data)})
            await _free_models()
        elif mtype in ("execution_interrupted",):
            if data.get("prompt_id") == _current["prompt_id"]:
                _current["errored"] = True
            await hub.broadcast({"type": "error", "message": "Generation was interrupted."})
            await _free_models()
        elif mtype in ("status",):
            await hub.broadcast({"type": "status", "data": data})


def _format_error(data):
    """Turn a ComfyUI execution_error payload into a user-actionable message."""
    node_type = data.get("node_type", "")
    raw = str(data.get("exception_message", "") or "Execution error")
    low = raw.lower()
    if "no kernel image is available" in low or ("sm_" in low and "not compatible" in low):
        hint = ("Your GPU isn't supported by the installed PyTorch build. "
                "Install a PyTorch build matching your GPU (e.g. CUDA 12.8 for RTX 50-series) "
                "and restart. See SETUP.md → GPU compatibility.")
        return f"{hint}\n\n(node {node_type}: {raw.splitlines()[0]})"
    if "out of memory" in low or "alloc" in low and "cuda" in low:
        return (f"Ran out of GPU memory in {node_type}. Try a lower resolution or shorter "
                f"duration.\n\n{raw.splitlines()[0]}")
    head = raw.strip().splitlines()[0] if raw.strip() else "Execution error"
    return f"{node_type}: {head}" if node_type else head


async def _free_models():
    """Release model weights from VRAM/RAM after a run ends (any outcome).

    Left resident, the ~20GB fp8 model pins VRAM + RAM permanently, which is
    unusable on low-end PCs. Fire-and-forget: never let a failure here block the
    completion/error the user is waiting on.
    """
    try:
        async with aiohttp.ClientSession() as session:
            await comfy.free(session)
    except Exception:
        pass


async def _on_complete(prompt_id):
    async with aiohttp.ClientSession() as session:
        history = await comfy.get_history(session, prompt_id)
    video = _find_video_output(history) if history else None
    if video:
        q = f"filename={video['filename']}&subfolder={video.get('subfolder','')}&type={video.get('type','output')}"
        await hub.broadcast({"type": "complete", "prompt_id": prompt_id, "video_url": f"/api/media?{q}"})
    else:
        await hub.broadcast({"type": "complete", "prompt_id": prompt_id, "video_url": None})
    await _free_models()


def _find_video_output(history):
    for _node_id, out in (history.get("outputs") or {}).items():
        for _key, val in out.items():
            if isinstance(val, list):
                for entry in val:
                    if isinstance(entry, dict) and str(entry.get("filename", "")).lower().endswith(VIDEO_EXTS):
                        return entry
    return None


# ------------------------------- REST -------------------------------

@app.get("/api/config")
async def api_config():
    return {
        "resolution_presets": settings.get("resolution_presets", {}),
        "defaults": settings.get("defaults", {}),
        "models": model_mgr.model_status(os.path.join(ROOT, settings["models_dir"]), settings),
        "all_required_present": model_mgr.all_required_present(
            os.path.join(ROOT, settings["models_dir"]), settings),
    }


@app.get("/api/models")
async def api_models():
    return model_mgr.model_status(os.path.join(ROOT, settings["models_dir"]), settings)


@app.post("/api/models/download")
async def api_download(req: Request):
    body = await req.json()
    model = next((m for m in model_mgr.load_manifest() if m["id"] == body.get("id")), None)
    if not model:
        return JSONResponse({"error": "unknown model id"}, status_code=404)
    models_dir = os.path.join(ROOT, settings["models_dir"])
    loop = asyncio.get_event_loop()

    state = {"last_pct": -1}

    def cb(done, total):
        pct = int(done * 100 / total) if total else 0
        if pct != state["last_pct"]:
            state["last_pct"] = pct
            loop.call_soon_threadsafe(asyncio.ensure_future, hub.broadcast(
                {"type": "download", "id": model["id"], "downloaded": done, "total": total, "pct": pct}))

    async def run():
        await hub.broadcast({"type": "download", "id": model["id"], "pct": 0, "status": "start"})
        ok, message = await model_mgr.download_model(
            model, models_dir, progress_cb=cb, hf_token=os.environ.get("HF_TOKEN"))
        await hub.broadcast({"type": "download", "id": model["id"], "pct": 100 if ok else state["last_pct"],
                             "status": "done" if ok else "error", "message": message})

    asyncio.create_task(run())
    return {"started": True}


@app.post("/api/models/locate")
async def api_locate(req: Request):
    body = await req.json()
    model = next((m for m in model_mgr.load_manifest() if m["id"] == body.get("id")), None)
    if not model:
        return JSONResponse({"error": "unknown model id"}, status_code=404)
    ok, message = model_mgr.locate_model(
        model, body.get("path", ""), os.path.join(ROOT, settings["models_dir"]), settings)
    if ok:
        save_local(settings)
    return {"ok": ok, "message": message}


@app.post("/api/upload-image")
async def api_upload_image(file: UploadFile = File(...)):
    data = await file.read()
    async with aiohttp.ClientSession() as session:
        res = await comfy.upload_image(session, data, file.filename)
    name, sub = res["name"], res.get("subfolder", "whatdreamscost")
    return {
        "filename": name, "subfolder": sub,
        "imageFile": f"{sub}/{name}" if sub else name,
        "imageB64": f"/api/media?filename={name}&subfolder={sub}&type=input",
    }


# Audio/video for the timeline (LTX Director reads audioFile/videoFile from the engine input dir).
# ComfyUI's /upload/image path is image-only, so we write media straight into the engine input
# folder the node scans (input/whatdreamscost/) and hand back the relative path + a playback URL.
_MEDIA_SUBFOLDER = "whatdreamscost"


def _safe_name(name: str) -> str:
    keep = "-_.() "
    base = os.path.basename(name or "clip")
    cleaned = "".join(c for c in base if c.isalnum() or c in keep).strip() or "clip"
    return cleaned


@app.post("/api/upload-media")
async def api_upload_media(file: UploadFile = File(...)):
    data = await file.read()
    input_dir = os.path.join(ROOT, settings["engine_dir"], "input", _MEDIA_SUBFOLDER)
    os.makedirs(input_dir, exist_ok=True)
    name = _safe_name(file.filename)
    dest = os.path.join(input_dir, name)
    # de-dupe: append a counter if a different file already claims this name
    if os.path.isfile(dest):
        stem, ext = os.path.splitext(name)
        i = 1
        while os.path.isfile(os.path.join(input_dir, f"{stem}_{i}{ext}")):
            i += 1
        name = f"{stem}_{i}{ext}"
        dest = os.path.join(input_dir, name)
    with open(dest, "wb") as f:
        f.write(data)
    kind = "video" if (file.content_type or "").startswith("video") or \
        name.lower().endswith((".mp4", ".webm", ".mov", ".mkv")) else "audio"
    return {
        "file": f"{_MEDIA_SUBFOLDER}/{name}",
        "name": name,
        "kind": kind,
        "url": f"/api/media?filename={name}&subfolder={_MEDIA_SUBFOLDER}&type=input",
    }


@app.post("/api/generate")
async def api_generate(req: Request):
    params = await req.json()
    if not model_mgr.all_required_present(os.path.join(ROOT, settings["models_dir"]), settings):
        return JSONResponse({"error": "Some required models are missing. Open the Models panel."},
                            status_code=400)
    prompt, seed = wf.build_prompt(params, settings)
    async with aiohttp.ClientSession() as session:
        prompt_id = await comfy.queue_prompt(session, prompt)
    _current["prompt_id"] = prompt_id
    _current["errored"] = False
    await hub.broadcast({"type": "queued", "prompt_id": prompt_id, "seed": seed})
    return {"prompt_id": prompt_id, "seed": seed}


@app.post("/api/interrupt")
async def api_interrupt():
    async with aiohttp.ClientSession() as session:
        ok = await comfy.interrupt(session)
    return {"ok": ok}


@app.get("/api/media")
async def api_media(filename: str, subfolder: str = "", type: str = "output"):
    async with aiohttp.ClientSession() as session:
        data, ctype = await comfy.fetch_view(session, filename, subfolder, type)
    return Response(content=data, media_type=ctype)


# ------------------------------- voice / TTS -------------------------------

@app.get("/api/tts/status")
async def api_tts_status():
    status = await tts_svc.status()
    status["setup_running"] = _tts_setup["running"]
    status["languages"] = settings.get("tts", {}).get("languages", [])
    return status


@app.post("/api/tts/set-install-dir")
async def api_tts_set_dir(req: Request):
    body = await req.json()
    path = (body.get("path") or "").strip()
    if not path:
        return JSONResponse({"ok": False, "error": "path required"}, status_code=400)
    settings.setdefault("tts", {})["install_dir"] = path
    save_local_tts_dir(path)
    return {"ok": True, "install_dir": os.path.abspath(path)}


@app.post("/api/tts/setup")
async def api_tts_setup(req: Request):
    body = await req.json()
    install_dir = (body.get("install_dir") or settings.get("tts", {}).get("install_dir") or "").strip()
    if install_dir:
        settings.setdefault("tts", {})["install_dir"] = install_dir
        save_local_tts_dir(install_dir)
    if _tts_setup["running"]:
        return {"started": False, "message": "Voice engine setup is already running."}
    loop = asyncio.get_event_loop()

    def cb(d):
        loop.call_soon_threadsafe(asyncio.ensure_future,
                                  hub.broadcast({"type": "tts_setup", **d}))

    async def run():
        _tts_setup["running"] = True
        await hub.broadcast({"type": "tts_setup", "stage": "start", "message": "Starting voice engine setup…"})
        try:
            ok, message = await loop.run_in_executor(
                None, lambda: bootstrap.setup_tts(install_dir or None, cb))
        except Exception as e:  # never let setup crash the app
            ok, message = False, f"{type(e).__name__}: {e}"
        _tts_setup["running"] = False
        await hub.broadcast({"type": "tts_setup", "stage": "done" if ok else "error",
                             "message": message, "ok": ok})

    asyncio.create_task(run())
    return {"started": True}


@app.post("/api/tts/transcribe")
async def api_tts_transcribe(req: Request):
    body = await req.json()
    audio = _engine_input_path(body.get("file"))
    if not audio or not os.path.isfile(audio):
        return JSONResponse({"ok": False, "error": "reference clip not found"}, status_code=400)
    try:
        data, status = await tts_svc.transcribe({"audio": audio, "language": body.get("language")})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    return JSONResponse(data, status_code=status)


@app.post("/api/tts/synthesize")
async def api_tts_synthesize(req: Request):
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "Enter the dialog to speak."}, status_code=400)

    input_dir = os.path.join(ROOT, settings["engine_dir"], "input", _MEDIA_SUBFOLDER)
    os.makedirs(input_dir, exist_ok=True)
    import time as _time
    name = f"speech_{int(_time.time() * 1000)}.wav"
    out_path = os.path.join(input_dir, name)

    payload = {
        "text": text,
        "out_path": out_path,
        "mode": body.get("mode", "clone"),
        "instruct": body.get("instruct"),
        "ref_text": body.get("ref_text"),
        "spk": body.get("spk"),
        "speed": body.get("speed", 1.0),
    }
    ref = _engine_input_path(body.get("ref_file"))
    if ref:
        payload["ref_audio"] = ref

    try:
        data, status = await tts_svc.synthesize(payload)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    if status == 200 and data.get("ok"):
        return {
            "ok": True,
            "file": f"{_MEDIA_SUBFOLDER}/{name}",
            "name": name,
            "kind": "audio",
            "url": f"/api/media?filename={name}&subfolder={_MEDIA_SUBFOLDER}&type=input",
            "duration": data.get("duration"),
        }
    return JSONResponse({"ok": False, "error": data.get("error", "Speech generation failed.")},
                        status_code=status if status != 200 else 500)


@app.on_event("shutdown")
async def _shutdown_tts():
    try:
        tts_svc.stop()
    except Exception:
        pass


# ------------------------------- websocket -------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    await hub.register(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive; ignore content
    except WebSocketDisconnect:
        hub.unregister(ws)


# ------------------------------- static SPA -------------------------------

@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
