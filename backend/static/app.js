/* AIVideoBuilder frontend — 3-phase stepper flow + LTX Director 2 style timeline.
   Main (VIDEO) track = docked shots that partition the duration. Motion (VIDEO) and AUDIO
   tracks hold free-placement clips you can drag anywhere and resize from either edge. */
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

const MIN_LEN = 6; // frames (matches LTX Director MIN_SEGMENT_LENGTH)
const PHASES = ["setup", "generating", "result"];

const STAGE_ORDER = [
  "Stage 0: Loading models",
  "Stage 0: Preparing timeline",
  "Stage 0: Encoding guides",
  "Stage 1: Crafting",
  "Stage 2: Upscaling latents",
  "Stage 2: Upscaling",
  "Decoding audio",
  "Decoding video",
  "Encoding video",
  "Post-processing audio",
  "Saving video",
];

const state = {
  config: null,
  segments: [], // main track: [{id,type,prompt,length,imageFile,imageB64,isEndFrame}]
  audioClips: [], // free: [{id,kind:'audio',file,url,name,start,length,trimStart,voice}]
  videoClips: [], // free: [{id,kind:'video',file,url,name,start,length,trimStart}]  (motion)
  models: [],
  selectedId: null, // selected main shot
  selectedClipId: null, // selected audio/video clip
  hasResult: false,
  generating: false,
};

let segId = 1;
const newId = () => `seg_${Date.now()}_${segId++}`;

const curFps = () => parseFloat($("fps").value) || 24;

/* Composition preview playback state. This plays back the timeline the user has
   built (images/videos/audio over the shared frame axis) — it is entirely
   separate from the live per-step generation preview shown in phase 2. */
const cprev = {
  playing: false,
  playhead: 0, // frames along the shared axis
  raf: 0,
  lastT: 0,
  audioEls: new Map(), // clipId -> HTMLAudioElement
};

/* ------------------------------- init ------------------------------- */
async function init() {
  state.config = await api("/api/config");
  populateResolution();
  applyDefaults();
  // if (state.segments.length === 0) {
  //   state.segments.push(mkSeg("text", "A cinematic establishing shot."));
  //   state.segments.push(
  //     mkSeg("text", "The camera slowly pushes in, revealing detail."),
  //   );
  //   fitToTotal();
  // }
  refreshModelBadge();
  connectWS();
  wireEvents();
  updatePreviewAspect();
  renderTimeline();
  cprevRenderFrame(0);
  setPhase("setup");
}

function mkSeg(type, prompt = "", extra = {}) {
  return {
    id: newId(),
    type,
    prompt,
    length: 48,
    imageFile: extra.imageFile || null,
    imageB64: extra.imageB64 || null,
    isEndFrame: false,
  };
}

function populateResolution() {
  const sel = $("resolution");
  sel.innerHTML = "";
  Object.keys(state.config.resolution_presets || { "720p": {} }).forEach(
    (k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      sel.appendChild(o);
    },
  );
}

function applyDefaults() {
  const d = state.config.defaults || {};
  if (d.resolution) $("resolution").value = d.resolution;
  if (d.aspect) $("aspect").value = d.aspect;
  if (d.frame_rate) $("fps").value = d.frame_rate;
  if (d.duration_seconds) $("duration").value = d.duration_seconds;
  if (d.stage1_steps) $("stage1Steps").value = d.stage1_steps;
  if (d.stage2_steps) $("stage2Steps").value = d.stage2_steps;
  if (d.cfg != null) $("cfg").value = d.cfg;
  if (d.divisible_by) $("divisibleBy").value = d.divisible_by;
  if (d.img_compression) $("imgCompression").value = d.img_compression;
  $("seedRandom").checked = (d.seed_mode || "randomize") === "randomize";
  $("bgMusicRemoval").checked = !!d.enable_bg_music_removal;
}

/* ------------------------------- phases / stepper ------------------------------- */
function setPhase(p) {
  document.body.dataset.phase = p;
  document.querySelectorAll(".stepper .step").forEach((el) => {
    const idx = PHASES.indexOf(el.dataset.step);
    const cur = PHASES.indexOf(p);
    el.classList.toggle("active", el.dataset.step === p);
    el.classList.toggle("done", idx < cur);
    if (el.dataset.step === "setup") el.disabled = false;
    else if (el.dataset.step === "generating")
      el.disabled = !(state.generating || p === "generating");
    else if (el.dataset.step === "result") el.disabled = !state.hasResult;
  });
}

/* ------------------------------- timeline model ------------------------------- */
function frames() {
  const dur = parseFloat($("duration").value) || 1;
  const fps = parseFloat($("fps").value) || 24;
  return Math.max(state.segments.length * MIN_LEN, Math.round(dur * fps));
}

// The shared frame axis: main shots always fitToTotal() to frames(), so their sum == frames();
// clips live over the same axis. Guard with a floor of 1.
function totalFrames() {
  const mainSum = state.segments.reduce((a, s) => a + s.length, 0);
  return Math.max(mainSum, frames(), 1);
}

/* Scale main segment lengths proportionally so they exactly fill the total frame count. */
function fitToTotal() {
  const n = state.segments.length;
  if (n === 0) return;
  const total = frames();
  let sum = state.segments.reduce((a, s) => a + (s.length || 0), 0);
  if (sum <= 0) {
    const per = Math.floor(total / n);
    state.segments.forEach((s) => (s.length = per));
    sum = per * n;
  }
  const scale = total / sum;
  state.segments.forEach(
    (s) => (s.length = Math.max(MIN_LEN, Math.round(s.length * scale))),
  );
  let ns = state.segments.reduce((a, s) => a + s.length, 0);
  const last = state.segments[n - 1];
  last.length = Math.max(MIN_LEN, last.length + (total - ns));
  updateTimelineInfo();
}

