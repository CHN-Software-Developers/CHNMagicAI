/* AIVideoBuilder frontend — 3-phase stepper flow + LTX Director 2 style timeline. */
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

const MIN_LEN = 6; // frames (matches LTX Director MIN_SEGMENT_LENGTH)
const PHASES = ["setup", "generating", "result"];

const STAGE_ORDER = [
  "Loading models", "Preparing timeline", "Encoding guides",
  "Generating (stage 1)", "Upscaling latents", "Upscaling (stage 2)",
  "Decoding audio", "Decoding video", "Encoding video",
  "Post-processing audio", "Saving video",
];

const state = {
  config: null,
  segments: [],      // main track: [{id,type,prompt,length,imageFile,imageB64,isEndFrame}]
  models: [],
  selectedId: null,
  hasResult: false,
  generating: false,
};

let segId = 1;
const newId = () => `seg_${Date.now()}_${segId++}`;

/* ------------------------------- init ------------------------------- */
async function init() {
  state.config = await api("/api/config");
  populateResolution();
  applyDefaults();
  if (state.segments.length === 0) {
    state.segments.push(mkSeg("text", "A cinematic establishing shot."));
    state.segments.push(mkSeg("text", "The camera slowly pushes in, revealing detail."));
    fitToTotal();
  }
  refreshModelBadge();
  connectWS();
  wireEvents();
  renderTimeline();
  setPhase("setup");
}

function mkSeg(type, prompt = "", extra = {}) {
  return { id: newId(), type, prompt, length: 48,
           imageFile: extra.imageFile || null, imageB64: extra.imageB64 || null, isEndFrame: false };
}

function populateResolution() {
  const sel = $("resolution");
  sel.innerHTML = "";
  Object.keys(state.config.resolution_presets || { "720p": {} }).forEach((k) => {
    const o = document.createElement("option");
    o.value = k; o.textContent = k;
    sel.appendChild(o);
  });
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
    // navigability
    if (el.dataset.step === "setup") el.disabled = false;
    else if (el.dataset.step === "generating") el.disabled = !(state.generating || p === "generating");
    else if (el.dataset.step === "result") el.disabled = !state.hasResult;
  });
}

/* ------------------------------- timeline model ------------------------------- */
function frames() {
  const dur = parseFloat($("duration").value) || 1;
  const fps = parseFloat($("fps").value) || 24;
  return Math.max(state.segments.length * MIN_LEN, Math.round(dur * fps));
}

/* Scale segment lengths proportionally so they exactly fill the total frame count. */
function fitToTotal() {
  const n = state.segments.length;
  if (n === 0) return;
  const total = frames();
  let sum = state.segments.reduce((a, s) => a + (s.length || 0), 0);
  if (sum <= 0) { const per = Math.floor(total / n); state.segments.forEach((s) => (s.length = per)); sum = per * n; }
  const scale = total / sum;
  state.segments.forEach((s) => (s.length = Math.max(MIN_LEN, Math.round(s.length * scale))));
  // fix rounding drift on the last segment
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
}

function removeSegment(id) {
  state.segments = state.segments.filter((s) => s.id !== id);
  if (state.selectedId === id) { state.selectedId = null; $("segEditor").classList.add("hidden"); }
  if (state.segments.length) fitToTotal();
  renderTimeline();
}

/* ------------------------------- timeline render ------------------------------- */
function renderTimeline() {
  renderRuler();
  renderMain();
  renderAuto();
  updateTimelineInfo();
}

