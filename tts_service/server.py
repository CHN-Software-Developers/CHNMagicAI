"""AIVideoBuilder voice/TTS service (part of AIVideoBuilder, GPL-3.0).

A thin HTTP wrapper that runs INSIDE the isolated TTS environment and drives the *pristine*,
unmodified CosyVoice 3 package (Apache-2.0) plus faster-whisper (MIT). The main FastAPI
orchestrator talks to this service over 127.0.0.1 and never imports CosyVoice itself, so
CosyVoice's heavy / version-pinned dependency stack stays isolated from the ComfyUI/LTX engine.

This file is our own code and does not modify any vendored CosyVoice source.

Run (under the isolated env's Python):
    python server.py --host 127.0.0.1 --port 50000 \
        --cosyvoice-dir <install>/CosyVoice \
        --model-dir <install>/models/Fun-CosyVoice3-0.5B \
        --whisper-model base

Endpoints (all localhost, JSON in/out; audio is exchanged as file paths on the shared disk):
    GET  /health       -> readiness + capabilities (available preset speakers, sample rate)
    POST /synthesize    -> generate speech to a WAV path
    POST /transcribe    -> transcribe a reference clip to text (for zero-shot cloning)
"""
import argparse
import os
import sys
import threading
import traceback

from fastapi import FastAPI
from fastapi.responses import JSONResponse
import uvicorn

# Populated in main() from CLI args.
CFG = {
    "cosyvoice_dir": "",
    "model_dir": "",
    "whisper_model": "base",
    "device": "cuda",
}

# Lazily-loaded heavy objects. Guarded by a lock so concurrent requests don't double-load.
_state = {"cosy": None, "whisper": None, "spks": [], "sr": 24000}
_load_lock = threading.Lock()

app = FastAPI(title="AIVideoBuilder TTS")


def _prepare_cosyvoice_import():
    """Put the vendored CosyVoice package (and its Matcha-TTS third_party) on sys.path."""
    d = CFG["cosyvoice_dir"]
    if d and d not in sys.path:
        sys.path.insert(0, d)
    matcha = os.path.join(d, "third_party", "Matcha-TTS")
    if os.path.isdir(matcha) and matcha not in sys.path:
        sys.path.insert(0, matcha)


def _load_cosyvoice():
    if _state["cosy"] is not None:
        return _state["cosy"]
    with _load_lock:
        if _state["cosy"] is not None:
            return _state["cosy"]
        _prepare_cosyvoice_import()
        # CosyVoice 3 exposes an AutoModel facade that picks the right model class from model_dir.
        from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402  (path set up above)
        # fp16 halves VRAM but not every model class accepts the kwarg; fall back cleanly.
        try:
            cosy = AutoModel(model_dir=CFG["model_dir"], fp16=True)
        except TypeError:
            cosy = AutoModel(model_dir=CFG["model_dir"])
        _state["cosy"] = cosy
        _state["sr"] = int(getattr(cosy, "sample_rate", 24000))
        try:
            _state["spks"] = list(cosy.list_available_spks() or [])
        except Exception:
            _state["spks"] = []
        return cosy


def _load_whisper():
    if _state["whisper"] is not None:
        return _state["whisper"]
    with _load_lock:
        if _state["whisper"] is not None:
            return _state["whisper"]
        from faster_whisper import WhisperModel  # noqa: E402
        # faster-whisper uses CTranslate2 (its own CUDA/cuDNN path). On Windows the GPU build often
        # isn't available; fall back to CPU int8 so transcription still works.
        try:
            if CFG["device"] == "cuda":
                _state["whisper"] = WhisperModel(CFG["whisper_model"], device="cuda", compute_type="float16")
                return _state["whisper"]
        except Exception as e:
            print(f"[tts] Whisper CUDA unavailable ({e}); using CPU.", flush=True)
        _state["whisper"] = WhisperModel(CFG["whisper_model"], device="cpu", compute_type="int8")
        return _state["whisper"]


def _load_prompt_speech(path):
    """Load a reference clip as the 16 kHz tensor CosyVoice expects for cloning."""
    _prepare_cosyvoice_import()
    from cosyvoice.utils.file_utils import load_wav  # noqa: E402
    return load_wav(path, 16000)


