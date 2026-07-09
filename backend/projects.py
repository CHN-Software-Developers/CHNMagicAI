"""Project store for CHNMagicAI.

A "project" is a user-chosen folder on disk that collects the artifacts generated in it. A small
registry (in per-user app-data, NOT the repo) tracks every project so the landing screen can list
them across restarts. Each project folder is self-describing via a `project.json` manifest, so a
folder can be moved/copied and re-added later via `locate_project`.

Layout of a project folder (`path`):
    project.json                      manifest {id, name, created, media:[MediaItem]}
    media/<mediaId>/video.mp4         a generation's video
    media/<mediaId>/audio.mp3         its audio sidecar (SaveAudioAdvanced output)
    media/<mediaId>/last.png          last-frame still (captured client-side)
    media/<mediaId>/meta.json         prompt/settings/seed snapshot
    voices/<mediaId>.wav              a CosyVoice speech generated in the project

MediaItem = {
    id, type: "generation"|"voice", created,
    video:  "media/<id>/video.mp4"  | None,   # relative to the project folder
    audio:  "media/<id>/audio.mp3"  | None,
    lastFrame: "media/<id>/last.png" | None,
    meta: {...},
}

Persistence follows the codebase convention (plain JSON files, no DB). Everything reads the registry
/ manifest fresh from disk on each call, so there is no in-memory cache to go stale.
"""
import json
import os
import shutil
import time
import uuid
from datetime import datetime, timezone

import bootstrap

VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".gif")
AUDIO_EXTS = (".mp3", ".wav", ".flac", ".m4a", ".ogg")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id():
    return uuid.uuid4().hex[:12]


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def _safe_folder_name(name):
    keep = "-_() "
    cleaned = "".join(c for c in (name or "").strip() if c.isalnum() or c in keep).strip()
    return cleaned or "project"


def _within(base, target):
    """True if `target` resolves to a path inside `base` (path-traversal guard)."""
    try:
        base_r = os.path.realpath(base)
        target_r = os.path.realpath(target)
        return os.path.commonpath([base_r, target_r]) == base_r
    except (ValueError, OSError):
        return False


