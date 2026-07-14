# CHNMagicAI — RunPod / container image.
#
# Runs the exact same FastAPI app + SPA as the desktop build, headless, bound to 0.0.0.0 so RunPod's
# HTTP proxy can reach it. Model weights are NOT baked — they are downloaded manually from the in-app
# Models popup onto the /workspace persistent volume (so they survive pod restarts).
#
# Build:  docker build -f docker/Dockerfile -t <registry>/chnmagicai:latest .
# See docker/README-runpod.md for the full build + RunPod template steps.

FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1

# Ubuntu 22.04 ships Python 3.10 (the version CHNMagicAI's engine needs). Plus git + media libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3.10-venv python3-pip git ca-certificates \
      ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# Bake the engine venv + all Python deps at BUILD time so pod boot is fast. Models are not fetched
# here. The GPU self-check just warns during build (no GPU visible) — that's expected.
RUN python3 backend/bootstrap.py || true \
    && chmod +x docker/start.sh

# RunPod runtime config. /workspace is the persistent volume: models/output/projects live there.
ENV AIVB_ENV=runpod \
    AIVB_APP_HOST=0.0.0.0 \
    AIVB_APP_PORT=8188 \
    AIVB_COMFY_HOST=127.0.0.1 \
    AIVB_COMFY_PORT=8199 \
    AIVB_OPEN_BROWSER=0 \
    AIVB_DATA_DIR=/workspace \
    AIVB_PROJECTS_ROOT=/workspace/projects

EXPOSE 8188

CMD ["/app/docker/start.sh"]