function renderRuler() {
  const ruler = $("tlRuler");
  ruler.innerHTML = "";
  const total = state.segments.reduce((a, s) => a + s.length, 0) || frames();
  const fps = parseFloat($("fps").value) || 24;
  const totalSecs = total / fps;
  // aim for <= 12 labels
  let stepSec = 1;
  [1, 2, 5, 10, 15, 30, 60].some((c) => (totalSecs / c <= 12 ? ((stepSec = c), true) : false));
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
  const total = state.segments.reduce((a, s) => a + s.length, 0) || 1;
  let cursor = 0;
  state.segments.forEach((s, idx) => {
    const start = cursor; cursor += s.length;
    const block = document.createElement("div");
    block.className = "tl-block" + (s.type === "image" ? " image" : "") + (s.id === state.selectedId ? " selected" : "");
    block.dataset.id = s.id;
    block.style.left = `${(start / total) * 100}%`;
    block.style.width = `${(s.length / total) * 100}%`;
    const kind = s.type === "image" ? "IMG" : "TEXT";
    block.innerHTML =
      (s.imageB64 ? `<div class="b-thumb" style="background-image:url('${s.imageB64}')"></div>` : "") +
      `<div class="b-head"><span class="b-kind">${kind}</span></div>` +
      `<div class="b-prompt">${escapeHtml(s.prompt || "(no prompt)")}</div>` +
      (idx < state.segments.length - 1 ? `<div class="b-handle" data-handle="1"></div>` : "");
    lane.appendChild(block);
  });
  if (state.segments.length === 0) {
    const e = document.createElement("div"); e.className = "tl-empty";
    e.textContent = "Add a text or image shot to begin.";
    lane.appendChild(e);
  }
  bindBlockPointer(lane);
}

function renderAuto() {
  const motionOn = $("useMotion").checked, audioOn = $("useAudio").checked;
  const m = $("laneMotion"), a = $("laneAudio");
  m.parentElement.classList.toggle("off", !motionOn);
  a.parentElement.classList.toggle("off", !audioOn);
  m.innerHTML = motionOn ? `<div class="tl-auto">Auto motion guidance (follows your shots)</div>` : `<div class="tl-auto">Motion off</div>`;
  a.innerHTML = audioOn ? `<div class="tl-auto">Auto audio generated for the full clip</div>` : `<div class="tl-auto">Audio off</div>`;
}

