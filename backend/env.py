"""Environment-override layer.

A single place where `AIVB_*` environment variables override `config/settings.json`, so the desktop
(Electron) and RunPod container entrypoints agree on host/port/paths/mode without hardcoding anything.

Imported by `bootstrap.py`, `launcher.py`, and `app.py`; each calls `env.apply(settings)` right after
its own settings merge, so env vars win over both `settings.json` and `settings.local.json`.

Recognised variables:
    AIVB_ENV            "desktop" | "runpod"  (default "desktop"; repo-dev behaves like desktop)
    AIVB_APP_HOST       override settings.app_host      (RunPod: 0.0.0.0)
    AIVB_APP_PORT       override settings.app_port
    AIVB_COMFY_HOST     override settings.comfy_host
    AIVB_COMFY_PORT     override settings.comfy_port
    AIVB_OPEN_BROWSER   "0"/"1" -> override settings.open_browser (RunPod/desktop: 0)
    AIVB_DATA_DIR       writable base for models/output + the projects registry (RunPod: /workspace)
    AIVB_BASE_PYTHON    interpreter the engine venv is created from (the bundled desktop Python)
    AIVB_PROJECTS_ROOT  root the server-side folder browser is confined to (default <data>/projects)
"""
import os


def _get(name):
    return (os.environ.get(name) or "").strip()


def _bool(name):
    """Return True/False if the var is set to a recognisable value, else None (unset)."""
    v = _get(name).lower()
    if not v:
        return None
    return v in ("1", "true", "yes", "on")


def mode():
    """UI/runtime mode. Only 'runpod' changes behaviour; anything else is treated as desktop/repo."""
    m = _get("AIVB_ENV").lower()
    return "runpod" if m == "runpod" else "desktop"


def data_dir():
    """Writable base for relocatable trees, or '' when running repo-relative (the default)."""
    return _get("AIVB_DATA_DIR")


def base_python():
    """A base interpreter to create the engine venv from (bundled Python), or '' to use the default."""
    return _get("AIVB_BASE_PYTHON")


def projects_root():
    """Root directory the RunPod server-side folder browser may traverse."""
    root = _get("AIVB_PROJECTS_ROOT")
    if root:
        return os.path.abspath(root)
    dd = data_dir()
    base = dd if dd else os.path.expanduser("~")
    return os.path.abspath(os.path.join(base, "projects"))


def folder_browser():
    """'server' on RunPod (headless -> in-app browser), 'native' otherwise (same-machine OS dialog)."""
    return "server" if mode() == "runpod" else "native"


def allow_locate():
    """RunPod is download-only for models; desktop/repo keep the 'Locate existing file' option."""
    return mode() != "runpod"


def apply(settings):
    """Mutate `settings` in place with any AIVB_* overrides and return it."""
    host = _get("AIVB_APP_HOST")
    if host:
        settings["app_host"] = host
    port = _get("AIVB_APP_PORT")
    if port:
        settings["app_port"] = int(port)

    chost = _get("AIVB_COMFY_HOST")
    if chost:
        settings["comfy_host"] = chost
    cport = _get("AIVB_COMFY_PORT")
    if cport:
        settings["comfy_port"] = int(cport)

    ob = _bool("AIVB_OPEN_BROWSER")
    if ob is not None:
        settings["open_browser"] = ob

    # Relocate the writable trees onto an absolute base (e.g. RunPod's /workspace volume). Making
    # these absolute is transparent to callers that do os.path.join(ROOT, settings["models_dir"]) —
    # os.path.join discards ROOT when the second component is absolute.
    dd = data_dir()
    if dd:
        settings["models_dir"] = os.path.join(os.path.abspath(dd), "models")
        settings["output_dir"] = os.path.join(os.path.abspath(dd), "output")

    bp = base_python()
    if bp:
        settings.setdefault("setup", {})["base_python"] = bp

    return settings