function updateTimelineInfo() {
  const total = state.segments.reduce((a, s) => a + s.length, 0);
  const fps = parseFloat($("fps").value) || 24;
  $("tlTotal").textContent = `${total} frames`;
  $("tlDur").textContent = `${(total / fps).toFixed(1)}s`;
}

function addSegment(type, prompt = "", extra = {}) {
  const total = frames();
  const s = mkSeg(type, prompt, extra);
  s.length = Math.max(MIN_LEN, Math.round(total / (state.segments.length + 1)));
  state.segments.push(s);
  fitToTotal();
  renderTimeline();
  selectSegment(s.id);
  refreshPreview();
}

function removeSegment(id) {
  state.segments = state.segments.filter((s) => s.id !== id);
  if (state.selectedId === id) {
    state.selectedId = null;
    $("segEditor").classList.add("hidden");
  }
  if (state.segments.length) fitToTotal();
  renderTimeline();
  refreshPreview();
}

/* ------------------------------- timeline render ------------------------------- */
function renderTimeline() {
  renderRuler();
  renderMain();
  renderClips();
  updateTimelineInfo();
  updatePlayhead();
}

function renderRuler() {
  const ruler = $("tlRuler");
  ruler.innerHTML = "";
  const total = totalFrames();
  const fps = parseFloat($("fps").value) || 24;
  const totalSecs = total / fps;
  let stepSec = 1;
  [1, 2, 5, 10, 15, 30, 60].some((c) =>
    totalSecs / c <= 12 ? ((stepSec = c), true) : false,
  );
  for (let sec = 0; sec <= totalSecs + 0.001; sec += stepSec) {
    const f = sec * fps;
    const tick = document.createElement("div");
    tick.className = "tl-tick";
    tick.style.left = `${(f / total) * 100}%`;
    tick.innerHTML = `<span>${sec % 1 === 0 ? sec : sec.toFixed(1)}s</span>`;
    ruler.appendChild(tick);
  }
}

function renderMain() {
  const lane = $("laneMain");
  lane.innerHTML = "";
  const total = totalFrames();
  let cursor = 0;
  state.segments.forEach((s, idx) => {
    const start = cursor;
    cursor += s.length;
    const block = document.createElement("div");
    block.className =
      "tl-block" +
      (s.type === "image" ? " image" : "") +
      (s.id === state.selectedId ? " selected" : "");
    block.dataset.id = s.id;
    block.style.left = `${(start / total) * 100}%`;
    block.style.width = `${(s.length / total) * 100}%`;
    const kind = s.type === "image" ? "IMG" : "TEXT";
    // Image shots render as a repeating filmstrip of the reference thumbnail so
    // the timeline reads like a frame sequence rather than just prompt text.
    block.innerHTML =
      (s.imageB64
        ? `<div class="b-film" style="background-image:url('${s.imageB64}')"></div>`
        : "") +
      `<div class="b-head"><span class="b-kind">${kind}</span></div>` +
      `<div class="b-prompt" title="${escapeHtml(s.prompt || "")}">${escapeHtml(s.prompt || "(no prompt)")}</div>` +
      (idx < state.segments.length - 1
        ? `<div class="b-handle" data-handle="1"></div>`
        : "");
    lane.appendChild(block);
  });
  if (state.segments.length === 0) {
    const e = document.createElement("div");
    e.className = "tl-empty";
    e.textContent = "Add a text, image or video shot to begin.";
    lane.appendChild(e);
  }
  bindBlockPointer(lane);
}

/* Free-placement lanes: motion (video) + audio. */
function renderClips() {
  renderLane(
    "video",
    state.videoClips,
    $("laneMotion"),
    $("useMotion").checked,
    "Auto motion guidance (follows your shots)",
    "Motion off",
  );
  renderLane(
    "audio",
    state.audioClips,
    $("laneAudio"),
    $("useAudio").checked,
    "Auto audio generated for the full clip",
    "Audio off",
  );
}

function renderLane(kind, clips, lane, autoOn, autoText, offText) {
  const track = lane.parentElement;
  track.classList.toggle("off", !autoOn && clips.length === 0);
  lane.innerHTML = "";
  if (clips.length === 0) {
    lane.innerHTML = `<div class="tl-auto">${autoOn ? autoText : offText}</div>`;
    return;
  }
  const total = totalFrames();
  const lip = kind === "audio" && $("lipSync").checked;
  clips.forEach((c) => {
    const el = document.createElement("div");
    el.className =
      `tl-clip ${kind}` +
      (c.id === state.selectedClipId ? " selected" : "") +
      (kind === "audio" && c.voice ? " voice" : "");
    el.dataset.id = c.id;
    el.style.left = `${(Math.max(0, c.start) / total) * 100}%`;
    el.style.width = `${(Math.max(MIN_LEN, c.length) / total) * 100}%`;
    const kindLabel =
      kind === "audio" ? (c.voice ? "VOICE" : "AUDIO") : "VIDEO";
    el.innerHTML =
      (kind === "video" && c.poster
        ? `<div class="c-film" style="background-image:url('${c.poster}')"></div>`
        : "") +
      `<span class="c-kind">${kindLabel}</span>` +
      `<div class="c-handle left" data-handle="left"></div>` +
      `<div class="c-handle right" data-handle="right"></div>` +
      `<div class="c-label" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>`;
    lane.appendChild(el);
  });
  if (lip && clips.some((c) => c.voice)) {
    const b = document.createElement("div");
    b.className = "tl-lipbadge";
    b.textContent = "LIP-SYNC";
    lane.appendChild(b);
  }
  bindClipPointer(lane, kind);
}

