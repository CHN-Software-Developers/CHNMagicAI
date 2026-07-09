"""Build a ready-to-queue ComfyUI API prompt from high-level UI parameters.

Loads the committed API template (`workflows/ltx_director_2.api.json`) and injects the user's
timeline, settings and model filenames into the specific nodes of the LTX Director 2 pipeline.

Node id map (from the converted template; see scripts/convert_workflow.py):
    35  UNETLoader                unet_name
    12  DualCLIPLoader            clip_name1 (text encoder), clip_name2 (text projection)
    6   VAELoaderKJ (tiny)        vae_name  -> used for live preview
    8   VAELoader (audio)         vae_name
    36  VAELoader (video)         vae_name
    13  LatentUpscaleModelLoader  model_name
    131 LTXDirector               timeline_data + all creative widgets
    30  RandomNoise               noise_seed
    33  BasicScheduler (stage 1)  steps
    21  BasicScheduler (stage 2)  steps (upscale)
    28  CFGGuider (stage 1)       cfg
    17  CFGGuider (stage 2)       cfg
    2   CreateVideo (base)        final images+audio -> video
    24  LTXVAudioVAEDecode        raw generated audio (music still present)
    144 SaveAudioAdvanced         separate audio file (input rewired to the cleaned track when
                                  bg-music removal is on)
    156/157/158  background-music-removal chain (157 = CinematicAudioSeparation, out 0 = music_removed)
    37  SaveVideo                 video (input rewired when bg-music removal is off)
"""
import copy
import json
import os
import random

TEMPLATE_PATH = os.path.join(os.path.dirname(__file__), "..", "workflows", "ltx_director_2.api.json")

# node id -> settings.models key
MODEL_NODE_MAP = {
    "35": ("unet_name", "unet"),
    "6":  ("vae_name", "tiny_vae"),
    "8":  ("vae_name", "audio_vae"),
    "36": ("vae_name", "video_vae"),
    "13": ("model_name", "spatial_upscaler"),
}

LTXDIRECTOR_ID = "131"
RANDOMNOISE_ID = "30"
STAGE1_SCHED_ID = "33"
STAGE2_SCHED_ID = "21"
STAGE1_CFG_ID = "28"
STAGE2_CFG_ID = "17"
SAVEVIDEO_ID = "37"
BASE_CREATEVIDEO_ID = "2"
BG_MUSIC_NODE_IDS = ["156", "157", "158"]
SAVEAUDIO_ID = "144"           # SaveAudioAdvanced: the separate audio-only file
RAW_AUDIO_ID = "24"            # LTXVAudioVAEDecode: raw generated audio (music present)
CINEMATIC_SEP_ID = "157"       # CinematicAudioSeparation; output 0 = music_removed (speech+effects)


def build_character_timeline(description, moods_spec, line, fps, frames_per_mood):
    """Build a timeline for a character's reference-audio video.

    One text segment per mood, in which the same character speaks the same built-in `line` while
    performing that mood. LTX generates the speech natively (no custom audio segments). Returns
    (timeline_dict, moods_meta) where moods_meta = [{key,label,start,length}] — the frame ranges the
    caller later crops the per-mood reference clips from.
    """
    frames_per_mood = int(frames_per_mood) or 72
    desc = (description or "").strip()
    global_prompt = (
        (desc + ". " if desc else "")
        + f'A single person talking directly to camera, portrait framing, clear lip-synced speech, '
        'plain studio background, steady shot, saying "{line}" repeatedly in different moods: Neutral, Happy, Sad, Angry, Excited.'
    )
    segments, moods_meta = [], []
    cursor = 0
    for i, mood in enumerate(moods_spec):
        prompt = f'The character {mood.get("prompt", "")}, saying "{line}".'
        segments.append({
            "id": f"mood{i}",
            "start": cursor,
            "length": frames_per_mood,
            "prompt": prompt,
            "type": "text",
            "isEndFrame": False,
        })
        moods_meta.append({
            "key": mood.get("key"),
            "label": mood.get("label", mood.get("key", "")),
            "tone": mood.get("tone", ""),
            "start": cursor,
            "length": frames_per_mood,
        })
        cursor += frames_per_mood
    timeline = {
        "mainTrackEnabled": True,
        "audioTrackEnabled": True,
        "motionTrackEnabled": False,
        "global_prompt": global_prompt,
        "retakeMode": False,
        "overrideAudio": False,
        "inpaint_audio": True,
        "normalStartFrame": 0,
        "normalDurationFrames": cursor,
        "segments": segments,
        "motionSegments": [],
        "audioSegments": [],
    }
    return timeline, moods_meta


