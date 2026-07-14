#!/usr/bin/env bash
# Container entrypoint: prepare the persistent volume, then launch the app headless.
set -e

# /workspace is the RunPod persistent volume; make sure the app's data dirs exist on it.
mkdir -p /workspace/models /workspace/output /workspace/projects

echo "[start] CHNMagicAI (RunPod) — app will listen on 0.0.0.0:${AIVB_APP_PORT:-8188}"
echo "[start] models/output/projects persist under /workspace"

# launcher.py boots the hidden ComfyUI engine, waits for it, then serves the FastAPI app.
exec python3 /app/backend/launcher.py