def _collect(generator):
    """Concatenate the streamed 'tts_speech' chunks CosyVoice yields into one waveform."""
    import torch
    chunks = [out["tts_speech"] for out in generator]
    if not chunks:
        raise RuntimeError("CosyVoice produced no audio.")
    return torch.cat(chunks, dim=1)


@app.get("/health")
def health():
    # Report readiness without forcing a model load (keeps startup/health-check cheap).
    return {
        "ok": True,
        "model_loaded": _state["cosy"] is not None,
        "sample_rate": _state["sr"],
        "available_spks": _state["spks"],
        "model_dir": CFG["model_dir"],
    }


@app.post("/synthesize")
async def synthesize(req: dict):
    """Generate speech to `out_path` (a WAV on the shared disk).

    Body:
        text       (str, required)  the dialog to speak
        out_path   (str, required)  absolute path to write the WAV to
        mode       'clone' | 'sft'  default 'clone'
        ref_audio  (str)  reference speaker clip path (required for 'clone')
        ref_text   (str)  transcript of ref_audio (for pure zero-shot cloning)
        instruct   (str)  natural-language tone/emotion/dialect instruction (uses instruct2)
        spk        (str)  preset speaker id (for 'sft')
        speed      (float, default 1.0)
    """
    try:
        import torchaudio
        text = (req.get("text") or "").strip()
        out_path = req.get("out_path")
        if not text or not out_path:
            return JSONResponse({"ok": False, "error": "text and out_path are required"}, status_code=400)
        speed = float(req.get("speed") or 1.0)
        mode = req.get("mode") or "clone"
        cosy = _load_cosyvoice()

        if mode == "sft":
            spk = req.get("spk") or (_state["spks"][0] if _state["spks"] else None)
            if not spk:
                return JSONResponse({"ok": False, "error": "no preset speaker available; provide a reference clip"},
                                    status_code=400)
            gen = cosy.inference_sft(text, spk, stream=False, speed=speed)
        else:
            ref_audio = req.get("ref_audio")
            if not ref_audio or not os.path.isfile(ref_audio):
                return JSONResponse({"ok": False, "error": "ref_audio (a reference speaker clip) is required for cloning"},
                                    status_code=400)
            prompt_speech = _load_prompt_speech(ref_audio)
            instruct = (req.get("instruct") or "").strip()
            if instruct:
                # Clone the reference voice AND steer tone/emotion/dialect via a natural-language instruction.
                gen = cosy.inference_instruct2(text, instruct, prompt_speech, stream=False, speed=speed)
            else:
                # Pure zero-shot clone; needs the transcript of the reference clip.
                ref_text = (req.get("ref_text") or "").strip()
                gen = cosy.inference_zero_shot(text, ref_text, prompt_speech, stream=False, speed=speed)

        wav = _collect(gen)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        torchaudio.save(out_path, wav.cpu(), _state["sr"])
        dur = wav.shape[1] / float(_state["sr"]) if _state["sr"] else 0.0
        return {"ok": True, "path": out_path, "sample_rate": _state["sr"], "duration": round(dur, 3)}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"}, status_code=500)


@app.post("/transcribe")
async def transcribe(req: dict):
    """Transcribe a reference clip so the user can review/edit it before cloning."""
    try:
        audio = req.get("audio")
        if not audio or not os.path.isfile(audio):
            return JSONResponse({"ok": False, "error": "audio path not found"}, status_code=400)
        model = _load_whisper()
        lang = req.get("language")  # optional ISO code; None => auto-detect
        segments, info = model.transcribe(audio, language=lang)
        text = "".join(seg.text for seg in segments).strip()
        return {"ok": True, "text": text, "language": getattr(info, "language", None)}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"}, status_code=500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=50000)
    ap.add_argument("--cosyvoice-dir", required=True, help="path to the cloned CosyVoice repo")
    ap.add_argument("--model-dir", required=True, help="path to the downloaded CosyVoice3 model")
    ap.add_argument("--whisper-model", default="base")
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args()
    CFG.update({
        "cosyvoice_dir": os.path.abspath(args.cosyvoice_dir),
        "model_dir": os.path.abspath(args.model_dir),
        "whisper_model": args.whisper_model,
        "device": args.device,
    })
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