def load_template():
    with open(os.path.abspath(TEMPLATE_PATH), "r", encoding="utf-8") as f:
        return json.load(f)


def derive_from_timeline(timeline):
    """Derive the flat widget values LTXDirector also expects from the timeline dict."""
    segments = sorted(timeline.get("segments", []), key=lambda s: s.get("start", 0))
    global_prompt = timeline.get("global_prompt", "")
    local_prompts = " | ".join((s.get("prompt", "") or "") for s in segments)
    segment_lengths = ",".join(str(int(s.get("length", 0))) for s in segments)
    duration_frames = timeline.get("normalDurationFrames")
    if not duration_frames:
        duration_frames = sum(int(s.get("length", 0)) for s in segments)
    start_frame = int(timeline.get("normalStartFrame", 0))
    return {
        "global_prompt": global_prompt,
        "local_prompts": local_prompts,
        "segment_lengths": segment_lengths,
        "duration_frames": int(duration_frames),
        "start_frame": start_frame,
    }


def resolve_resolution(params, settings):
    """Return (width, height) from explicit values or a named preset + aspect."""
    if params.get("width") and params.get("height"):
        return int(params["width"]), int(params["height"])
    presets = settings.get("resolution_presets", {})
    res = params.get("resolution", settings.get("defaults", {}).get("resolution", "720p"))
    aspect = params.get("aspect", settings.get("defaults", {}).get("aspect", "landscape"))
    wh = presets.get(res, {}).get(aspect)
    if not wh:
        return 1280, 720
    return int(wh[0]), int(wh[1])


def _snap(v, div):
    div = int(div) or 1
    return max(div, int(round(v / div)) * div)


