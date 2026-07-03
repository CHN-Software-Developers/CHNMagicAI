"""Model manager: manifest reading, presence status, downloading, and locating existing files.

Models live under <models_dir>/<dest_subfolder>/<filename>. A user can instead point at an
already-downloaded file ("locate existing"); we hard-link (fallback copy) it into place so the
engine finds it without a re-download, and record the source in settings.model_overrides.
"""
import hashlib
import os
import shutil

import aiohttp

CONFIG_DIR = os.path.join(os.path.dirname(__file__), "..", "config")
MANIFEST_PATH = os.path.join(CONFIG_DIR, "models_manifest.json")

# ComfyUI's own models dir (engine/ComfyUI/models). A few nodes read a model straight from
# folder_paths.models_dir instead of an extra-model-paths category — e.g. cinematic_audio_
# separation loads BandIt Plus from <models_dir>/audio/bandit. Such manifest entries set
# "dest_root": "engine_models" so we place the file where the node actually looks.
ENGINE_MODELS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "engine", "ComfyUI", "models"))


def load_manifest():
    import json
    with open(os.path.abspath(MANIFEST_PATH), "r", encoding="utf-8") as f:
        return json.load(f).get("models", [])


def _dest_path(models_dir, model):
    base = ENGINE_MODELS_DIR if model.get("dest_root") == "engine_models" else models_dir
    return os.path.join(base, model["dest_subfolder"], model["filename"])


def model_status(models_dir, settings):
    """Return a list describing each manifest model and whether it is available."""
    overrides = settings.get("model_overrides", {})
    out = []
    for m in load_manifest():
        dest = _dest_path(models_dir, m)
        override = overrides.get(m["id"])
        present = os.path.isfile(dest)
        located = None
        if not present and override and os.path.isfile(override):
            present = True
            located = override
        size = os.path.getsize(dest) if os.path.isfile(dest) else (
            os.path.getsize(located) if located else 0)
        out.append({
            "id": m["id"],
            "name": m.get("name", m["id"]),
            "filename": m["filename"],
            "dest_subfolder": m["dest_subfolder"],
            "required": m.get("required", True),
            "url": m.get("url", ""),
            "note": m.get("note", ""),
            "present": present,
            "located_path": located,
            "size_on_disk": size,
        })
    return out


def all_required_present(models_dir, settings):
    return all(s["present"] for s in model_status(models_dir, settings) if s["required"])


def _sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


async def download_model(model, models_dir, progress_cb=None, hf_token=None):
    """Stream-download a single model, reporting progress via progress_cb(downloaded, total).

    Returns (ok: bool, message: str). Verifies sha256 if the manifest provides one.
    """
    url = model.get("url", "").strip()
    if not url:
        return False, "No URL set in manifest for this model. Edit config/models_manifest.json or use 'Locate existing'."

    dest = _dest_path(models_dir, model)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"

    headers = {}
    if hf_token and "huggingface.co" in url:
        headers["Authorization"] = f"Bearer {hf_token}"

    timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=120)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers, allow_redirects=True) as r:
                if r.status != 200:
                    return False, f"HTTP {r.status} downloading {url}"
                total = int(r.headers.get("Content-Length", 0))
                done = 0
                with open(tmp, "wb") as f:
                    async for chunk in r.content.iter_chunked(1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        if progress_cb:
                            progress_cb(done, total)
    except Exception as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        return False, f"Download failed: {e}"

    expected = (model.get("sha256") or "").strip().lower()
    if expected:
        if _sha256(tmp) != expected:
            os.remove(tmp)
            return False, "Checksum mismatch (sha256). File removed."

    os.replace(tmp, dest)
    return True, "Downloaded"


def locate_model(model, src_path, models_dir, settings):
    """Make an already-downloaded file available to the engine.

    Tries a hard link (instant, no extra disk), falls back to copy. Also records the source path
    in settings.model_overrides so the choice survives even if linking is not possible.
    Returns (ok, message). Caller is responsible for persisting `settings`.
    """
    if not os.path.isfile(src_path):
        return False, f"File not found: {src_path}"
    dest = _dest_path(models_dir, model)
    os.makedirs(os.path.dirname(dest), exist_ok=True)

    settings.setdefault("model_overrides", {})[model["id"]] = os.path.abspath(src_path)

    if os.path.abspath(src_path) == os.path.abspath(dest):
        return True, "Already in place"
    try:
        if os.path.exists(dest):
            os.remove(dest)
        os.link(src_path, dest)  # hard link (same volume only)
        return True, "Linked into models folder"
    except OSError:
        try:
            shutil.copy2(src_path, dest)
            return True, "Copied into models folder"
        except Exception as e:
            # Even if we can't place it, the override path lets the engine find it via yaml.
            return True, f"Registered path (could not link/copy: {e})"