/* ------------------------------- timeline interaction ------------------------------- */
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
  const total = state.segments.reduce((a, s) => a + s.length, 0) || 1;
  const startX = e.clientX;
  let moved = false;

  const idxOf = (sid) => state.segments.findIndex((s) => s.id === sid);

  if (isHandle) {
    // resize boundary between this segment and the next
    const i = idxOf(id);
    const l0 = state.segments[i].length, r0 = state.segments[i + 1].length;
    const onMove = (ev) => {
      const dxFrames = ((ev.clientX - startX) / laneRect.width) * total;
      let delta = Math.round(dxFrames);
      delta = Math.max(-(l0 - MIN_LEN), Math.min(r0 - MIN_LEN, delta));
      state.segments[i].length = l0 + delta;
      state.segments[i + 1].length = r0 - delta;
      renderTimeline();
      if (state.selectedId) refreshSegEditorLen();
    };
    const onUp = () => { document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", onUp); };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return;
  }

  // move / reorder (or click to select if no movement)
  block.classList.add("dragging");
  const onMove = (ev) => {
    if (Math.abs(ev.clientX - startX) > 4) moved = true;
    if (!moved) return;
    const ptrFrame = ((ev.clientX - laneRect.left) / laneRect.width) * total;
    let acc = 0, target = state.segments.length - 1;
    for (let k = 0; k < state.segments.length; k++) {
      acc += state.segments[k].length;
      if (ptrFrame < acc - state.segments[k].length / 2) { target = k; break; }
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

/* ------------------------------- segment editor ------------------------------- */
function selectSegment(id) {
  state.selectedId = id;
  const s = state.segments.find((x) => x.id === id);
  if (!s) return;
  renderMain();
  const ed = $("segEditor");
  ed.classList.remove("hidden");
  $("segEditorTitle").textContent = s.type === "image" ? "Image shot" : "Text shot";
  $("segPrompt").value = s.prompt || "";
  const wrap = $("segImageWrap");
  if (s.type === "image" && s.imageB64) { wrap.classList.remove("hidden"); $("segImage").src = s.imageB64; }
  else wrap.classList.add("hidden");
  refreshSegEditorLen();
}

function refreshSegEditorLen() {
  const s = state.segments.find((x) => x.id === state.selectedId);
  if (!s) return;
  const fps = parseFloat($("fps").value) || 24;
  $("segLen").textContent = s.length;
  $("segSecs").textContent = (s.length / fps).toFixed(1);
}

/* ------------------------------- generate ------------------------------- */
function buildTimelineData() {
  let cursor = 0;
  const segments = state.segments.map((s) => {
    const seg = { id: s.id, start: cursor, length: s.length, prompt: s.prompt || "", type: s.type, isEndFrame: !!s.isEndFrame };
    if (s.type === "image" && s.imageFile) { seg.imageFile = s.imageFile; seg.imageB64 = s.imageB64; }
    cursor += s.length;
    return seg;
  });
  return {
    mainTrackEnabled: true, audioTrackEnabled: $("useAudio").checked,
    motionTrackEnabled: $("useMotion").checked, showFilenames: true,
    overrideAudio: false, inpaint_audio: $("inpaintAudio").checked,
    global_prompt: $("globalPrompt").value, retake_global_prompt: "",
    retakeMode: false, retakeStart: 0, retakeLength: 0, retakePrompt: "",
    retakeStrength: 1, retakeVideo: null,
    normalStartFrame: 0, normalDurationFrames: cursor,
    segments, motionSegments: [], audioSegments: [],
  };
}

async function generate() {
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
    use_custom_audio: $("useAudio").checked,
    use_custom_motion: $("useMotion").checked,
    inpaint_audio: $("inpaintAudio").checked,
    enable_bg_music_removal: $("bgMusicRemoval").checked,
    seed: parseInt($("seed").value) || 0,
    seed_mode: $("seedRandom").checked ? "randomize" : "fixed",
  };
  startGenerating();
  const res = await api("/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (res.error) { showGenError(res.error); return; }
  if (res.seed != null) $("seed").value = res.seed;
}

function startGenerating() {
  state.generating = true;
  state.hasResult = false;
  $("genError").classList.add("hidden");
  $("preview").removeAttribute("src");
  $("stageBar").style.width = "0%";
  $("stepBar").style.width = "0%";
  $("stepText").textContent = "";
  setGenStage("Starting…", 0);
  setPhase("generating");
}

function setGenStage(label, overallPct) {
  $("stageLabel").textContent = label;
  $("genStageLabel").textContent = label;
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
  ws.onopen = () => setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 20000);
  ws.onmessage = (ev) => handleWS(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connectWS, 2000);
}

function handleWS(m) {
  switch (m.type) {
    case "stage": {
      const idx = STAGE_ORDER.indexOf(m.label);
      const pct = idx >= 0 ? Math.round(((idx + 1) / STAGE_ORDER.length) * 100) : null;
      setGenStage(m.label, pct);
      break;
    }
    case "progress":
      if (m.max) {
        const pct = Math.round((m.value / m.max) * 100);
        $("stepBar").style.width = `${pct}%`;
        $("stepText").textContent = `Step ${m.value} / ${m.max}`;
      }
      break;
    case "preview":
      $("preview").src = m.image;
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
    v.src = url;
    $("downloadVideo").href = url;
    setPhase("result");
  } else {
    showGenError("Generation finished but produced no video. Check the engine console for details.");
  }
}

/* ------------------------------- models ------------------------------- */
function refreshModelBadge() {
  const missing = (state.config.models || []).filter((m) => m.required && !m.present).length;
  const badge = $("modelBadge");
  const gen = $("generate");
  if (missing === 0) {
    badge.textContent = "Models ready"; badge.className = "badge badge-good";
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
  $("modelsModal").classList.remove("hidden");
}

function renderModels() {
  const list = $("modelList");
  list.innerHTML = "";
  state.models.forEach((m) => {
    const item = document.createElement("div");
    item.className = "model-item";
    item.dataset.id = m.id;
    const statusClass = m.present ? "badge-good" : "badge-bad";
    const statusText = m.present ? (m.located_path ? "Located" : "Ready") : "Missing";
    item.innerHTML = `
      <div class="model-row">
        <div>
          <div class="model-name">${escapeHtml(m.name)}</div>
          <div class="model-sub">${m.dest_subfolder}/${m.filename}</div>
          ${m.note ? `<div class="model-sub">${escapeHtml(m.note)}</div>` : ""}
        </div>
        <div class="model-actions">
          <span class="model-status ${statusClass}">${statusText}</span>
          ${m.present ? "" : `<button class="btn btn-sm dl">Download</button>
          <button class="btn btn-sm loc">Locate…</button>`}
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

function updateDownload(m) {
  const item = document.querySelector(`.model-item[data-id="${m.id}"]`);
  if (!item) return;
  item.querySelector(".bar").classList.remove("hidden");
  if (m.pct != null) item.querySelector(".bar-fill").style.width = `${m.pct}%`;
  const msg = item.querySelector(".dlmsg");
  if (m.status === "done") { msg.textContent = "Downloaded ✓"; setTimeout(reloadModels, 800); }
  else if (m.status === "error") { msg.textContent = m.message || "Error"; }
  else if (m.total) { msg.textContent = `${fmtBytes(m.downloaded)} / ${fmtBytes(m.total)} (${m.pct}%)`; }
}

async function locate(id) {
  const path = prompt("Full path to the model file on your disk / external drive:");
  if (!path) return;
  const res = await api("/api/models/locate", {
    method: "POST", headers: { "Content-Type": "application/json" },
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
    const res = await fetch("/api/upload-image", { method: "POST", body: fd }).then((r) => r.json());
    callback(res);
  };
  input.click();
}

function pickImage() {
  uploadFor((res) => addSegment("image", "Shot based on the reference image.", { imageFile: res.imageFile, imageB64: res.imageB64 }));
}

function replaceImage() {
  const s = state.segments.find((x) => x.id === state.selectedId);
  if (!s) return;
  uploadFor((res) => { s.imageFile = res.imageFile; s.imageB64 = res.imageB64; s.type = "image"; renderTimeline(); selectSegment(s.id); });
}

/* ------------------------------- events / utils ------------------------------- */
function wireEvents() {
  $("addText").addEventListener("click", () => addSegment("text", ""));
  $("addImage").addEventListener("click", pickImage);
  $("generate").addEventListener("click", generate);
  $("interrupt").addEventListener("click", () => api("/api/interrupt", { method: "POST" }));
  $("openModels").addEventListener("click", openModels);
  $("closeModels").addEventListener("click", () => $("modelsModal").classList.add("hidden"));

  $("duration").addEventListener("change", () => { fitToTotal(); renderTimeline(); });
  $("fps").addEventListener("change", () => { fitToTotal(); renderTimeline(); });
  $("useMotion").addEventListener("change", renderAuto);
  $("useAudio").addEventListener("change", renderAuto);

  // segment editor
  $("segPrompt").addEventListener("input", (e) => {
    const s = state.segments.find((x) => x.id === state.selectedId);
    if (s) { s.prompt = e.target.value; renderMain(); }
  });
  $("segClose").addEventListener("click", () => { state.selectedId = null; $("segEditor").classList.add("hidden"); renderMain(); });
  $("segDelete").addEventListener("click", () => { if (state.selectedId) removeSegment(state.selectedId); });
  $("segReplaceImg").addEventListener("click", replaceImage);

  // stepper navigation
  document.querySelectorAll(".stepper .step").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.disabled) return;
      if (el.dataset.step === "setup") setPhase("setup");
      else if (el.dataset.step === "result" && state.hasResult) setPhase("result");
    });
  });

  // result actions
  $("editAgain").addEventListener("click", () => setPhase("setup"));
  $("newVideo").addEventListener("click", () => { $("video").removeAttribute("src"); state.hasResult = false; setPhase("setup"); });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}

init();