def build_prompt(params, settings):
    """Create a ComfyUI API prompt dict ready for POST /prompt.

    `params` (all optional; fall back to settings.defaults / template values):
        timeline (dict), frame_rate, resolution/aspect or width/height, divisible_by,
        img_compression, epsilon, guide_strength, use_custom_audio, use_custom_motion,
        inpaint_audio, override_audio, display_mode, seed, seed_mode,
        stage1_steps, stage2_steps, cfg, enable_bg_music_removal
    """
    prompt = copy.deepcopy(load_template())
    defaults = settings.get("defaults", {})
    models = settings.get("models", {})

    # --- model filenames -------------------------------------------------------------
    for node_id, (input_name, key) in MODEL_NODE_MAP.items():
        if node_id in prompt and key in models:
            prompt[node_id]["inputs"][input_name] = models[key]
    if LTXDIRECTOR_ID in prompt and "clip_text_encoder" in models:
        prompt["12"]["inputs"]["clip_name1"] = models["clip_text_encoder"]
        prompt["12"]["inputs"]["clip_name2"] = models["clip_text_projection"]

    # --- timeline + creative widgets -------------------------------------------------
    d = prompt[LTXDIRECTOR_ID]["inputs"]
    timeline = params.get("timeline")
    if isinstance(timeline, str):
        timeline = json.loads(timeline) if timeline else {}
    if timeline:
        derived = derive_from_timeline(timeline)
        d["timeline_data"] = json.dumps(timeline, ensure_ascii=False)
        d["local_prompts"] = derived["local_prompts"]
        d["segment_lengths"] = derived["segment_lengths"]
        d["start_frame"] = derived["start_frame"]
        d["duration_frames"] = derived["duration_frames"]
        d["end_frame"] = derived["start_frame"] + derived["duration_frames"]

    fps = float(params.get("frame_rate", defaults.get("frame_rate", d.get("frame_rate", 24))))
    d["frame_rate"] = fps
    d["duration_seconds"] = round(d["duration_frames"] / fps, 3) if fps else d.get("duration_seconds", 0)
    d["end_second"] = d["duration_seconds"]
    d["start_second"] = round(d.get("start_frame", 0) / fps, 3) if fps else 0

    div = int(params.get("divisible_by", defaults.get("divisible_by", d.get("divisible_by", 32))))
    w, h = resolve_resolution(params, settings)
    d["divisible_by"] = div
    d["custom_width"] = _snap(w, div)
    d["custom_height"] = _snap(h, div)
    d["display_mode"] = params.get("display_mode", defaults.get("display_mode", d.get("display_mode", "seconds")))

    for k in ("img_compression", "epsilon", "guide_strength",
              "use_custom_audio", "use_custom_motion", "inpaint_audio", "override_audio"):
        if k in params:
            d[k] = params[k]

    # --- seed ------------------------------------------------------------------------
    seed_mode = params.get("seed_mode", defaults.get("seed_mode", "randomize"))
    seed = int(params.get("seed", defaults.get("seed", 0)))
    if seed_mode == "randomize":
        seed = random.randint(0, 2**53 - 1)
    if RANDOMNOISE_ID in prompt:
        prompt[RANDOMNOISE_ID]["inputs"]["noise_seed"] = seed

    # --- steps / cfg -----------------------------------------------------------------
    if "stage1_steps" in params and STAGE1_SCHED_ID in prompt:
        prompt[STAGE1_SCHED_ID]["inputs"]["steps"] = int(params["stage1_steps"])
    if "stage2_steps" in params and STAGE2_SCHED_ID in prompt:
        prompt[STAGE2_SCHED_ID]["inputs"]["steps"] = int(params["stage2_steps"])
    if "cfg" in params:
        for cid in (STAGE1_CFG_ID, STAGE2_CFG_ID):
            if cid in prompt:
                prompt[cid]["inputs"]["cfg"] = float(params["cfg"])

    # --- background-music removal toggle ---------------------------------------------
    # The pipeline writes two artifacts: the muxed video (SaveVideo/37) and a separate audio-only
    # file (SaveAudioAdvanced/144). Both must reflect the toggle. When removal is ON, the video is
    # rebuilt from the cleaned track (158) and the separate audio file must tap the cleaned track
    # (157, out 0 = music_removed) too — otherwise the sidecar audio keeps the background music even
    # though the video doesn't. When OFF, both stay on the raw generated audio (24).
    enable_bg = params.get("enable_bg_music_removal", defaults.get("enable_bg_music_removal", False))
    if enable_bg:
        if SAVEAUDIO_ID in prompt and CINEMATIC_SEP_ID in prompt:
            prompt[SAVEAUDIO_ID]["inputs"]["audio"] = [CINEMATIC_SEP_ID, 0]
    else:
        for nid in BG_MUSIC_NODE_IDS:
            prompt.pop(nid, None)
        if SAVEVIDEO_ID in prompt and BASE_CREATEVIDEO_ID in prompt:
            prompt[SAVEVIDEO_ID]["inputs"]["video"] = [BASE_CREATEVIDEO_ID, 0]
        if SAVEAUDIO_ID in prompt:
            prompt[SAVEAUDIO_ID]["inputs"]["audio"] = [RAW_AUDIO_ID, 0]

    # --- character mood-clip extraction ---------------------------------------------
    # For a character reference-video generation, crop the generated audio into one clip per mood.
    # `enable_bg_music_removal` is forced on by the caller so the CinematicAudioSeparation chain
    # (156/157/158) stays in the graph and node 157 out 0 is the clean, music-free speech track we
    # crop from (same track the character video's audio is muxed from). Each crop is saved with a
    # `mood/<charId>-<moodKey>` prefix so `_on_complete` can match the outputs back to the mood.
    character = params.get("character")
    if character and CINEMATIC_SEP_ID in prompt:
        char_id = character.get("character_id", "char")
        for i, mood in enumerate(character.get("moods", [])):
            start = float(mood.get("start", 0)) / fps if fps else 0.0
            dur = float(mood.get("length", 0)) / fps if fps else 0.0
            trim_id = f"c_trim_{i}"
            save_id = f"c_save_{i}"
            prompt[trim_id] = {
                "class_type": "TrimAudioDuration",
                "_meta": {"title": f"Crop {mood.get('key')}"},
                "inputs": {"audio": [CINEMATIC_SEP_ID, 0], "start_index": round(start, 3),
                           "duration": round(dur, 3)},
            }
            # FLAC = lossless (best for a voice print) and needs no quality sub-option; SaveAudioAdvanced
            # only offers flac/mp3/opus (no wav). CosyVoice loads flac fine via torchaudio.
            prompt[save_id] = {
                "class_type": "SaveAudioAdvanced",
                "_meta": {"title": f"Mood {mood.get('key')}"},
                "inputs": {"audio": [trim_id, 0],
                           "filename_prefix": f"mood/{char_id}-{mood.get('key')}",
                           "format": "flac"},
            }

    return prompt, seed