/* ------------------------------- main-track interaction ------------------------------- */
function bindBlockPointer(lane) {
  lane.querySelectorAll(".tl-block").forEach((block) => {
    block.addEventListener("pointerdown", (e) => onBlockDown(e, block, lane));
  });
}

function onBlockDown(e, block, lane) {
  e.preventDefault();
  const id = block.dataset.id;
  const isHandle = e.target.dataset.handle === "1";
  const laneRect = lane.getBoundingClientRect();
  const total = totalFrames();
  const startX = e.clientX;
  let moved = false;
  const idxOf = (sid) => state.segments.findIndex((s) => s.id === sid);

  if (isHandle) {
    const i = idxOf(id);
    const l0 = state.segments[i].length,
      r0 = state.segments[i + 1].length;
    const onMove = (ev) => {
      const dxFrames = ((ev.clientX - startX) / laneRect.width) * total;
      let delta = Math.round(dxFrames);
      delta = Math.max(-(l0 - MIN_LEN), Math.min(r0 - MIN_LEN, delta));
      state.segments[i].length = l0 + delta;
      state.segments[i + 1].length = r0 - delta;
      renderTimeline();
      if (state.selectedId) refreshSegEditorLen();
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return;
  }

  block.classList.add("dragging");
  const onMove = (ev) => {
    if (Math.abs(ev.clientX - startX) > 4) moved = true;
    if (!moved) return;
    const ptrFrame = ((ev.clientX - laneRect.left) / laneRect.width) * total;
    let acc = 0,
      target = state.segments.length - 1;
    for (let k = 0; k < state.segments.length; k++) {
      acc += state.segments[k].length;
      if (ptrFrame < acc - state.segments[k].length / 2) {
        target = k;
        break;
      }
      target = k;
    }
    const cur = idxOf(id);
    if (target !== cur && target >= 0) {
      const [m] = state.segments.splice(cur, 1);
      state.segments.splice(target, 0, m);
      renderTimeline();
    }
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (!moved) selectSegment(id);
    renderTimeline();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

/* ------------------------------- clip (audio/video) interaction ------------------------------- */
function clipsOf(kind) {
  return kind === "audio" ? state.audioClips : state.videoClips;
}
function findClip(id) {
  return (
    state.audioClips.find((c) => c.id === id) ||
    state.videoClips.find((c) => c.id === id)
  );
}

function bindClipPointer(lane, kind) {
  lane.querySelectorAll(".tl-clip").forEach((el) => {
    el.addEventListener("pointerdown", (e) => onClipDown(e, el, lane, kind));
  });
}

function onClipDown(e, el, lane, kind) {
  e.preventDefault();
  const id = el.dataset.id;
  const c = clipsOf(kind).find((x) => x.id === id);
  if (!c) return;
  const handle = e.target.dataset.handle; // 'left' | 'right' | undefined (move)
  const laneRect = lane.getBoundingClientRect();
  const total = totalFrames();
  const startX = e.clientX;
  const c0 = { start: c.start, length: c.length, trimStart: c.trimStart || 0 };
  let moved = false;
  el.classList.add("dragging");
  const toFrames = (dx) => Math.round((dx / laneRect.width) * total);

  const onMove = (ev) => {
    const d = toFrames(ev.clientX - startX);
    if (Math.abs(ev.clientX - startX) > 3) moved = true;
    if (handle === "right") {
      c.length = Math.max(MIN_LEN, c0.length + d);
    } else if (handle === "left") {
      const lo = Math.max(-c0.start, -c0.trimStart);
      const hi = c0.length - MIN_LEN;
      const nd = Math.max(lo, Math.min(hi, d));
      c.start = c0.start + nd;
      c.trimStart = c0.trimStart + nd;
      c.length = c0.length - nd;
    } else {
      c.start = Math.max(0, Math.min(c0.start + d, total - MIN_LEN));
    }
    renderTimeline();
    if (state.selectedClipId === id) refreshClipEditor();
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (!moved) selectClip(id);
    renderTimeline();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

/* ------------------------------- main-shot editor ------------------------------- */
function selectSegment(id) {
  state.selectedClipId = null;
  $("clipEditor").classList.add("hidden");
  state.selectedId = id;
  const s = state.segments.find((x) => x.id === id);
  if (!s) return;
  renderTimeline();
  const ed = $("segEditor");
  ed.classList.remove("hidden");
  $("segEditorTitle").textContent =
    s.type === "image" ? "Image shot" : "Text shot";
  $("segPrompt").value = s.prompt || "";
  const wrap = $("segImageWrap");
  if (s.type === "image" && s.imageB64) {
    wrap.classList.remove("hidden");
    $("segImage").src = s.imageB64;
  } else wrap.classList.add("hidden");
  refreshSegEditorLen();
}

function refreshSegEditorLen() {
  const s = state.segments.find((x) => x.id === state.selectedId);
  if (!s) return;
  const fps = parseFloat($("fps").value) || 24;
  $("segLen").textContent = s.length;
  $("segSecs").textContent = (s.length / fps).toFixed(1);
}

/* ------------------------------- clip editor ------------------------------- */
function selectClip(id) {
  state.selectedId = null;
  $("segEditor").classList.add("hidden");
  state.selectedClipId = id;
  const c = findClip(id);
  if (!c) return;
  renderTimeline();
  const ed = $("clipEditor");
  ed.classList.remove("hidden");
  $("clipEditorTitle").textContent =
    c.kind === "audio"
      ? c.voice
        ? "Voice clip"
        : "Audio clip"
      : "Motion video clip";
  $("clipMediaWrap").innerHTML =
    c.kind === "audio"
      ? `<audio controls src="${c.url}"></audio>`
      : `<video controls muted playsinline src="${c.url}"></video>`;
  const vw = $("clipVoiceWrap");
  if (c.kind === "audio") {
    vw.classList.remove("hidden");
    $("clipVoice").checked = !!c.voice;
  } else vw.classList.add("hidden");
  refreshClipEditor();
}

function refreshClipEditor() {
  const c = findClip(state.selectedClipId);
  if (!c) return;
  const fps = parseFloat($("fps").value) || 24;
  $("clipStart").textContent = c.start;
  $("clipLen").textContent = c.length;
  $("clipSecs").textContent = (c.length / fps).toFixed(1);
}

function removeClip(id) {
  state.audioClips = state.audioClips.filter((c) => c.id !== id);
  state.videoClips = state.videoClips.filter((c) => c.id !== id);
  if (state.selectedClipId === id) {
    state.selectedClipId = null;
    $("clipEditor").classList.add("hidden");
  }
  renderTimeline();
  refreshPreview();
}

/* ------------------------------- media upload ------------------------------- */
function uploadMedia(kind, cb) {
  const input = kind === "audio" ? $("audioFileInput") : $("videoFileInput");
  input.value = "";
  input.onchange = async () => {
    if (!input.files[0]) return;
    const fd = new FormData();
    fd.append("file", input.files[0]);
    const res = await fetch("/api/upload-media", {
      method: "POST",
      body: fd,
    }).then((r) => r.json());
    cb(res);
  };
  input.click();
}

// Probe real media duration (seconds) so the clip's default length matches the file.
function probeDuration(url, kind, done) {
  const el = document.createElement(kind === "video" ? "video" : "audio");
  el.preload = "metadata";
  el.src = url;
  el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : 0);
  el.onerror = () => done(0);
}

// Grab a single poster frame from a video so the timeline clip can render a
// filmstrip thumbnail (like the image shots do). Best-effort; calls back with
// a data URL or null.
function captureVideoPoster(url, done) {
  const v = document.createElement("video");
  v.preload = "auto";
  v.muted = true;
  v.crossOrigin = "anonymous";
  v.src = url;
  let settled = false;
  const finish = (val) => {
    if (settled) return;
    settled = true;
    done(val);
  };
  v.onloadeddata = () => {
    try {
      v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
    } catch {
      finish(null);
    }
  };
  v.onseeked = () => {
    try {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = Math.max(
        1,
        Math.round((160 * (v.videoHeight || 9)) / (v.videoWidth || 16)),
      );
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      finish(c.toDataURL("image/jpeg", 0.6));
    } catch {
      finish(null);
    }
  };
  v.onerror = () => finish(null);
  setTimeout(() => finish(null), 4000);
}

function addMediaClip(kind, res) {
  const fps = curFps();
  probeDuration(res.url, kind, (dur) => {
    const total = totalFrames();
    let len = dur > 0 ? Math.round(dur * fps) : total;
    len = Math.max(MIN_LEN, Math.min(len, total));
    const clip = {
      id: newId(),
      kind,
      file: res.file,
      url: res.url,
      name: res.name,
      start: 0,
      length: len,
      trimStart: 0,
    };
    if (kind === "audio") {
      clip.voice = true;
      state.audioClips.push(clip);
    } else {
      clip.poster = null;
      state.videoClips.push(clip);
      captureVideoPoster(res.url, (poster) => {
        clip.poster = poster;
        renderTimeline();
      });
    }
    renderTimeline();
    selectClip(clip.id);
    refreshPreview();
  });
}

/* ------------------------------- composition preview ------------------------------- */
/* Plays back the timeline the user composed: image shots hold on screen for their
   span, motion-video clips play, audio clips are heard, a text shot shows its prompt
   as a placeholder card. Scrubbing the playhead seeks to any position while paused. */

// Match the preview stage box to the chosen aspect ratio.
function updatePreviewAspect() {
  const a = $("aspect").value;
  const ratio =
    a === "portrait" ? "9 / 16" : a === "square" ? "1 / 1" : "16 / 9";
  const stage = $("cprevStage");
  stage.style.aspectRatio = ratio;
  // Non-landscape ratios are height-constrained so the box stays centered and
  // doesn't grow absurdly tall at full width.
  stage.classList.toggle("tall", a === "portrait" || a === "square");
}

// What visual should show at `frame`? A motion-video clip overlays when present,
// else the covering main shot (image -> its picture, text -> its prompt card).
function activeVisual(frame) {
  for (const c of state.videoClips) {
    if (frame >= c.start && frame < c.start + c.length)
      return { kind: "video", clip: c };
  }
  let cursor = 0;
  for (const s of state.segments) {
    if (frame >= cursor && frame < cursor + s.length) {
      if (s.type === "image" && s.imageB64) return { kind: "image", seg: s };
      return { kind: "text", seg: s };
    }
    cursor += s.length;
  }
  return null;
}

function cprevRenderFrame(frame) {
  const fps = curFps();
  const total = totalFrames();
  frame = Math.max(0, Math.min(frame, total));
  const img = $("cprevImg");
  const vid = $("cprevVideo");
  const txt = $("cprevText");
  const empty = $("cprevEmpty");
  const vis =
    state.segments.length || state.videoClips.length
      ? activeVisual(Math.min(frame, total - 0.001))
      : null;

  const showOnly = (el) => {
    [img, vid, txt, empty].forEach((n) =>
      n.classList.toggle("hidden", n !== el),
    );
  };

  if (!vis) {
    if (!vid.paused) vid.pause();
    showOnly(empty);
  } else if (vis.kind === "image") {
    if (!vid.paused) vid.pause();
    if (img.getAttribute("src") !== vis.seg.imageB64)
      img.src = vis.seg.imageB64;
    showOnly(img);
  } else if (vis.kind === "text") {
    if (!vid.paused) vid.pause();
    txt.textContent = vis.seg.prompt || "(no prompt for this shot)";
    showOnly(txt);
  } else {
    const c = vis.clip;
    if (vid.dataset.clip !== c.id) {
      vid.src = c.url;
      vid.dataset.clip = c.id;
    }
    const t = (frame - c.start + (c.trimStart || 0)) / fps;
    if (cprev.playing) {
      if (vid.paused) vid.play().catch(() => {});
      if (Math.abs(vid.currentTime - t) > 0.3) {
        try {
          vid.currentTime = t;
        } catch {}
      }
    } else {
      if (!vid.paused) vid.pause();
      try {
        vid.currentTime = t;
      } catch {}
    }
    showOnly(vid);
  }

  syncPreviewAudio(frame, fps);
  updatePlayhead(frame);
}

// Drive one <audio> element per audio clip so overlapping clips can be heard.
function syncPreviewAudio(frame, fps) {
  state.audioClips.forEach((c) => {
    let el = cprev.audioEls.get(c.id);
    if (!el) {
      el = new Audio(c.url);
      el.preload = "auto";
      cprev.audioEls.set(c.id, el);
    }
    const active = frame >= c.start && frame < c.start + c.length;
    const t = (frame - c.start + (c.trimStart || 0)) / fps;
    if (active && cprev.playing) {
      if (el.paused) {
        try {
          el.currentTime = t;
        } catch {}
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - t) > 0.3) {
        try {
          el.currentTime = t;
        } catch {}
      }
    } else {
      if (!el.paused) el.pause();
      if (!cprev.playing && active) {
        try {
          el.currentTime = t;
        } catch {}
      }
    }
  });
  // Drop elements for clips that no longer exist.
  for (const [id, el] of cprev.audioEls) {
    if (!state.audioClips.find((c) => c.id === id)) {
      el.pause();
      cprev.audioEls.delete(id);
    }
  }
}

// Position the vertical indicator line + update the time readout & scrub fill.
function updatePlayhead(frame) {
  const total = totalFrames();
  const f =
    frame == null ? Math.max(0, Math.min(cprev.playhead, total)) : frame;
  cprev.playhead = f;
  const pct = total > 0 ? (f / total) * 100 : 0;
  const ph = $("tlPlayhead");
  if (ph) ph.style.left = `${pct}%`;
  const fill = $("cprevScrubFill");
  if (fill) fill.style.width = `${pct}%`;
  const fps = curFps();
  const tEl = $("cprevTime");
  if (tEl)
    tEl.textContent = `${(f / fps).toFixed(1)}s / ${(total / fps).toFixed(1)}s`;
}

function cprevPlay() {
  if (cprev.playing) return;
  const total = totalFrames();
  if (!total) return;
  if (cprev.playhead >= total - 0.5) cprev.playhead = 0;
  cprev.playing = true;
  $("cprevPlay").textContent = "⏸";
  $("cprevPlay").setAttribute("aria-label", "Pause preview");
  cprev.lastT = performance.now();
  const loop = (t) => {
    if (!cprev.playing) return;
    const dt = (t - cprev.lastT) / 1000;
    cprev.lastT = t;
    cprev.playhead += dt * curFps();
    if (cprev.playhead >= totalFrames()) {
      cprev.playhead = totalFrames();
      cprevRenderFrame(cprev.playhead);
      cprevPause();
      return;
    }
    cprevRenderFrame(cprev.playhead);
    cprev.raf = requestAnimationFrame(loop);
  };
  cprevRenderFrame(cprev.playhead);
  cprev.raf = requestAnimationFrame(loop);
}

function cprevPause() {
  cprev.playing = false;
  if (cprev.raf) cancelAnimationFrame(cprev.raf);
  cprev.raf = 0;
  $("cprevPlay").textContent = "▶";
  $("cprevPlay").setAttribute("aria-label", "Play preview");
  const vid = $("cprevVideo");
  if (vid && !vid.paused) vid.pause();
  cprev.audioEls.forEach((el) => {
    if (!el.paused) el.pause();
  });
}

function cprevToggle() {
  cprev.playing ? cprevPause() : cprevPlay();
}

// Refresh the paused preview after the composition changes (edit, add, remove).
// While playing, the raf loop already repaints every frame, so skip.
function refreshPreview() {
  if (!cprev.playing) cprevRenderFrame(cprev.playhead);
}

// Scrubbing: pointer down on the ruler, the preview scrub bar, or the playhead
// grip pauses and seeks, then follows the pointer. `refEl` is the element whose
// width maps clientX -> frame (ruler for timeline drags, the scrub bar itself
// for the preview bar).
function frameFromClientX(clientX, refEl) {
  const rect = refEl.getBoundingClientRect();
  const total = totalFrames();
  const f = ((clientX - rect.left) / rect.width) * total;
  return Math.max(0, Math.min(total, f));
}

function startScrub(e, refEl) {
  e.preventDefault();
  cprevPause();
  const ref = refEl || $("tlRuler");
  const move = (ev) => {
    cprev.playhead = frameFromClientX(ev.clientX, ref);
    cprevRenderFrame(cprev.playhead);
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  move(e);
}

/* ------------------------------- generate ------------------------------- */
function buildTimelineData() {
  let cursor = 0;
  const segments = state.segments.map((s) => {
    const seg = {
      id: s.id,
      start: cursor,
      length: s.length,
      prompt: s.prompt || "",
      type: s.type,
      isEndFrame: !!s.isEndFrame,
    };
    if (s.type === "image" && s.imageFile) {
      seg.imageFile = s.imageFile;
      seg.imageB64 = s.imageB64;
    }
    cursor += s.length;
    return seg;
  });
  const audioSegments = state.audioClips.map((c) => ({
    id: c.id,
    audioFile: c.file,
    start: c.start,
    length: c.length,
    trimStart: c.trimStart || 0,
    voice: !!c.voice,
  }));
  const motionSegments = state.videoClips.map((c) => ({
    id: c.id,
    videoFile: c.file,
    start: c.start,
    length: c.length,
    trimStart: c.trimStart || 0,
  }));
  return {
    mainTrackEnabled: true,
    audioTrackEnabled: $("useAudio").checked,
    motionTrackEnabled: $("useMotion").checked,
    showFilenames: true,
    overrideAudio: $("overrideAudio").checked,
    inpaint_audio: $("inpaintAudio").checked,
    global_prompt: $("globalPrompt").value,
    retake_global_prompt: "",
    retakeMode: false,
    retakeStart: 0,
    retakeLength: 0,
    retakePrompt: "",
    retakeStrength: 1,
    retakeVideo: null,
    normalStartFrame: 0,
    normalDurationFrames: cursor,
    segments,
    motionSegments,
    audioSegments,
  };
}

async function generate() {
  const hasAudioClips = state.audioClips.length > 0;
  const lip = $("lipSync").checked;
  const params = {
    timeline: buildTimelineData(),
    resolution: $("resolution").value,
    aspect: $("aspect").value,
    frame_rate: parseFloat($("fps").value),
    stage1_steps: parseInt($("stage1Steps").value),
    stage2_steps: parseInt($("stage2Steps").value),
    cfg: parseFloat($("cfg").value),
    divisible_by: parseInt($("divisibleBy").value),
    img_compression: parseInt($("imgCompression").value),
    epsilon: parseFloat($("epsilon").value),
    guide_strength: $("guideStrength").value,
    // Use the provided timeline audio (and let the joint model sync video to it) whenever the
    // user loaded audio clips or ticked Lip-sync; otherwise generate audio from scratch.
    use_custom_audio: hasAudioClips || lip,
    use_custom_motion: $("useMotion").checked,
    inpaint_audio: lip ? true : $("inpaintAudio").checked,
    override_audio: $("overrideAudio").checked,
    // Backend strips the CinematicAudioSeparation node chain unless this is true,
    // so the checkbox must be forwarded explicitly or the feature is a no-op.
    enable_bg_music_removal: $("bgMusicRemoval").checked,
    seed: parseInt($("seed").value) || 0,
    seed_mode: $("seedRandom").checked ? "randomize" : "fixed",
  };
  startGenerating();
  const res = await api("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (res.error) {
    showGenError(res.error);
    return;
  }
  if (res.seed != null) $("seed").value = res.seed;
}

// Map the aspect setting -> a CSS aspect-ratio string.
function aspectRatioStr(aspect) {
  return aspect === "portrait"
    ? "9 / 16"
    : aspect === "square"
      ? "1 / 1"
      : "16 / 9";
}

// Size a media box to its content's aspect. Landscape stays width-driven (full
// width, capped); portrait/square become height-driven (`tall`) so they only
// take the area's height and stay narrow — no stretching across the full width.
function fitMediaBox(el, ratioStr, tall) {
  el.style.aspectRatio = ratioStr;
  el.classList.toggle("tall", !!tall);
}

function startGenerating() {
  cprevPause();
  state.generating = true;
  state.hasResult = false;
  $("genError").classList.add("hidden");
  $("preview").removeAttribute("src");
  const pv = $("previewVideo");
  pv.removeAttribute("src");
  pv.classList.add("hidden");
  $("preview").classList.remove("hidden");
  $("genPreview").classList.remove("has-preview");
  // Shape the preview box to what we're about to generate.
  const asp = $("aspect").value;
  fitMediaBox($("genPreview"), aspectRatioStr(asp), asp !== "landscape");
  $("stageBar").style.width = "0%";
  $("stepBar").style.width = "0%";
  setGenStage("Starting…", 0);
  setPhase("generating");
}

// Render a live per-step preview frame. ModelPreviewOverrideKJ sends either a still
// (image/jpeg, image/webp) or an animated clip (video/mp4) depending on preview_frames/NVENC —
// an <img> can't play mp4, so route video mimes to the <video> element.
function showPreview(dataUrl, mime) {
  const img = $("preview");
  const vid = $("previewVideo");
  if (mime && mime.indexOf("video/") === 0) {
    img.removeAttribute("src");
    img.classList.add("hidden");
    vid.src = dataUrl;
    vid.classList.remove("hidden");
    vid.play && vid.play().catch(() => {});
  } else {
    vid.removeAttribute("src");
    vid.classList.add("hidden");
    img.classList.remove("hidden");
    img.src = dataUrl;
  }
  $("genPreview").classList.add("has-preview");
}

function setGenStage(label, overallPct) {
  $("stageLabel").textContent = label;
  if (overallPct != null) $("stageBar").style.width = `${overallPct}%`;
}

function showGenError(message) {
  state.generating = false;
  const box = $("genError");
  box.textContent = message;
  box.classList.remove("hidden");
  setGenStage("⚠️ Generation failed", null);
  setPhase("generating");
}

/* ------------------------------- websocket ------------------------------- */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () =>
    setInterval(() => {
      if (ws.readyState === 1) ws.send("ping");
    }, 20000);
  ws.onmessage = (ev) => handleWS(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connectWS, 2000);
}

function handleWS(m) {
  switch (m.type) {
    case "stage": {
      const idx = STAGE_ORDER.indexOf(m.label);
      const pct =
        idx >= 0 ? Math.round(((idx + 1) / STAGE_ORDER.length) * 100) : null;
      setGenStage(m.label, pct);
      break;
    }
    case "progress":
      if (m.max) {
        const pct = Math.round((m.value / m.max) * 100);
        $("stepBar").style.width = `${pct}%`;
      }
      break;
    case "preview":
      showPreview(m.image, m.mime);
      break;
    case "complete":
      onComplete(m.video_url);
      break;
    case "error":
      showGenError(m.message || "Error");
      break;
    case "download":
      updateDownload(m);
      break;
  }
}

function onComplete(url) {
  state.generating = false;
  if (url) {
    state.hasResult = true;
    const v = $("video");
    // Fit the result player to the video's real dimensions so portrait/square
    // output isn't letterboxed inside a wide 16:9 frame.
    v.onloadedmetadata = () => {
      if (v.videoWidth && v.videoHeight) {
        fitMediaBox(
          v,
          `${v.videoWidth} / ${v.videoHeight}`,
          v.videoHeight > v.videoWidth,
        );
      }
    };
    v.src = url;
    $("downloadVideo").href = url;
    setPhase("result");
  } else {
    showGenError(
      "Generation finished but produced no video. Check the engine console for details.",
    );
  }
}

/* ------------------------------- models ------------------------------- */
function refreshModelBadge() {
  const missing = (state.config.models || []).filter(
    (m) => m.required && !m.present,
  ).length;
  const badge = $("modelBadge");
  const gen = $("generate");
  if (missing === 0) {
    badge.textContent = "Models ready";
    badge.className = "badge badge-good";
    gen.disabled = false;
  } else {
    badge.textContent = `${missing} model${missing > 1 ? "s" : ""} missing`;
    badge.className = "badge badge-bad";
    gen.disabled = true;
  }
}

async function openModels() {
  state.models = await api("/api/models");
  renderModels();
  openModal("modelsModal");
}

function renderModels() {
  const list = $("modelList");
  list.innerHTML = "";
  state.models.forEach((m) => {
    const item = document.createElement("div");
    item.className = "model-item";
    item.dataset.id = m.id;
    const statusClass = m.present ? "badge-good" : "badge-bad";
    const statusText = m.present
      ? m.located_path
        ? "Located"
        : "Ready"
      : "Missing";
    item.innerHTML = `
      <div class="model-row">
        <div>
          <div class="model-name">${escapeHtml(m.name)}</div>
          <div class="model-sub">${m.dest_subfolder}/${m.filename}</div>
          ${m.note ? `<div class="model-sub">${escapeHtml(m.note)}</div>` : ""}
        </div>
        <div class="model-actions">
          <span class="model-status ${statusClass}">${statusText}</span>
          ${
            m.present
              ? ""
              : `<button class="btn btn-sm dl">Download</button>
          <button class="btn btn-sm loc">Locate…</button>`
          }
        </div>
      </div>
      <div class="bar hidden"><div class="bar-fill"></div></div>
      <div class="model-sub dlmsg"></div>`;
    if (!m.present) {
      item.querySelector(".dl").addEventListener("click", () => download(m.id));
      item.querySelector(".loc").addEventListener("click", () => locate(m.id));
    }
    list.appendChild(item);
  });
}

async function download(id) {
  const item = document.querySelector(`.model-item[data-id="${id}"]`);
  item.querySelector(".bar").classList.remove("hidden");
  item.querySelector(".dlmsg").textContent = "Starting…";
  await api("/api/models/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

function updateDownload(m) {
  const item = document.querySelector(`.model-item[data-id="${m.id}"]`);
  if (!item) return;
  item.querySelector(".bar").classList.remove("hidden");
  if (m.pct != null) item.querySelector(".bar-fill").style.width = `${m.pct}%`;
  const msg = item.querySelector(".dlmsg");
  if (m.status === "done") {
    msg.textContent = "Downloaded ✓";
    setTimeout(reloadModels, 800);
  } else if (m.status === "error") {
    msg.textContent = m.message || "Error";
  } else if (m.total) {
    msg.textContent = `${fmtBytes(m.downloaded)} / ${fmtBytes(m.total)} (${m.pct}%)`;
  }
}

async function locate(id) {
  const path = prompt(
    "Full path to the model file on your disk / external drive:",
  );
  if (!path) return;
  const res = await api("/api/models/locate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, path }),
  });
  alert(res.message || (res.ok ? "Located" : "Failed"));
  reloadModels();
}

async function reloadModels() {
  state.config = await api("/api/config");
  state.models = await api("/api/models");
  renderModels();
  refreshModelBadge();
}

/* ------------------------------- image upload ------------------------------- */
function uploadFor(callback) {
  const input = $("imageFileInput");
  input.value = "";
  input.onchange = async () => {
    if (!input.files[0]) return;
    const fd = new FormData();
    fd.append("file", input.files[0]);
    const res = await fetch("/api/upload-image", {
      method: "POST",
      body: fd,
    }).then((r) => r.json());
    callback(res);
  };
  input.click();
}

function pickImage() {
  uploadFor((res) =>
    addSegment("image", "Shot based on the reference image.", {
      imageFile: res.imageFile,
      imageB64: res.imageB64,
    }),
  );
}

function replaceImage() {
  const s = state.segments.find((x) => x.id === state.selectedId);
  if (!s) return;
  uploadFor((res) => {
    s.imageFile = res.imageFile;
    s.imageB64 = res.imageB64;
    s.type = "image";
    renderTimeline();
    selectSegment(s.id);
    refreshPreview();
  });
}

/* ------------------------------- modals ------------------------------- */
function openModal(id) {
  $(id).classList.add("open");
}
function closeModal(id) {
  $(id).classList.remove("open");
}

/* ------------------------------- events / utils ------------------------------- */
function wireEvents() {
  $("addText").addEventListener("click", () => addSegment("text", ""));
  $("addImage").addEventListener("click", pickImage);
  $("addAudio").addEventListener("click", () =>
    uploadMedia("audio", (res) => addMediaClip("audio", res)),
  );
  $("addVideo").addEventListener("click", () =>
    uploadMedia("video", (res) => addMediaClip("video", res)),
  );
  $("generate").addEventListener("click", generate);
  $("interrupt").addEventListener("click", () =>
    api("/api/interrupt", { method: "POST" }),
  );

  $("openModels").addEventListener("click", openModels);
  $("closeModels").addEventListener("click", () => closeModal("modelsModal"));
  $("openAdvanced").addEventListener("click", () => openModal("advancedModal"));
  $("closeAdvanced").addEventListener("click", () =>
    closeModal("advancedModal"),
  );
  // click on backdrop closes the modal
  document.querySelectorAll(".modal").forEach((m) =>
    m.addEventListener("pointerdown", (e) => {
      if (e.target === m) closeModal(m.id);
    }),
  );

  // composition preview
  $("cprevPlay").addEventListener("click", cprevToggle);
  $("cprevScrub").addEventListener("pointerdown", (e) =>
    startScrub(e, $("cprevScrub")),
  );
  $("tlRuler").addEventListener("pointerdown", (e) => startScrub(e));
  $("tlPlayheadGrip").addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    startScrub(e);
  });
  $("aspect").addEventListener("change", () => {
    updatePreviewAspect();
    refreshPreview();
  });

  $("duration").addEventListener("change", () => {
    fitToTotal();
    renderTimeline();
    refreshPreview();
  });
  $("fps").addEventListener("change", () => {
    fitToTotal();
    renderTimeline();
    refreshPreview();
  });
  $("useMotion").addEventListener("change", () => {
    renderClips();
    refreshPreview();
  });
  $("useAudio").addEventListener("change", () => {
    renderClips();
    refreshPreview();
  });
  $("lipSync").addEventListener("change", renderClips);

  // main-shot editor
  $("segPrompt").addEventListener("input", (e) => {
    const s = state.segments.find((x) => x.id === state.selectedId);
    if (s) {
      s.prompt = e.target.value;
      renderMain();
      refreshPreview();
    }
  });
  $("segClose").addEventListener("click", () => {
    state.selectedId = null;
    $("segEditor").classList.add("hidden");
    renderMain();
  });
  $("segDelete").addEventListener("click", () => {
    if (state.selectedId) removeSegment(state.selectedId);
  });
  $("segReplaceImg").addEventListener("click", replaceImage);

  // clip editor
  $("clipClose").addEventListener("click", () => {
    state.selectedClipId = null;
    $("clipEditor").classList.add("hidden");
    renderClips();
  });
  $("clipDelete").addEventListener("click", () => {
    if (state.selectedClipId) removeClip(state.selectedClipId);
  });
  $("clipVoice").addEventListener("change", (e) => {
    const c = findClip(state.selectedClipId);
    if (c) {
      c.voice = e.target.checked;
      renderTimeline();
      selectClip(c.id);
    }
  });

  // stepper navigation
  document.querySelectorAll(".stepper .step").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.disabled) return;
      if (el.dataset.step === "setup") setPhase("setup");
      else if (el.dataset.step === "result" && state.hasResult)
        setPhase("result");
    });
  });

  // result actions
  $("editAgain").addEventListener("click", () => setPhase("setup"));
  $("newVideo").addEventListener("click", () => {
    $("video").removeAttribute("src");
    state.hasResult = false;
    setPhase("setup");
  });
}

function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(1)} ${u[i]}`;
}

init();
