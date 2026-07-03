"""
CinematicAudioSeparation - ComfyUI node.

Splits an audio track into THREE cinematic stems - Speech / Music / Effects(SFX) -
using the BandIt Plus model (DnR-trained) from ZFTurbo's Music-Source-Separation-
Training (MSST) framework. Unlike Demucs (which only splits vocals vs instrumental),
this isolates *music* from *sound-effects*, so you can drop the background score while
keeping dialogue AND diegetic SFX.

Primary use: feed an LTX-2 clip's audio in, take the `music_removed` output (= speech +
effects), and mux it back into the video.

Design notes:
- The MSST inference code is run in an ISOLATED SUBPROCESS (the same venv Python).
  This avoids import-time dependency clashes with ComfyUI's process and, as a bonus,
  returns ALL of the model's VRAM to the OS automatically when the subprocess exits -
  there is no lingering-VRAM problem.
- The vendored MSST `models/bandit/core/__init__.py` was trimmed to inference-only
  (training deps asteroid/pedalboard/etc. removed); backup at `__init__.py.orig_bak`.
"""

import os
import sys
import uuid
import shutil
import subprocess

import numpy as np
import torch
import soundfile as sf

import folder_paths

# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------
NODE_DIR = os.path.dirname(os.path.abspath(__file__))
MSST_DIR = os.path.join(NODE_DIR, "msst")
MODEL_DIR = os.path.join(folder_paths.models_dir, "audio", "bandit")
CONFIG_PATH = os.path.join(MODEL_DIR, "config_dnr_bandit_bsrnn_multi_mus64.yaml")
CKPT_PATH = os.path.join(MODEL_DIR, "model_bandit_plus_dnr_sdr_11.47.chpt")

TEMP_ROOT = folder_paths.get_temp_directory()


def _audio_in_to_wav(audio, path):
    """ComfyUI AUDIO dict -> wav file on disk (float32, native sample rate)."""
    wav = audio["waveform"]
    sr = int(audio["sample_rate"])
    if wav.dim() == 3:            # [B, C, T] -> take first batch
        wav = wav[0]
    if wav.dim() == 1:            # [T] -> [1, T]
        wav = wav.unsqueeze(0)
    data = wav.detach().cpu().float().numpy()      # [C, T]
    sf.write(path, data.T, sr, subtype="FLOAT")    # soundfile wants [T, C]
    return sr


def _wav_to_audio(path):
    """wav file -> ComfyUI AUDIO dict ([1, C, T] tensor)."""
    data, sr = sf.read(path, dtype="float32", always_2d=True)   # [T, C]
    t = torch.from_numpy(data.T).unsqueeze(0)                   # [1, C, T]
    return {"waveform": t, "sample_rate": int(sr)}


def _sum_audio(a, b):
    """Sum two AUDIO dicts (speech + effects), guarding against clipping."""
    wa, wb = a["waveform"], b["waveform"]
    n = min(wa.shape[-1], wb.shape[-1])
    out = wa[..., :n] + wb[..., :n]
    peak = float(out.abs().max()) if out.numel() else 0.0
    if peak > 1.0:
        out = out / peak
    return {"waveform": out, "sample_rate": a["sample_rate"]}


class CinematicAudioSeparation:
    """Split audio into Speech / Music / Effects and (optionally) drop the music."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "Audio to separate (e.g. from GetVideoComponents)."}),
            },
            "optional": {
                "device": (["auto", "gpu", "cpu"], {"default": "auto",
                            "tooltip": "auto = GPU if available. CPU is fine for short clips (~30s for 10s audio)."}),
                "bigshifts": ("INT", {"default": 1, "min": 1, "max": 8,
                            "tooltip": "Quality/robustness passes. 1 = fastest. Higher = cleaner separation but slower."}),
            },
        }

    CATEGORY = "audio/voice"
    RETURN_TYPES = ("AUDIO", "AUDIO", "AUDIO", "AUDIO", "STRING")
    RETURN_NAMES = ("music_removed", "speech", "music", "effects", "info")
    FUNCTION = "separate"

    def separate(self, audio, device="auto", bigshifts=1):
        if not os.path.isfile(CKPT_PATH):
            raise RuntimeError(f"BandIt Plus checkpoint not found:\n  {CKPT_PATH}")
        if not os.path.isfile(os.path.join(MSST_DIR, "inference.py")):
            raise RuntimeError(f"MSST framework not found at:\n  {MSST_DIR}")

        run_dir = os.path.join(TEMP_ROOT, f"cass_{uuid.uuid4().hex}")
        in_dir = os.path.join(run_dir, "in")
        out_dir = os.path.join(run_dir, "out")
        os.makedirs(in_dir, exist_ok=True)
        os.makedirs(out_dir, exist_ok=True)
        clip_path = os.path.join(in_dir, "clip.wav")

        try:
            _audio_in_to_wav(audio, clip_path)

            # decide device
            want_gpu = device == "gpu" or (device == "auto" and torch.cuda.is_available())

            cmd = [
                sys.executable, "inference.py",
                "--model_type", "bandit",
                "--config_path", CONFIG_PATH,
                "--start_check_point", CKPT_PATH,
                "--input_folder", in_dir,
                "--store_dir", out_dir,
                "--filename_template", "{instr}",
                "--pcm_type", "FLOAT",            # force .wav float output
                "--bigshifts", str(int(bigshifts)),
            ]
            if want_gpu:
                cmd += ["--device_ids", "0"]
            else:
                cmd += ["--force_cpu"]

            proc = subprocess.run(
                cmd, cwd=MSST_DIR, capture_output=True, text=True,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    "BandIt separation subprocess failed.\n"
                    f"--- stdout ---\n{proc.stdout[-2000:]}\n"
                    f"--- stderr ---\n{proc.stderr[-2000:]}"
                )

            paths = {k: os.path.join(out_dir, f"{k}.wav")
                     for k in ("speech", "music", "effects")}
            for k, p in paths.items():
                if not os.path.isfile(p):
                    raise RuntimeError(
                        f"Expected output stem '{k}.wav' missing.\n"
                        f"--- stdout ---\n{proc.stdout[-2000:]}"
                    )

            speech = _wav_to_audio(paths["speech"])
            music = _wav_to_audio(paths["music"])
            effects = _wav_to_audio(paths["effects"])
            music_removed = _sum_audio(speech, effects)

            info = (f"Cinematic separation OK (device={'gpu' if want_gpu else 'cpu'}, "
                    f"bigshifts={bigshifts}). Output 'music_removed' = speech + effects "
                    f"(music dropped). sr={speech['sample_rate']}")
            return (music_removed, speech, music, effects, info)
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)


NODE_CLASS_MAPPINGS = {"CinematicAudioSeparation": CinematicAudioSeparation}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CinematicAudioSeparation": "Cinematic Audio Separation (speech/music/sfx)"
}