class ProjectStore:
    def __init__(self):
        self.registry_path = bootstrap.app_data_dir("projects.json")

    # ------------------------------- registry -------------------------------

    def _load_registry(self):
        data = _read_json(self.registry_path, [])
        return data if isinstance(data, list) else []

    def _save_registry(self, entries):
        _write_json(self.registry_path, entries)

    def _entry(self, project_id):
        for e in self._load_registry():
            if e.get("id") == project_id:
                return e
        return None

    def _manifest_path(self, path):
        return os.path.join(path, "project.json")

    def _load_manifest(self, entry):
        if not entry:
            return None
        m = _read_json(self._manifest_path(entry["path"]), None)
        if not isinstance(m, dict):
            return None
        m.setdefault("media", [])
        m.setdefault("characters", [])
        return m

    def _save_manifest(self, entry, manifest):
        _write_json(self._manifest_path(entry["path"]), manifest)

    # ------------------------------- CRUD -------------------------------

    def list_projects(self):
        """Registry entries newest-opened first, each annotated with liveness + a media count."""
        out = []
        for e in self._load_registry():
            path = e.get("path", "")
            exists = bool(path) and os.path.isfile(self._manifest_path(path))
            item = dict(e, exists=exists, media_count=0, thumbnail=None)
            if exists:
                m = _read_json(self._manifest_path(path), {})
                media = m.get("media") or []
                item["media_count"] = len(media)
                # newest generation with a last-frame still → registry-list thumbnail
                for mi in reversed(media):
                    if mi.get("lastFrame"):
                        item["thumbnail"] = {"project": e["id"], "media": mi["id"], "kind": "lastframe"}
                        break
            out.append(item)
        out.sort(key=lambda x: x.get("lastOpened") or x.get("created") or "", reverse=True)
        return out

    def create_project(self, name, location, as_root=False):
        """Create a project.

        With `as_root=True` the chosen `location` folder itself becomes the project folder
        (name defaults to that folder's basename) — this is what the native folder picker uses,
        so the user selects/creates exactly one folder and no extra subfolder is nested inside.
        Otherwise a subfolder named after `name` is created under `location` (legacy behaviour)."""
        location = (location or "").strip()
        if not location or not os.path.isdir(location):
            raise ValueError("Choose a valid folder for the project.")
        if as_root:
            folder = location
            if os.path.isfile(self._manifest_path(folder)):
                raise ValueError("That folder is already a CHNMagicAI project — use 'Open existing' instead.")
            name = (name or "").strip() or os.path.basename(os.path.normpath(folder)) or "Untitled project"
        else:
            name = (name or "").strip() or "Untitled project"
            folder = os.path.join(location, _safe_folder_name(name))
            if os.path.exists(folder):
                i = 1
                while os.path.exists(f"{folder}_{i}"):
                    i += 1
                folder = f"{folder}_{i}"
        os.makedirs(os.path.join(folder, "media"), exist_ok=True)
        os.makedirs(os.path.join(folder, "voices"), exist_ok=True)
        pid = _new_id()
        created = _now()
        manifest = {"id": pid, "name": name, "created": created, "media": []}
        _write_json(self._manifest_path(folder), manifest)
        entry = {"id": pid, "name": name, "path": folder, "created": created, "lastOpened": created}
        registry = self._load_registry()
        registry.append(entry)
        self._save_registry(registry)
        return dict(entry, exists=True, media_count=0, thumbnail=None)

    def locate_project(self, path):
        """Re-add an existing project folder (must contain a valid project.json)."""
        path = (path or "").strip()
        if not path or not os.path.isdir(path):
            raise ValueError("That folder does not exist.")
        manifest = _read_json(self._manifest_path(path), None)
        if not isinstance(manifest, dict) or not manifest.get("id"):
            raise ValueError("That folder is not a CHNMagicAI project (no project.json).")
        registry = self._load_registry()
        pid = manifest["id"]
        now = _now()
        for e in registry:
            if e.get("id") == pid or os.path.normcase(e.get("path", "")) == os.path.normcase(path):
                e.update({"id": pid, "name": manifest.get("name", e.get("name", "Project")),
                          "path": path, "lastOpened": now})
                self._save_registry(registry)
                return dict(e, exists=True)
        entry = {"id": pid, "name": manifest.get("name", "Project"), "path": path,
                 "created": manifest.get("created", now), "lastOpened": now}
        registry.append(entry)
        self._save_registry(registry)
        return dict(entry, exists=True)

    def get_project(self, project_id):
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        return dict(manifest, path=entry["path"])

    def touch_opened(self, project_id):
        registry = self._load_registry()
        for e in registry:
            if e.get("id") == project_id:
                e["lastOpened"] = _now()
                self._save_registry(registry)
                return True
        return False

    def rename_project(self, project_id, name):
        name = (name or "").strip()
        if not name:
            raise ValueError("Name required.")
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        manifest["name"] = name
        self._save_manifest(entry, manifest)
        registry = self._load_registry()
        for e in registry:
            if e.get("id") == project_id:
                e["name"] = name
        self._save_registry(registry)
        return dict(manifest, path=entry["path"])

    def delete_project(self, project_id, delete_files=False):
        registry = self._load_registry()
        entry = next((e for e in registry if e.get("id") == project_id), None)
        registry = [e for e in registry if e.get("id") != project_id]
        self._save_registry(registry)
        if delete_files and entry and os.path.isdir(entry.get("path", "")):
            shutil.rmtree(entry["path"], ignore_errors=True)
        return True

    # ------------------------------- media -------------------------------

    def add_generation(self, project_id, video_src, audio_src, meta=None, last_frame_src=None):
        """Copy a finished generation's outputs into the project and register a MediaItem.

        `last_frame_src` is the still written by the workflow's last-frame SaveImage node
        (ImageFromBatch → SaveImage). Captured server-side so it's the exact final frame of the
        saved video, not a best-effort client canvas grab."""
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        mid = _new_id()
        base = entry["path"]
        mdir = os.path.join(base, "media", mid)
        os.makedirs(mdir, exist_ok=True)
        item = {"id": mid, "type": "generation", "created": _now(),
                "video": None, "audio": None, "lastFrame": None, "meta": meta or {}}
        if video_src and os.path.isfile(video_src):
            ext = os.path.splitext(video_src)[1].lower() or ".mp4"
            shutil.copy2(video_src, os.path.join(mdir, f"video{ext}"))
            item["video"] = f"media/{mid}/video{ext}"
        if audio_src and os.path.isfile(audio_src):
            ext = os.path.splitext(audio_src)[1].lower() or ".mp3"
            shutil.copy2(audio_src, os.path.join(mdir, f"audio{ext}"))
            item["audio"] = f"media/{mid}/audio{ext}"
        if last_frame_src and os.path.isfile(last_frame_src):
            shutil.copy2(last_frame_src, os.path.join(mdir, "last.png"))
            item["lastFrame"] = f"media/{mid}/last.png"
        _write_json(os.path.join(mdir, "meta.json"), item["meta"])
        manifest["media"].append(item)
        self._save_manifest(entry, manifest)
        return item

    def add_voice(self, project_id, wav_src, meta=None):
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest or not (wav_src and os.path.isfile(wav_src)):
            return None
        mid = _new_id()
        base = entry["path"]
        ext = os.path.splitext(wav_src)[1].lower() or ".wav"
        vdir = os.path.join(base, "voices")
        os.makedirs(vdir, exist_ok=True)
        shutil.copy2(wav_src, os.path.join(vdir, f"{mid}{ext}"))
        item = {"id": mid, "type": "voice", "created": _now(),
                "video": None, "audio": f"voices/{mid}{ext}", "lastFrame": None, "meta": meta or {}}
        manifest["media"].append(item)
        self._save_manifest(entry, manifest)
        return item

    def set_last_frame(self, project_id, media_id, png_bytes):
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        item = next((m for m in manifest["media"] if m.get("id") == media_id), None)
        if not item:
            return None
        mdir = os.path.join(entry["path"], "media", media_id)
        os.makedirs(mdir, exist_ok=True)
        with open(os.path.join(mdir, "last.png"), "wb") as f:
            f.write(png_bytes)
        item["lastFrame"] = f"media/{media_id}/last.png"
        self._save_manifest(entry, manifest)
        return item

    def delete_media(self, project_id, media_id):
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return False
        item = next((m for m in manifest["media"] if m.get("id") == media_id), None)
        if not item:
            return False
        base = entry["path"]
        mdir = os.path.join(base, "media", media_id)
        if os.path.isdir(mdir) and _within(base, mdir):
            shutil.rmtree(mdir, ignore_errors=True)
        # voice files live under voices/<id>.ext
        for rel in (item.get("audio"), item.get("video"), item.get("lastFrame")):
            if rel and rel.startswith("voices/"):
                p = os.path.join(base, rel)
                if os.path.isfile(p) and _within(base, p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
        manifest["media"] = [m for m in manifest["media"] if m.get("id") != media_id]
        self._save_manifest(entry, manifest)
        return True

    def media_file_path(self, project_id, media_id, kind):
        """Absolute path of a media file (kind: video|audio|lastframe), guarded to the project dir."""
        field = {"video": "video", "audio": "audio", "lastframe": "lastFrame"}.get(kind)
        if not field:
            return None
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        item = next((m for m in manifest["media"] if m.get("id") == media_id), None)
        if not item or not item.get(field):
            return None
        p = os.path.join(entry["path"], item[field])
        if not (_within(entry["path"], p) and os.path.isfile(p)):
            return None
        return p

    # ------------------------------- characters -------------------------------

    def _get_char(self, manifest, character_id):
        return next((c for c in manifest.get("characters", []) if c.get("id") == character_id), None)

    def list_characters(self, project_id):
        manifest = self._load_manifest(self._entry(project_id))
        return manifest.get("characters", []) if manifest else []

    def get_character(self, project_id, character_id):
        manifest = self._load_manifest(self._entry(project_id))
        return self._get_char(manifest, character_id) if manifest else None

    def create_character(self, project_id, name, description, moods_spec, meta=None):
        """Register a character in the 'generating' state; the mood video renders afterwards and
        `finalize_character` fills in the video + per-mood reference clips."""
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        cid = _new_id()
        os.makedirs(os.path.join(entry["path"], "characters", cid, "moods"), exist_ok=True)
        char = {
            "id": cid,
            "name": (name or "").strip() or "Character",
            "description": (description or "").strip(),
            "created": _now(),
            "status": "generating",
            "avatar": None,
            "video": None,
            "moods": [{"key": m.get("key"), "label": m.get("label", m.get("key", "")),
                       "tone": m.get("tone", ""), "clip": None, "refText": "",
                       "start": m.get("start", 0), "length": m.get("length", 0)}
                      for m in moods_spec],
            "meta": meta or {},
        }
        manifest["characters"].append(char)
        self._save_manifest(entry, manifest)
        return char

    def finalize_character(self, project_id, character_id, video_src, mood_clips):
        """Copy the rendered video and per-mood clips into the character folder and mark it ready.

        `mood_clips` = [{key, src, refText}]. Missing sources are tolerated (mood stays clip=None)."""
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        char = self._get_char(manifest, character_id)
        if not char:
            return None
        base = entry["path"]
        cdir = os.path.join(base, "characters", character_id)
        os.makedirs(os.path.join(cdir, "moods"), exist_ok=True)
        if video_src and os.path.isfile(video_src):
            ext = os.path.splitext(video_src)[1].lower() or ".mp4"
            shutil.copy2(video_src, os.path.join(cdir, f"video{ext}"))
            char["video"] = f"characters/{character_id}/video{ext}"
        by_key = {c.get("key"): c for c in (mood_clips or [])}
        for mood in char["moods"]:
            clip = by_key.get(mood["key"])
            if not clip:
                continue
            src = clip.get("src")
            if src and os.path.isfile(src):
                ext = os.path.splitext(src)[1].lower() or ".flac"
                dst = os.path.join(cdir, "moods", f"{mood['key']}{ext}")
                shutil.copy2(src, dst)
                mood["clip"] = f"characters/{character_id}/moods/{mood['key']}{ext}"
            # The transcript anchors zero-shot cloning; fall back to the known line we asked the
            # character to speak so every mood has a usable ref_text even if Whisper transcription
            # came back empty (otherwise only some moods would auto-fill).
            mood["refText"] = clip.get("refText") or char.get("meta", {}).get("line", "")
        char["status"] = "ready"
        self._save_manifest(entry, manifest)
        return char

    def set_character_error(self, project_id, character_id):
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        char = self._get_char(manifest, character_id)
        if not char:
            return None
        char["status"] = "error"
        self._save_manifest(entry, manifest)
        return char

    def delete_character(self, project_id, character_id):
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return False
        if not self._get_char(manifest, character_id):
            return False
        base = entry["path"]
        cdir = os.path.join(base, "characters", character_id)
        if os.path.isdir(cdir) and _within(base, cdir):
            shutil.rmtree(cdir, ignore_errors=True)
        manifest["characters"] = [c for c in manifest["characters"] if c.get("id") != character_id]
        self._save_manifest(entry, manifest)
        return True

    def character_file_path(self, project_id, character_id, kind):
        """Absolute path of a character file, guarded to the project dir.

        kind: 'video', 'avatar', or 'mood-<key>' (e.g. 'mood-happy')."""
        entry = self._entry(project_id)
        manifest = self._load_manifest(entry)
        if not manifest:
            return None
        char = self._get_char(manifest, character_id)
        if not char:
            return None
        rel = None
        if kind in ("video", "avatar"):
            rel = char.get(kind)
        elif kind.startswith("mood-"):
            key = kind[len("mood-"):]
            mood = next((m for m in char.get("moods", []) if m.get("key") == key), None)
            rel = mood.get("clip") if mood else None
        if not rel:
            return None
        p = os.path.join(entry["path"], rel)
        if not (_within(entry["path"], p) and os.path.isfile(p)):
            return None
        return p
