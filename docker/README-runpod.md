# CHNMagicAI on RunPod

Run CHNMagicAI as a RunPod GPU pod. The end user picks the custom template + a GPU, sets disk sizes,
clicks **Deploy**, and opens the app from the URL RunPod shows in the dashboard. No scripts, no
terminal. Model weights are downloaded manually from the in-app **Models** popup onto the persistent
`/workspace` volume.

The container runs the same FastAPI app + SPA as the desktop build, just headless and bound to
`0.0.0.0:8188` so RunPod's HTTP proxy can reach it (`AIVB_ENV=runpod`, set in the image).

---

## 1. Build & push the image (you, once)

Build from the **repo root** (the build context), pointing at this Dockerfile:

```bash
docker build -f docker/Dockerfile -t <your-registry>/chnmagicai:latest .
docker push <your-registry>/chnmagicai:latest
```

The build bakes the engine venv + all Python deps (~several GB) so pods boot fast. It does **not**
bake model weights. The GPU self-check prints a warning during build (no GPU in the builder) — that is
expected and harmless.

> CUDA: the image is `nvidia/cuda:12.8.0` + the app's `cu128` PyTorch, matching RTX 40/50-series.
> To target other GPUs, change `setup.torch_index_url` in `config/settings.json` before building.

### Optional: test locally before pushing

```bash
docker run --rm --gpus all -p 8188:8188 -v "$PWD/ws:/workspace" <your-registry>/chnmagicai:latest
# open http://localhost:8188 — the Models popup appears; download a model; generate.
# restart the container: models/projects persist from ./ws (the volume).
```

---

## 2. Create the RunPod template (you, once)

RunPod → **Templates** → **New Template**:

- **Container Image:** `<your-registry>/chnmagicai:latest`
- **Container Disk:** ~15–20 GB (image + engine venv live here).
- **Volume Disk:** size for your models + outputs (LTX-2.3 weights are large — 60–120 GB is a sensible
  starting range). **Volume Mount Path:** `/workspace`.
- **Expose HTTP Ports:** `8188`  ← this is what makes RunPod show the proxied URL.
- **Start Command:** leave empty (the image's `CMD` already launches the app).
- Docker/registry credentials if the image is private.

Save and (optionally) make the template public/shareable.

---

## 3. End-user steps (per pod)

1. Pick the **CHNMagicAI** template and a **GPU** pod.
2. Adjust **container/volume disk** sizes if needed, then **Deploy**.
3. When the pod is running, open the **`8188` HTTP** service link from the pod's **Connect** panel /
   dashboard (`https://<podid>-8188.proxy.runpod.net`).
4. The **Models** popup opens automatically because required models are missing. Click **Download** for
   each required model (download-only on RunPod; no "Locate"). Progress shows per model.
5. Once models are ready, create a project and generate. Projects, models, and outputs are stored on
   `/workspace`, so **stopping/restarting** the pod keeps them; only destroying the volume wipes them.

### Files, uploads & downloads

- **Project folders** live inside the pod under `/workspace/projects` — the "choose a folder" dialog is
  an in-app browser confined to that volume (it never touches your local machine's filesystem).
- **Uploading reference images/audio/video** and **downloading generated videos** use your **browser's**
  native file dialog (a normal multipart upload / download), so those interact with **your local
  computer** — exactly like using ComfyUI through Chrome on RunPod.

---

## Environment (baked into the image; override at deploy if needed)

| Var | Value | Purpose |
|-----|-------|---------|
| `AIVB_ENV` | `runpod` | download-only models, server-side folder browser |
| `AIVB_APP_HOST` / `AIVB_APP_PORT` | `0.0.0.0` / `8188` | proxied web server |
| `AIVB_COMFY_HOST` / `AIVB_COMFY_PORT` | `127.0.0.1` / `8199` | hidden engine (internal only) |
| `AIVB_DATA_DIR` | `/workspace` | models/output/projects on the persistent volume |
| `AIVB_PROJECTS_ROOT` | `/workspace/projects` | root the folder browser may traverse |
| `AIVB_OPEN_BROWSER` | `0` | headless — no system-browser auto-open |
