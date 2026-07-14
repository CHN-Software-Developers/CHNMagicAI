/* CHNMagicAI frontend — projects workspace + 3-phase studio (LTX Director 2 style timeline).
   Top-level screens (body[data-screen]): projects (landing) → library (a project's media grid)
   → studio (the Compose/Generate/Result stepper). Inside the studio, the Main (VIDEO) track =
   docked shots that partition the duration; Motion (VIDEO) and AUDIO tracks hold free-placement
   clips you can drag anywhere and resize from either edge. */
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
  // Projects workspace
  screen: "projects", // projects | library | studio
  projects: [], // registry list for the landing grid
  currentProjectId: null, // the project a generation files into
  currentProject: null, // its loaded manifest (media list)
  lastMediaId: null, // media id of the just-finished generation (for last-frame upload)
  libTab: "media", // library sub-tab: media | characters
  characters: [], // current project's characters
};

let segId = 1;
const newId = () => `seg_${Date.now()}_${segId++}`;

// Trash glyph for the per-segment delete control (shown only when selected).
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';
const delBtnHtml = (title) =>
  `<button class="tl-del" data-del="1" title="${title}">${TRASH_SVG}</button>`;

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
  // Land on the projects workspace; the studio is prepped above and entered per project.
  loadProjects();
  setScreen("projects");
  // First thing the user sees when required models are missing is the Models installer.
  if (state.config && state.config.all_required_present === false) {
    openModels();
  }
}

function mkSeg(type, prompt = "", extra = {}) {
  return {
    id: newId(),
    type,
    prompt,
    length: 48,
    imageFile: extra.imageFile || null,
    imageB64: extra.imageB64 || null,
    // Video segments (main track) carry the engine input filename in imageFile — the
    // same key LTX Director reads for both image and video guides — plus a preview URL,
    // a poster thumbnail, and a trim offset. `lockLen` keeps fitToTotal from rescaling
    // the segment away from the real clip length.
    videoUrl: extra.videoUrl || null,
    poster: extra.poster || null,
    trimStart: extra.trimStart || 0,
    lockLen: !!extra.lockLen,
    name: extra.name || "",
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

/* ------------------------------- screens (workspace) ------------------------------- */
function setScreen(s) {
  state.screen = s;
  document.body.dataset.screen = s;
  if ((s === "library" || s === "studio") && state.currentProject) {
    $("crumbProject").textContent = state.currentProject.name || "Project";
  }
}

async function loadProjects() {
  const res = await api("/api/projects");
  state.projects = (res && res.projects) || [];
  renderProjects();
}

function renderProjects() {
  const grid = $("projectGrid");
  const empty = $("projectsEmpty");
  grid.innerHTML = "";
  if (!state.projects.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  state.projects.forEach((p) => {
    const card = document.createElement("article");
    card.className = "project-card" + (p.exists ? "" : " missing");
    card.dataset.id = p.id;
    const thumb = p.thumbnail
      ? `<img src="/api/projects/${p.thumbnail.project}/file/${p.thumbnail.media}/lastframe" alt="" />`
      : `<div class="pc-thumb-empty">🎬</div>`;
    const count = p.media_count || 0;
    card.innerHTML =
      `<div class="pc-thumb">${thumb}</div>` +
      `<div class="pc-body">` +
      `<h3 class="pc-name">${escapeHtml(p.name)}</h3>` +
      `<p class="pc-meta">${count} item${count === 1 ? "" : "s"}${
        p.exists ? "" : " · folder missing"
      }</p>` +
      `<p class="pc-path" title="${escapeHtml(p.path || "")}">${escapeHtml(
        p.path || "",
      )}</p>` +
      `</div>` +
      `<button class="pc-del" data-del="1" title="Remove from list">${TRASH_SVG}</button>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-del]")) {
        e.stopPropagation();
        removeProject(p.id);
        return;
      }
      if (!p.exists) {
        alert("This project folder is missing. Use “Open existing…” to relocate it.");
        return;
      }
      openProject(p.id);
    });
    grid.appendChild(card);
  });
}

async function pickDir(title) {
  // On a headless runtime (RunPod) there is no native OS dialog on the server, so browse the
  // runtime's own filesystem via an in-app modal. On desktop/repo the native picker is used.
  if ((state.config?.environment?.folder_browser || "native") === "server") {
    return serverPickDir(title);
  }
  const res = await api("/api/projects/pick-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return (res && res.path) || "";
}

/* ---- server-side folder browser (RunPod) ---- */
const fsBrowser = { path: "", resolve: null };

function serverPickDir(title) {
  $("folderTitle").textContent = title || "Select a folder";
  $("fsNewName").value = "";
  $("fsStatus").textContent = "";
  openModal("folderModal");
  fsLoad("");
  return new Promise((resolve) => {
    fsBrowser.resolve = resolve;
  });
}

async function fsLoad(path) {
  const data = await api(`/api/fs/list?path=${encodeURIComponent(path || "")}`);
  fsBrowser.path = data.path;
  $("fsPath").textContent = data.path;
  $("fsSelected").textContent = data.path;
  const list = $("fsList");
  list.innerHTML = "";
  if (data.parent != null) {
    const up = document.createElement("button");
    up.className = "fs-item fs-up";
    up.textContent = "⬆ ..";
    up.addEventListener("click", () => fsLoad(data.parent));
    list.appendChild(up);
  }
  (data.dirs || []).forEach((d) => {
    const b = document.createElement("button");
    b.className = "fs-item";
    b.textContent = "📁 " + d.name;
    b.addEventListener("click", () => fsLoad(d.path));
    list.appendChild(b);
  });
  $("fsEmpty").classList.toggle("hidden", (data.dirs || []).length > 0 || data.parent != null);
}

async function fsMkdir() {
  const name = $("fsNewName").value.trim();
  if (!name) return;
  const res = await api("/api/fs/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fsBrowser.path, name }),
  });
  if (!res.ok) {
    $("fsStatus").textContent = res.error || "Could not create the folder.";
    return;
  }
  $("fsNewName").value = "";
  $("fsStatus").textContent = "";
  fsLoad(res.path); // step into the newly created folder
}

function fsClose(pathOrEmpty) {
  closeModal("folderModal");
  const r = fsBrowser.resolve;
  fsBrowser.resolve = null;
  if (r) r(pathOrEmpty || "");
}

async function pickFile(title) {
  const res = await api("/api/pick-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return (res && res.path) || "";
}

// The project name defaults to the chosen folder's own name — the user picks/creates a single
// folder in the native explorer, so there are no extra browser prompts to juggle.
function baseName(p) {
  const parts = (p || "").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

async function newProject() {
  const folder = await pickDir("Choose or create an empty folder for the new project");
  if (!folder) return; // cancelled — nothing else pops up
  const res = await api("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: baseName(folder), location: folder, asRoot: true }),
  });
  if (!res.ok) {
    alert(res.error || "Could not create the project.");
    return;
  }
  await loadProjects();
  openProject(res.project.id);
}

async function openExisting() {
  const path = await pickDir("Select an existing project folder");
  if (!path) return; // cancelled
  const res = await api("/api/projects/locate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    alert(res.error || "That folder is not a CHNMagicAI project.");
    return;
  }
  await loadProjects();
  openProject(res.project.id);
}

async function removeProject(id) {
  if (!confirm("Remove this project from the list? (Files on disk are kept.)")) return;
  await api(`/api/projects/${id}`, { method: "DELETE" });
  loadProjects();
}

async function openProject(id) {
  const res = await api(`/api/projects/${id}`);
  if (!res.ok) {
    alert(res.error || "Could not open the project.");
    loadProjects();
    return;
  }
  state.currentProjectId = id;
  state.currentProject = res;
  state.libTab = "media";
  renderLibrary();
  setScreen("library");
}

async function refreshLibrary() {
  if (!state.currentProjectId) return;
  const res = await api(`/api/projects/${state.currentProjectId}`);
  if (res.ok) {
    state.currentProject = res;
    renderLibrary();
  }
}

function renderLibrary() {
  const proj = state.currentProject;
  if (!proj) return;
  $("libTitle").textContent = proj.name || "Project";
  state.characters = proj.characters || [];
  renderMedia();
  renderVoices();
  renderCharacters();
  setLibTab(state.libTab);
}

// Media tab holds ONLY compound generations (video + last frame + its audio). Standalone generated
// speech clips (type "voice") live in their own Voices tab.
function projectGenerations() {
  return ((state.currentProject && state.currentProject.media) || []).filter(
    (m) => m.type !== "voice",
  );
}
function projectVoices() {
  return ((state.currentProject && state.currentProject.media) || []).filter(
    (m) => m.type === "voice",
  );
}

function renderMedia() {
  const gens = projectGenerations();
  const grid = $("mediaGrid");
  grid.innerHTML = "";
  $("libraryEmpty").classList.toggle("hidden", gens.length > 0);
  gens
    .slice()
    .reverse()
    .forEach((m) => grid.appendChild(buildMediaCard(m)));
}

function renderVoices() {
  const voices = projectVoices();
  const grid = $("voiceGrid");
  grid.innerHTML = "";
  $("voicesEmpty").classList.toggle("hidden", voices.length > 0);
  voices
    .slice()
    .reverse()
    .forEach((m) => grid.appendChild(buildMediaCard(m)));
}

// Toggle the Media / Voices / Characters sub-tabs (panes + contextual "New …" button + sub-label).
function setLibTab(name) {
  state.libTab = name;
  document
    .querySelectorAll("#libTabs .lib-tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.libtab === name));
  document
    .querySelectorAll("#screenLibrary .lib-pane")
    .forEach((p) => p.classList.toggle("hidden", p.dataset.libpane !== name));
  $("newGeneration").classList.toggle("hidden", name !== "media");
  $("newCharacter").classList.toggle("hidden", name !== "characters");
  let n, unit;
  if (name === "characters") {
    n = state.characters.length;
    unit = ["character", "characters"];
  } else if (name === "voices") {
    n = projectVoices().length;
    unit = ["voice", "voices"];
  } else {
    n = projectGenerations().length;
    unit = ["item", "items"];
  }
  $("libSub").textContent = `${n} ${n === 1 ? unit[0] : unit[1]}`;
}

function renderCharacters() {
  const grid = $("characterGrid");
  const chars = state.characters || [];
  grid.innerHTML = "";
  $("charactersEmpty").classList.toggle("hidden", chars.length > 0);
  chars
    .slice()
    .reverse()
    .forEach((c) => grid.appendChild(buildCharacterCard(c)));
}

function buildCharacterCard(c) {
  const card = document.createElement("article");
  card.className = "character-card" + (c.status === "generating" ? " generating" : "");
  card.dataset.id = c.id;
  // Each mood with a clip is a play control (previews that mood's reference voice); moods without a
  // clip render as a dim, non-interactive chip.
  const moodChips = (c.moods || [])
    .map((m) =>
      m.clip
        ? `<button type="button" class="mood-chip play" data-clip="${m.clip}">` +
          `<span class="mc-play-ico">▶</span>${escapeHtml(m.label || m.key)}</button>`
        : `<span class="mood-chip empty">${escapeHtml(m.label || m.key)}</span>`,
    )
    .join("");
  let statusRow = "";
  if (c.status === "generating") {
    statusRow =
      `<div class="char-generating"><span class="char-spinner"></span> Generating reference video…</div>`;
  } else if (c.status === "error") {
    statusRow = `<div class="char-error">Generation failed. Delete and try again.</div>`;
  }
  const ready = (c.moods || []).filter((m) => m.clip).length;
  card.innerHTML =
    `<div class="char-avatar">${c.avatar ? `<img src="${c.avatar}" alt="" />` : "🎭"}</div>` +
    `<div class="char-body">` +
    `<h3 class="char-name">${escapeHtml(c.name || "Character")}</h3>` +
    (c.description
      ? `<p class="char-desc">${escapeHtml(c.description)}</p>`
      : "") +
    statusRow +
    `<div class="mood-chips">${moodChips}</div>` +
    (c.status === "ready"
      ? `<p class="char-meta">${ready} mood voice${ready === 1 ? "" : "s"} ready — tap to preview</p>`
      : "") +
    (c.status === "ready" && c.fullAudio
      ? `<div class="char-card-actions"><button type="button" class="btn btn-sm" data-edit="1">✎ Adjust clips</button></div>`
      : "") +
    `</div>` +
    `<audio class="mood-audio hidden"></audio>` +
    `<button class="pc-del" data-del="1" title="Delete character">${TRASH_SVG}</button>`;
  const audio = card.querySelector(".mood-audio");
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-del]")) {
      e.stopPropagation();
      deleteCharacter(c.id);
      return;
    }
    if (e.target.closest("[data-edit]")) {
      e.stopPropagation();
      openCropEditor(c.id);
      return;
    }
    const play = e.target.closest(".mood-chip.play");
    if (play) {
      e.stopPropagation();
      const url = play.dataset.clip;
      const wasPlaying = audio.dataset.clip === url && !audio.paused;
      card
        .querySelectorAll(".mood-chip.play.playing")
        .forEach((b) => b.classList.remove("playing"));
      if (wasPlaying) {
        audio.pause();
        return;
      }
      audio.src = url;
      audio.dataset.clip = url;
      play.classList.add("playing");
      audio.onended = () => play.classList.remove("playing");
      audio.play().catch(() => play.classList.remove("playing"));
    }
  });
  return card;
}

function openCharacterModal() {
  $("charName").value = "";
  $("charDesc").value = "";
  $("charStatus").textContent = "";
  $("charGenerate").disabled = false;
  openModal("characterModal");
}

async function createCharacter() {
  const name = $("charName").value.trim();
  const description = $("charDesc").value.trim();
  if (!description) {
    $("charStatus").textContent = "Describe the character first.";
    return;
  }
  if (!state.currentProjectId) return;
  $("charGenerate").disabled = true;
  $("charStatus").textContent = "Starting generation…";
  let res = null;
  try {
    res = await api(`/api/projects/${state.currentProjectId}/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    $("charStatus").textContent = (res && res.error) || "Could not start generation.";
    $("charGenerate").disabled = false;
    return;
  }
  closeModal("characterModal");
  await refreshLibrary();
  setLibTab("characters");
}

async function deleteCharacter(id) {
  if (!confirm("Delete this character and its reference clips?")) return;
  await api(`/api/projects/${state.currentProjectId}/characters/${id}`, {
    method: "DELETE",
  });
  await refreshLibrary();
  setLibTab("characters");
}

/* ------------------- character mood-clip crop editor (full-audio regions) ------------------- */
const crop = {
  charId: null,
  buffer: null, // decoded AudioBuffer of the full reference audio
  duration: 0,
  regions: [], // [{key,label,start,end,dirty,color}]
  drag: null, // {idx, edge, x0, s0, e0}
  playTimer: null,
};
const MOOD_COLORS = ["#38bdf8", "#4ade80", "#a78bfa", "#f472b6", "#fbbf24"];

async function openCropEditor(charId) {
  const c = (state.characters || []).find((x) => x.id === charId);
  if (!c || !c.fullAudio) return;
  crop.charId = charId;
  crop.buffer = null;
  crop.duration = 0;
  crop.regions = (c.moods || []).map((m, i) => ({
    key: m.key,
    label: m.label || m.key,
    start: m.startSec || 0,
    end: m.endSec || 0,
    dirty: false,
    color: MOOD_COLORS[i % MOOD_COLORS.length],
  }));
  $("cropCharName").textContent = c.name || "Character";
  $("cropStatus").textContent = "";
  $("cropSave").disabled = true;
  $("cropWaveLoading").classList.remove("hidden");
  $("cropRegions").innerHTML = "";
  $("cropList").innerHTML = "";
  openModal("cropModal");
  try {
    const resp = await fetch(c.fullAudio);
    const arr = await resp.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    crop.buffer = await ctx.decodeAudioData(arr);
    crop.duration = crop.buffer.duration;
    crop.regions.forEach((r) => {
      r.end = Math.min(r.end || crop.duration, crop.duration);
      r.start = Math.max(0, Math.min(r.start, r.end - 0.1));
    });
    $("cropAudio").src = c.fullAudio;
    $("cropWaveLoading").classList.add("hidden");
    drawCropWave();
    renderCropRegions();
    renderCropList();
  } catch {
    $("cropWaveLoading").textContent = "Couldn't load the audio.";
  }
}

function cropWidth() {
  return $("cropWaveWrap").clientWidth || 800;
}
function secToX(sec) {
  return crop.duration ? (sec / crop.duration) * cropWidth() : 0;
}
function xToSec(x) {
  return crop.duration ? (x / cropWidth()) * crop.duration : 0;
}

function drawCropWave() {
  const canvas = $("cropWave");
  const W = cropWidth();
  const H = 140;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const data = crop.buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  const mid = H / 2;
  ctx.fillStyle = "rgba(91,155,255,0.5)";
  for (let x = 0; x < W; x++) {
    let min = 1,
      max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid * 0.9;
    const y2 = mid + max * mid * 0.9;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function renderCropRegions() {
  const host = $("cropRegions");
  host.innerHTML = "";
  crop.regions.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "crop-region" + (r.dirty ? " dirty" : "");
    el.style.left = secToX(r.start) + "px";
    el.style.width = Math.max(2, secToX(r.end) - secToX(r.start)) + "px";
    el.style.setProperty("--rc", r.color);
    el.dataset.idx = i;
    el.innerHTML =
      `<span class="crop-region-label">${escapeHtml(r.label)}</span>` +
      `<span class="crop-h crop-h-l" data-edge="start"></span>` +
      `<span class="crop-h crop-h-r" data-edge="end"></span>`;
    host.appendChild(el);
  });
}

function positionRegion(idx) {
  const el = $("cropRegions").children[idx];
  const r = crop.regions[idx];
  if (!el) return;
  el.style.left = secToX(r.start) + "px";
  el.style.width = Math.max(2, secToX(r.end) - secToX(r.start)) + "px";
  el.classList.add("dirty");
}

function renderCropList() {
  const host = $("cropList");
  host.innerHTML = "";
  crop.regions.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "crop-row";
    row.innerHTML =
      `<span class="crop-swatch" style="background:${r.color}"></span>` +
      `<span class="crop-row-label">${escapeHtml(r.label)}</span>` +
      `<span class="crop-row-time">${r.start.toFixed(2)}s – ${r.end.toFixed(
        2,
      )}s · ${(r.end - r.start).toFixed(2)}s</span>` +
      `<button type="button" class="btn btn-sm crop-play" data-idx="${i}">▶ Preview</button>` +
      (r.dirty ? `<span class="crop-dirty-tag">edited</span>` : "");
    host.appendChild(row);
  });
}

function initCropDrag() {
  const host = $("cropRegions");
  host.addEventListener("pointerdown", (e) => {
    const region = e.target.closest(".crop-region");
    if (!region) return;
    const idx = +region.dataset.idx;
    const edge = e.target.dataset.edge || "move";
    const r = crop.regions[idx];
    crop.drag = { idx, edge, x0: e.clientX, s0: r.start, e0: r.end };
    host.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  host.addEventListener("pointermove", (e) => {
    if (!crop.drag) return;
    const { idx, edge, x0, s0, e0 } = crop.drag;
    const r = crop.regions[idx];
    const dsec = xToSec(e.clientX - x0);
    const MIN = 0.15;
    if (edge === "start") {
      r.start = Math.max(0, Math.min(s0 + dsec, r.end - MIN));
    } else if (edge === "end") {
      r.end = Math.min(crop.duration, Math.max(e0 + dsec, r.start + MIN));
    } else {
      const len = e0 - s0;
      let ns = Math.max(0, Math.min(s0 + dsec, crop.duration - len));
      r.start = ns;
      r.end = ns + len;
    }
    r.dirty = true;
    positionRegion(idx);
    renderCropList();
    $("cropSave").disabled = !crop.regions.some((x) => x.dirty);
  });
  const endDrag = () => {
    if (crop.drag) {
      renderCropRegions();
      crop.drag = null;
    }
  };
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);
}

function playCropRegion(idx) {
  const r = crop.regions[idx];
  const a = $("cropAudio");
  stopCropPlay();
  try {
    a.currentTime = r.start;
    a.play();
    crop.playTimer = setInterval(() => {
      if (a.currentTime >= r.end) stopCropPlay();
    }, 30);
  } catch {
    /* ignore */
  }
}
function stopCropPlay() {
  const a = $("cropAudio");
  a.pause();
  if (crop.playTimer) {
    clearInterval(crop.playTimer);
    crop.playTimer = null;
  }
}

// Slice the decoded full audio to [start,end] and encode a 16-bit PCM mono WAV blob (no deps).
function encodeRegionWav(start, end) {
  const buf = crop.buffer;
  const sr = buf.sampleRate;
  const s0 = Math.max(0, Math.floor(start * sr));
  const s1 = Math.min(buf.length, Math.floor(end * sr));
  const n = Math.max(1, s1 - s0);
  const ch = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += (d[s0 + i] || 0) / ch;
  }
  const dataSize = n * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const wr = (off, str) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i));
  };
  wr(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wr(36, "data");
  dv.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, out[i]));
    dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function saveCropChanges() {
  const dirty = crop.regions.filter((r) => r.dirty);
  if (!dirty.length || !crop.buffer) return;
  stopCropPlay();
  $("cropSave").disabled = true;
  $("cropStatus").textContent = `Saving ${dirty.length} clip${
    dirty.length === 1 ? "" : "s"
  } (re-transcribing)…`;
  let failed = 0;
  for (const r of dirty) {
    try {
      const blob = encodeRegionWav(r.start, r.end);
      const fd = new FormData();
      fd.append("file", blob, `${r.key}.wav`);
      fd.append("start", String(r.start));
      fd.append("end", String(r.end));
      const resp = await fetch(
        `/api/projects/${state.currentProjectId}/characters/${crop.charId}/moods/${r.key}/clip`,
        { method: "POST", body: fd },
      );
      const data = await resp.json();
      if (data && data.ok) r.dirty = false;
      else failed++;
    } catch {
      failed++;
    }
  }
  $("cropStatus").textContent = failed
    ? `Saved with ${failed} error${failed === 1 ? "" : "s"}.`
    : "Saved.";
  renderCropList();
  $("cropSave").disabled = !crop.regions.some((r) => r.dirty);
  await refreshLibrary();
  setLibTab("characters");
}

function closeCropEditor() {
  stopCropPlay();
  closeModal("cropModal");
}

function buildMediaCard(m) {
  const card = document.createElement("article");
  card.className = "media-card";
  card.dataset.id = m.id;
  card.dataset.type = m.type;
  const when = (m.created || "").replace("T", " ").replace(/(\+.*|Z)$/, "");
  const promptTxt = (m.meta && m.meta.prompt) || "";

  if (m.type === "voice") {
    card.classList.add("voice-card");
    card.innerHTML =
      `<div class="mc-voicehead"><span class="mc-badge">🗣 Voice</span></div>` +
      `<div class="mc-audio">${
        m.audio ? `<audio controls preload="none" src="${m.audio}"></audio>` : ""
      }</div>` +
      `<div class="mc-foot">` +
      `<span class="mc-when">${escapeHtml(when)}</span>` +
      `<div class="mc-actions">` +
      (m.audio ? `<a class="mc-act" download href="${m.audio}" title="Download audio">⬇ Audio</a>` : "") +
      `<button class="mc-act mc-del" data-act="delete" title="Delete">${TRASH_SVG}</button>` +
      `</div></div>` +
      (promptTxt ? `<p class="mc-prompt">${escapeHtml(promptTxt)}</p>` : "");
    wireMediaCard(card, m);
    return card;
  }

  const frameImg = m.lastFrame
    ? `<img class="mc-frame hidden" data-pane="frame" src="${m.lastFrame}" alt="last frame" />`
    : `<div class="mc-frame mc-frame-empty hidden" data-pane="frame">No last frame yet</div>`;
  card.innerHTML =
    `<div class="mc-media">` +
    `<div class="mc-tabs">` +
    `<button class="mc-tab active" data-mtab="video" type="button">▶ Video</button>` +
    `<button class="mc-tab" data-mtab="frame" type="button">🖼 Last frame</button>` +
    `</div>` +
    `<div class="mc-stage">` +
    (m.video
      ? `<video class="mc-video" data-pane="video" controls preload="metadata" ${
          m.lastFrame ? `poster="${m.lastFrame}"` : ""
        } src="${m.video}"></video>`
      : `<div class="mc-video mc-frame-empty" data-pane="video">No video</div>`) +
    frameImg +
    `</div></div>` +
    `<div class="mc-audio">${
      m.audio ? `<audio controls preload="none" src="${m.audio}"></audio>` : ""
    }</div>` +
    `<div class="mc-foot">` +
    `<span class="mc-when">${escapeHtml(when)}</span>` +
    `<div class="mc-actions">` +
    (m.video ? `<a class="mc-act" download href="${m.video}" title="Download video">⬇ Video</a>` : "") +
    (m.audio ? `<a class="mc-act" download href="${m.audio}" title="Download audio">⬇ Audio</a>` : "") +
    (m.lastFrame ? `<a class="mc-act" download href="${m.lastFrame}" title="Download last frame">⬇ Frame</a>` : "") +
    (m.video ? `<button class="mc-act" data-act="extend" title="Extend this video — opens the studio with it on the timeline at double length">⧉ Extend</button>` : "") +
    (m.lastFrame ? `<button class="mc-act" data-act="reuse" title="Use last frame in a new generation">↻ Reuse frame</button>` : "") +
    `<button class="mc-act mc-del" data-act="delete" title="Delete">${TRASH_SVG}</button>` +
    `</div></div>` +
    (promptTxt ? `<p class="mc-prompt">${escapeHtml(promptTxt)}</p>` : "");
  wireMediaCard(card, m);
  return card;
}

function wireMediaCard(card, m) {
  card.querySelectorAll(".mc-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const which = tab.dataset.mtab;
      card.querySelectorAll(".mc-tab").forEach((t) =>
        t.classList.toggle("active", t === tab),
      );
      card.querySelectorAll("[data-pane]").forEach((p) =>
        p.classList.toggle("hidden", p.dataset.pane !== which),
      );
    });
  });
  const delBtn = card.querySelector('[data-act="delete"]');
  if (delBtn) delBtn.addEventListener("click", () => deleteMedia(m.id));
  const reuseBtn = card.querySelector('[data-act="reuse"]');
  if (reuseBtn && m.lastFrame)
    reuseBtn.addEventListener("click", () => reuseLastFrame(m.lastFrame));
  const extendBtn = card.querySelector('[data-act="extend"]');
  if (extendBtn && m.video)
    extendBtn.addEventListener("click", () => extendVideo(m));
}

async function deleteMedia(mediaId) {
  if (!confirm("Delete this artifact and its files?")) return;
  await api(`/api/projects/${state.currentProjectId}/media/${mediaId}`, {
    method: "DELETE",
  });
  refreshLibrary();
}

// Pull the stored last-frame image, push it into the engine input bucket as a start image,
// then enter the studio with that shot queued up for the next generation.
async function reuseLastFrame(url) {
  try {
    const blob = await fetch(url).then((r) => r.blob());
    const fd = new FormData();
    fd.append("file", blob, "last_frame.png");
    const res = await fetch("/api/upload-image", { method: "POST", body: fd }).then(
      (r) => r.json(),
    );
    enterStudio();
    addSegment("image", "Continue from the previous shot.", {
      imageFile: res.imageFile,
      imageB64: res.imageB64,
    });
  } catch {
    alert("Could not reuse that frame.");
  }
}

// Enter the studio for the current project (from library or a project card).
function enterStudio() {
  setScreen("studio");
  setPhase("setup");
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

/* Scale main segment lengths proportionally so they exactly fill the total frame count.
   Locked segments (video shots anchored to a real clip length) keep their length; the
   remaining frames are shared among the flexible (text/image) shots. When there is no
   flexible shot to absorb the remainder, everything is scaled proportionally (fallback). */
function fitToTotal() {
  const n = state.segments.length;
  if (n === 0) return;
  const total = frames();

  const locked = state.segments.filter((s) => s.lockLen);
  const flex = state.segments.filter((s) => !s.lockLen);
  const lockedSum = locked.reduce((a, s) => a + (s.length || 0), 0);
  const remainder = total - lockedSum;

  // Only honor the locks when the flexible shots can still fill the remaining space.
  if (locked.length && flex.length && remainder >= MIN_LEN * flex.length) {
    let sum = flex.reduce((a, s) => a + (s.length || 0), 0);
    if (sum <= 0) {
      const per = Math.floor(remainder / flex.length);
      flex.forEach((s) => (s.length = per));
      sum = per * flex.length;
    }
    const scale = remainder / sum;
    flex.forEach(
      (s) => (s.length = Math.max(MIN_LEN, Math.round(s.length * scale))),
    );
    const ns = flex.reduce((a, s) => a + s.length, 0);
    const last = flex[flex.length - 1];
    last.length = Math.max(MIN_LEN, last.length + (remainder - ns));
    updateTimelineInfo();
    return;
  }
  // A lone locked video (no flexible shot): keep its real length, leaving a generated
  // tail after it if the timeline is longer — that tail is the extension to be rendered.
  if (locked.length && !flex.length && lockedSum <= total) {
    updateTimelineInfo();
    return;
  }

  // Fallback: proportional scale of everything to fill the timeline.
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
  // A video shot anchors to its real clip length (extra.length); everything else takes an
  // even share of the timeline and is then rescaled to fit by fitToTotal.
  s.length = extra.length
    ? Math.max(MIN_LEN, Math.round(extra.length))
    : Math.max(MIN_LEN, Math.round(total / (state.segments.length + 1)));
  state.segments.push(s);
  fitToTotal();
  renderTimeline();
  selectSegment(s.id);
  refreshPreview();
  return s;
}

function removeSegment(id) {
  state.segments = state.segments.filter((s) => s.id !== id);
  if (state.selectedId === id) {
    state.selectedId = null;
    $("segEditor").classList.add("hidden");
    $("globalView").classList.remove("hidden");
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
      (s.type === "video" ? " video" : "") +
      (s.id === state.selectedId ? " selected" : "");
    block.dataset.id = s.id;
    block.style.left = `${(start / total) * 100}%`;
    block.style.width = `${(s.length / total) * 100}%`;
    const kind =
      s.type === "image" ? "IMG" : s.type === "video" ? "VIDEO" : "TEXT";
    // Image shots (and now video shots) render as a repeating filmstrip of the reference
    // thumbnail so the timeline reads like a frame sequence rather than just prompt text.
    const film = s.type === "video" ? s.poster : s.imageB64;
    block.innerHTML =
      (film
        ? `<div class="b-film" style="background-image:url('${film}')"></div>`
        : "") +
      `<div class="b-head"><span class="b-kind">${kind}</span></div>` +
      `<div class="b-prompt" title="${escapeHtml(s.prompt || "")}">${escapeHtml(s.prompt || "(no prompt)")}</div>` +
      delBtnHtml("Delete shot") +
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
    "Add an IC-LoRA video for camera / video-to-video guidance",
    "IC-LoRA off",
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
      delBtnHtml("Delete clip") +
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
  // Delete icon (only present while selected) — remove and stop.
  if (e.target.closest("[data-del]")) {
    e.stopPropagation();
    removeSegment(id);
    return;
  }
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
    // Tap (no drag): toggle — select, or deselect back to global settings.
    if (!moved) {
      if (state.selectedId === id) showGlobalView();
      else selectSegment(id);
    }
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
  // Delete icon (only present while selected) — remove and stop.
  if (e.target.closest("[data-del]")) {
    e.stopPropagation();
    removeClip(id);
    return;
  }
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
    // Tap (no drag): toggle — select, or deselect back to global settings.
    if (!moved) {
      if (state.selectedClipId === id) showGlobalView();
      else selectClip(id);
    }
    renderTimeline();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

/* ------------------------------- side panel: view switching ------------------------------- */
// The right panel shows global settings by default and swaps to the shot/clip
// editor while a timeline item is selected. Deselecting returns to global.
function showGlobalView() {
  state.selectedId = null;
  state.selectedClipId = null;
  $("segEditor").classList.add("hidden");
  $("clipEditor").classList.add("hidden");
  $("globalView").classList.remove("hidden");
  renderTimeline();
}

/* ------------------------------- main-shot editor ------------------------------- */
function selectSegment(id) {
  state.selectedClipId = null;
  $("clipEditor").classList.add("hidden");
  $("globalView").classList.add("hidden");
  state.selectedId = id;
  const s = state.segments.find((x) => x.id === id);
  if (!s) return;
  renderTimeline();
  const ed = $("segEditor");
  ed.classList.remove("hidden");
  $("segEditorTitle").textContent =
    s.type === "image"
      ? "Image shot"
      : s.type === "video"
        ? "Video shot"
        : "Text shot";
  $("segPrompt").value = s.prompt || "";
  const wrap = $("segImageWrap");
  if (s.type === "image" && s.imageB64) {
    wrap.classList.remove("hidden");
    $("segImage").src = s.imageB64;
    $("segReplaceImg").classList.remove("hidden");
  } else if (s.type === "video" && s.poster) {
    // Video shots preview the poster thumbnail; there is no in-place replace (delete + re-add).
    wrap.classList.remove("hidden");
    $("segImage").src = s.poster;
    $("segReplaceImg").classList.add("hidden");
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
  $("globalView").classList.add("hidden");
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
    $("globalView").classList.remove("hidden");
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

// Add a video to the MAIN track as a shot — the "extend a video" path. The shot anchors to
// the clip's real length (lockLen), so any timeline beyond it is generated as a continuation.
// opts.doubleDuration stretches the timeline to 2× the clip first (used by Extend).
function addVideoShot(res, opts = {}) {
  probeDuration(res.url, "video", (dur) => {
    const fps = curFps();
    const len = dur > 0 ? Math.round(dur * fps) : Math.round(2 * fps);
    if (opts.doubleDuration && dur > 0) {
      const maxDur = parseInt($("duration").max) || 60;
      $("duration").value = Math.min(maxDur, Math.max(1, Math.round(dur * 2)));
    }
    const seg = addSegment("video", "", {
      imageFile: res.file,
      videoUrl: res.url,
      name: res.name,
      lockLen: true,
      length: len,
    });
    captureVideoPoster(res.url, (poster) => {
      seg.poster = poster;
      renderTimeline();
      if (state.selectedId === seg.id) selectSegment(seg.id);
    });
  });
}

// Clear the timeline (shots + clips) so a flow can start from a blank studio.
function resetTimeline() {
  state.segments = [];
  state.audioClips = [];
  state.videoClips = [];
  state.selectedId = null;
  state.selectedClipId = null;
  $("segEditor").classList.add("hidden");
  $("clipEditor").classList.add("hidden");
  $("globalView").classList.remove("hidden");
}

// Extend a generated video: open a fresh studio timeline with the source video on the main
// track and the duration set to double the clip, so the second half renders as a continuation.
async function extendVideo(m) {
  if (!m.video) return;
  try {
    const blob = await fetch(m.video).then((r) => r.blob());
    const fd = new FormData();
    fd.append("file", blob, `${m.name || "clip"}.mp4`);
    const res = await fetch("/api/upload-media", {
      method: "POST",
      body: fd,
    }).then((r) => r.json());
    enterStudio();
    resetTimeline();
    addVideoShot(res, { doubleDuration: true });
  } catch {
    alert("Could not load that video to extend.");
  }
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
      if (s.type === "video" && s.videoUrl)
        return {
          kind: "video",
          clip: {
            id: s.id,
            url: s.videoUrl,
            start: cursor,
            length: s.length,
            trimStart: s.trimStart || 0,
          },
        };
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
    // A main-track video shot is passed as a video guide: LTX Director reads the engine
    // input filename from `imageFile` for both image and video segments (type discriminates).
    if (s.type === "video" && s.imageFile) {
      seg.imageFile = s.imageFile;
      seg.trimStart = s.trimStart || 0;
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
    // Render the full timeline length, not just the covered shots — a video shot that
    // occupies only the first part leaves a generated tail (this is how "extend" works).
    normalDurationFrames: Math.max(cursor, frames()),
    segments,
    motionSegments,
    audioSegments,
  };
}

async function generate() {
  const hasAudioClips = state.audioClips.length > 0;
  const lip = $("lipSync").checked;
  const params = {
    project_id: state.currentProjectId,
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
    // Always honor the user's explicit "Inpaint audio gaps" choice. Previously lip-sync
    // hard-forced this true, which made the checkbox a no-op and filled the gaps regardless.
    inpaint_audio: $("inpaintAudio").checked,
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
      onComplete(m.video_url, m);
      break;
    case "character_complete":
      // A character's reference video finished (or errored) — refresh the library so the card flips
      // out of its generating state. Only if it belongs to the project we're currently viewing.
      if (state.currentProjectId === m.project_id) {
        refreshLibrary().then(() => {
          if (state.screen === "library") setLibTab("characters");
        });
      }
      break;
    case "error":
      showGenError(m.message || "Error");
      break;
    case "download":
      updateDownload(m);
      break;
  }
}

function onComplete(url, msg) {
  state.generating = false;
  if (url) {
    state.hasResult = true;
    // Remember which project media item this result was filed into, and reveal the
    // "Project library" action so the user can jump back to the grid.
    state.lastMediaId = (msg && msg.media && msg.media.id) || null;
    $("backToLibrary").classList.toggle(
      "hidden",
      !(state.currentProjectId && state.lastMediaId),
    );
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
    // The last frame is produced by the workflow itself (ImageFromBatch → SaveImage) and filed
    // into the project media item server-side, so there's nothing to capture on the client.
  } else {
    showGenError(
      "Generation finished but produced no video. Check the engine console for details.",
    );
  }
}

/* ------------------------------- models ------------------------------- */
function allowLocate() {
  // RunPod is download-only; desktop/repo keep "Locate existing file". Defaults to allowed.
  return state.config?.environment?.allow_locate !== false;
}

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
  const s = await refreshTtsStatus();
  if (s && s.installing) startTtsPolling(); // resume watching an install started earlier
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
          ${allowLocate() ? `<button class="btn btn-sm loc">Locate…</button>` : ""}`
          }
        </div>
      </div>
      <div class="bar hidden"><div class="bar-fill"></div></div>
      <div class="model-sub dlmsg"></div>`;
    if (!m.present) {
      item.querySelector(".dl").addEventListener("click", () => download(m.id));
      const locBtn = item.querySelector(".loc");
      if (locBtn) locBtn.addEventListener("click", () => locate(m.id));
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
  const path = await pickFile("Select the model file on your disk / external drive");
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

/* ------------------------------- voice / TTS ------------------------------- */
// Pending (not-yet-committed) generated speech lives here so the user can preview
// and regenerate before dropping it on the timeline. Voices are always cloned (zero-shot) from a
// reference clip: `refSource` is 'character' (a project character's mood clip) or 'upload' (a file
// the user picks); `refFile` is the resolved engine-input path of that clip. The reference transcript
// lives in the visible, editable #ttsRefText box — the model clones the voice USING that text.
const tts = { pending: null, refFile: null, installed: false, refSource: "character" };

function openAudioModal() {
  switchAudioTab("upload");
  refreshTtsStatus();
  openModal("audioModal");
}

function switchAudioTab(name) {
  document
    .querySelectorAll("#audioTabs .tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document
    .querySelectorAll("#audioModal .tab-pane")
    .forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
  if (name !== "speak") return;
  // "Clone a voice" — reference comes from a project character's mood clip, or an uploaded clip.
  populateCharacterRef();
  const hasChars = (state.characters || []).some(
    (c) => c.status === "ready" && (c.moods || []).some((m) => m.clip),
  );
  setRefSource(hasChars ? "character" : "upload");
  resetTtsPreview();
  refreshTtsStatus();
}

// Toggle the reference source: a character's mood clip vs an uploaded file.
function setRefSource(src) {
  tts.refSource = src;
  document
    .querySelectorAll("#ttsRefSource .ref-src-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.src === src));
  $("ttsRefChar").classList.toggle("hidden", src !== "character");
  $("ttsRefUpload").classList.toggle("hidden", src !== "upload");
  tts.refFile = null;
  if (src === "character") {
    selectCharacterMood();
  } else {
    $("ttsRefName").textContent = "No reference selected";
    $("ttsRefText").value = "";
  }
}

function populateCharacterRef() {
  const csel = $("ttsCharSelect");
  const ready = (state.characters || []).filter(
    (c) => c.status === "ready" && (c.moods || []).some((m) => m.clip),
  );
  csel.innerHTML = "";
  if (!ready.length) {
    csel.innerHTML = '<option value="">No characters yet…</option>';
    $("ttsMoodSelect").innerHTML = "";
    return;
  }
  ready.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name || "Character";
    csel.appendChild(o);
  });
  populateMoodOptions();
}

function populateMoodOptions() {
  const c = (state.characters || []).find((x) => x.id === $("ttsCharSelect").value);
  const msel = $("ttsMoodSelect");
  msel.innerHTML = "";
  ((c && c.moods) || [])
    .filter((m) => m.clip)
    .forEach((m) => {
      const o = document.createElement("option");
      o.value = m.key;
      o.textContent = m.label || m.key;
      msel.appendChild(o);
    });
}

// Load the selected character+mood clip into the engine input bucket and prefill the transcript.
async function selectCharacterMood() {
  if (tts.refSource !== "character") return;
  const cid = $("ttsCharSelect").value;
  const mood = $("ttsMoodSelect").value;
  tts.refFile = null;
  if (!cid || !mood || !state.currentProjectId) return;
  $("ttsStatus").textContent = "Loading reference voice…";
  try {
    const res = await api(
      `/api/projects/${state.currentProjectId}/characters/${cid}/use-mood`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mood }),
      },
    );
    if (res.ok) {
      tts.refFile = res.file;
      $("ttsRefText").value = res.ref_text || "";
      // Prefill the tone/emotion to match the chosen mood (reinforces the reference's delivery).
      $("ttsInstruct").value = res.tone || "";
      $("ttsStatus").textContent = res.ref_text
        ? ""
        : "No transcript stored — type what the clip says below.";
    } else {
      $("ttsStatus").textContent = res.error || "Couldn't load that mood clip.";
    }
  } catch {
    $("ttsStatus").textContent = "Couldn't load that mood clip.";
  }
}

function populateTtsLangs(langs) {
  const sel = $("ttsLang");
  if (!sel || sel.options.length) return; // populate once
  (langs && langs.length ? langs : ["English"]).forEach((l) => {
    const o = document.createElement("option");
    o.value = l;
    o.textContent = l;
    sel.appendChild(o);
  });
}

async function refreshTtsStatus() {
  let s = null;
  try {
    s = await api("/api/tts/status");
  } catch {
    s = null;
  }
  tts.installed = !!(s && s.installed);
  populateTtsLangs(s && s.languages);
  $("ttsUnavailable").classList.toggle("hidden", tts.installed);
  $("ttsForm").classList.toggle("hidden", !tts.installed);
  updateEngineStatus(s);
  return s;
}

function updateEngineStatus(s) {
  const el = $("ttsEngineStatus");
  const btn = $("ttsInstallBtn");
  const bar = $("ttsInstallBar");
  const label = $("ttsInstallLabel");
  const caption = $("ttsSetupLog");
  if (!el) return;
  if (!s) {
    el.textContent = "Status unavailable.";
    return;
  }
  const prog = s.install_progress;

  if (s.installing) {
    const pct = prog && typeof prog.pct === "number" ? prog.pct : 0;
    const stage = prog && prog.stage ? prog.stage : "";
    if (btn) btn.disabled = true;
    if (btn) btn.classList.add("installing");
    if (bar) bar.style.width = pct + "%";
    if (label)
      label.textContent = `Installing… ${stage ? stage + " " : ""}(${pct}%)`;
    if (caption) {
      caption.classList.remove("hidden");
      caption.textContent =
        (prog && prog.message) ||
        "A terminal window is running the install — watch it for full logs.";
    }
    el.textContent = "Installing…";
    return;
  }

  if (btn) btn.classList.remove("installing");
  if (btn) btn.disabled = false;

  if (s.installed) {
    if (bar) bar.style.width = "100%";
    if (label) label.textContent = "Reinstall / repair";
    if (caption) caption.classList.add("hidden");
    el.textContent = `Installed ✓  (${s.install_dir})${s.running ? " · running" : ""}`;
  } else if (prog && prog.stage === "error") {
    if (bar) bar.style.width = "0";
    if (label) label.textContent = "Install failed — retry";
    if (caption) {
      caption.classList.remove("hidden");
      caption.textContent = `${prog.message || "Install failed"} (see the terminal window).`;
    }
    el.textContent = "Install failed.";
  } else {
    if (bar) bar.style.width = "0";
    if (label) label.textContent = "Install voice engine";
    if (caption) caption.classList.add("hidden");
    el.textContent = "Not installed.";
  }
  const dir = $("ttsInstallDir");
  if (dir && !dir.value && s.install_dir) dir.placeholder = s.install_dir;
}

function pickRefVoice() {
  uploadMedia("audio", async (res) => {
    tts.refFile = res.file;
    $("ttsRefName").textContent = res.name;
    // Auto-fill the transcript, but keep it VISIBLE and editable: the model clones the voice USING
    // this text, so a wrong/missing transcript (e.g. a clip in another language) garbles the output.
    // The user needs to see and fix it — removing this box is exactly what broke cloning.
    $("ttsRefText").value = "";
    $("ttsRefText").placeholder = "Transcribing…";
    $("ttsStatus").textContent = "Analyzing reference…";
    try {
      const t = await api("/api/tts/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: res.file }),
      });
      $("ttsRefText").value = t.ok ? t.text || "" : "";
      $("ttsStatus").textContent = t.ok
        ? ""
        : "Couldn't auto-transcribe — type what the clip says below.";
    } catch {
      $("ttsStatus").textContent =
        "Couldn't auto-transcribe — type what the clip says below.";
    } finally {
      $("ttsRefText").placeholder = "Transcript of the reference clip…";
    }
  });
}

// Insert `text` at the textarea's caret (replacing any selection), keeping focus + caret sensible.
function insertAtCursor(el, text) {
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, s);
  // add a leading space if we're mid-sentence and there isn't one already
  const pad = before && !/\s$/.test(before) ? " " : "";
  el.value = before + pad + text + el.value.slice(e);
  const pos = s + pad.length + text.length;
  el.focus();
  el.setSelectionRange(pos, pos);
}

// Wrap the current selection with open/close tags (or insert the empty pair at the caret).
function wrapSelection(el, open, close) {
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  const sel = el.value.slice(s, e);
  el.value = el.value.slice(0, s) + open + sel + close + el.value.slice(e);
  const pos = sel ? s + open.length + sel.length + close.length : s + open.length;
  el.focus();
  el.setSelectionRange(pos, pos);
}

// Reset the preview column to its empty state, discarding any un-committed result.
function resetTtsPreview() {
  tts.pending = null;
  $("ttsResult").classList.add("hidden");
  $("ttsShimmer").classList.add("hidden");
  $("ttsPreviewEmpty").classList.remove("hidden");
  $("ttsPreview").removeAttribute("src");
  $("ttsPreviewDur").textContent = "";
  $("ttsRegen").classList.add("hidden");
  $("ttsAdd").disabled = true;
}

async function ttsGenerate() {
  const text = $("ttsText").value.trim();
  if (!text) {
    $("ttsStatus").textContent = "Enter the dialog to speak.";
    return;
  }
  const instruct = $("ttsInstruct").value.trim();
  const refText = $("ttsRefText").value.trim();
  if (!tts.refFile) {
    $("ttsStatus").textContent =
      tts.refSource === "character"
        ? "Pick a character and mood first."
        : "Choose a reference clip first.";
    return;
  }
  // Cloning without a tone/instruction uses zero-shot, which REQUIRES the reference transcript —
  // an empty one makes the model produce garbled/foreign-sounding speech. Block it with a clear nudge.
  if (!instruct && !refText) {
    $("ttsStatus").textContent =
      "Add what the reference clip says (the box above) — it's needed to clone the voice.";
    $("ttsRefText").focus();
    return;
  }
  const body = {
    project_id: state.currentProjectId,
    text,
    mode: "clone",
    instruct,
    ref_text: refText,
    ref_file: tts.refFile,
    speed: parseFloat($("ttsSpeed").value) || 1.0,
  };
  // Enter the generating state: clear any previous result from the preview and show the shimmer.
  tts.pending = null;
  $("ttsPreviewEmpty").classList.add("hidden");
  $("ttsResult").classList.add("hidden");
  $("ttsRegen").classList.add("hidden");
  $("ttsShimmer").classList.remove("hidden");
  $("ttsAdd").disabled = true;
  $("ttsGenerate").disabled = true;
  $("ttsStatus").textContent =
    "Generating… first run loads the model, please wait.";
  try {
    const res = await api("/api/tts/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("ttsShimmer").classList.add("hidden");
    if (res.ok) {
      tts.pending = res;
      $("ttsPreview").src = res.url;
      $("ttsPreviewDur").textContent =
        typeof res.duration === "number" ? res.duration.toFixed(1) + "s" : "";
      $("ttsResult").classList.remove("hidden");
      $("ttsRegen").classList.remove("hidden");
      $("ttsAdd").disabled = false;
      $("ttsStatus").textContent = "";
    } else {
      $("ttsPreviewEmpty").classList.remove("hidden");
      $("ttsStatus").textContent = res.error || "Speech generation failed.";
    }
  } catch {
    $("ttsShimmer").classList.add("hidden");
    $("ttsPreviewEmpty").classList.remove("hidden");
    $("ttsStatus").textContent = "Speech generation failed.";
  } finally {
    $("ttsGenerate").disabled = false;
  }
}

function ttsAddToTimeline() {
  if (!tts.pending) return;
  addMediaClip("audio", tts.pending); // adds as a voice clip (voice=true)
  resetTtsPreview();
  closeModal("audioModal");
}

async function installVoiceEngine() {
  const dir = $("ttsInstallDir").value.trim();
  $("ttsInstallBtn").disabled = true;
  const caption = $("ttsSetupLog");
  caption.classList.remove("hidden");
  caption.textContent = "Opening the installer terminal…";
  let res = null;
  try {
    res = await api("/api/tts/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dir ? { install_dir: dir } : {}),
    });
  } catch {
    res = null;
  }
  if (!res || !res.launched) {
    caption.textContent =
      (res && res.message) || "Could not open the installer terminal.";
    $("ttsInstallBtn").disabled = false;
    return;
  }
  caption.textContent =
    "A terminal window is running the install — watch it for full logs.";
  startTtsPolling();
}

// Poll /api/tts/status while an install runs in the external terminal (no WS stream anymore).
// Stops once installed or the installer reports an error; a safety cap avoids polling forever if
// the user closes the terminal without finishing.
let ttsPollTimer = null;
let ttsPollLeft = 0;
function startTtsPolling() {
  ttsPollLeft = 900; // ~30 min at 2s/tick
  if (ttsPollTimer) return;
  ttsPollTimer = setInterval(async () => {
    const s = await refreshTtsStatus();
    const errored = s && s.install_progress && s.install_progress.stage === "error";
    if (!s || s.installed || errored || --ttsPollLeft <= 0) stopTtsPolling();
  }, 2000);
}
function stopTtsPolling() {
  if (ttsPollTimer) {
    clearInterval(ttsPollTimer);
    ttsPollTimer = null;
  }
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
  $("addAudio").addEventListener("click", openAudioModal);
  // + Video adds to the MAIN track (for extending a video); + IC-LoRA adds to the
  // separate IC-LoRA/motion lane (camera / video-to-video guidance).
  $("addVideo").addEventListener("click", () =>
    uploadMedia("video", (res) => addVideoShot(res)),
  );
  $("addMotion").addEventListener("click", () =>
    uploadMedia("video", (res) => addMediaClip("video", res)),
  );

  // Add-audio modal (upload + generate-speech tabs)
  $("closeAudio").addEventListener("click", () => closeModal("audioModal"));
  document.querySelectorAll("#audioTabs .tab").forEach((t) =>
    t.addEventListener("click", () => switchAudioTab(t.dataset.tab)),
  );
  $("audioUploadBtn").addEventListener("click", () =>
    uploadMedia("audio", (res) => {
      addMediaClip("audio", res);
      closeModal("audioModal");
    }),
  );
  $("ttsGotoInstall").addEventListener("click", () => {
    closeModal("audioModal");
    openModels();
  });
  $("ttsRefBtn").addEventListener("click", pickRefVoice);
  document.querySelectorAll("#ttsRefSource .ref-src-btn").forEach((b) =>
    b.addEventListener("click", () => setRefSource(b.dataset.src)),
  );
  $("ttsCharSelect").addEventListener("change", () => {
    populateMoodOptions();
    selectCharacterMood();
  });
  $("ttsMoodSelect").addEventListener("change", selectCharacterMood);
  $("ttsGenerate").addEventListener("click", ttsGenerate);
  $("ttsRegen").addEventListener("click", ttsGenerate);
  $("ttsAdd").addEventListener("click", ttsAddToTimeline);
  $("ttsInstallBtn").addEventListener("click", installVoiceEngine);
  $("ttsSpeed").addEventListener("input", (e) => {
    $("ttsSpeedVal").textContent = parseFloat(e.target.value).toFixed(1);
  });
  // Sound-insert chips: drop a paralinguistic token at the cursor, or wrap the selection.
  document.querySelectorAll("#ttsInserts .chip").forEach((c) =>
    c.addEventListener("click", () => {
      if (c.dataset.ins) insertAtCursor($("ttsText"), c.dataset.ins);
      else if (c.dataset.wrap) {
        const [open, close] = c.dataset.wrap.split("|");
        wrapSelection($("ttsText"), open, close);
      }
    }),
  );
  // Mood chips: fill the (free-text) tone field.
  document.querySelectorAll("#ttsEmotions .chip").forEach((c) =>
    c.addEventListener("click", () => {
      $("ttsInstruct").value = c.dataset.emo || "";
      $("ttsInstruct").focus();
    }),
  );
  $("generate").addEventListener("click", generate);
  $("interrupt").addEventListener("click", () =>
    api("/api/interrupt", { method: "POST" }),
  );

  $("openModels").addEventListener("click", openModels);
  $("closeModels").addEventListener("click", () => {
    stopTtsPolling();
    closeModal("modelsModal");
  });
  $("openAdvanced").addEventListener("click", () => openModal("advancedModal"));
  $("closeAdvanced").addEventListener("click", () =>
    closeModal("advancedModal"),
  );

  // Server-side folder browser (RunPod)
  $("closeFolder").addEventListener("click", () => fsClose(""));
  $("fsMkdir").addEventListener("click", fsMkdir);
  $("fsUse").addEventListener("click", () => fsClose(fsBrowser.path));
  $("fsNewName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); fsMkdir(); }
  });
  // click on backdrop closes the modal
  document.querySelectorAll(".modal").forEach((m) =>
    m.addEventListener("pointerdown", (e) => {
      if (e.target !== m) return;
      if (m.id === "folderModal") fsClose(""); // resolve the pending pickDir promise
      else closeModal(m.id);
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
  $("segClose").addEventListener("click", showGlobalView);
  $("segReplaceImg").addEventListener("click", replaceImage);

  // clip editor
  $("clipClose").addEventListener("click", showGlobalView);
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
  $("backToLibrary").addEventListener("click", () => {
    $("video").removeAttribute("src");
    state.hasResult = false;
    refreshLibrary();
    setScreen("library");
  });
  $("newVideo").addEventListener("click", () => {
    $("video").removeAttribute("src");
    state.hasResult = false;
    setPhase("setup");
  });

  // workspace / library navigation
  $("brandHome").addEventListener("click", () => {
    loadProjects();
    setScreen("projects");
  });
  $("crumbProjects").addEventListener("click", () => {
    loadProjects();
    setScreen("projects");
  });
  // The project name in the breadcrumb is a "back to this project's media" control — used from
  // the studio it returns to the library grid rather than all the way out to the workspace.
  $("crumbProject").addEventListener("click", () => {
    if (!state.currentProjectId) return;
    refreshLibrary();
    setScreen("library");
  });
  $("newProject").addEventListener("click", newProject);
  $("newProjectEmpty").addEventListener("click", newProject);
  $("openExisting").addEventListener("click", openExisting);
  $("newGeneration").addEventListener("click", enterStudio);
  $("newGenerationEmpty").addEventListener("click", enterStudio);
  $("libRename").addEventListener("click", renameCurrentProject);
  // Library sub-tabs + characters
  document.querySelectorAll("#libTabs .lib-tab").forEach((t) =>
    t.addEventListener("click", () => setLibTab(t.dataset.libtab)),
  );
  $("newCharacter").addEventListener("click", openCharacterModal);
  $("newCharacterEmpty").addEventListener("click", openCharacterModal);
  $("closeCharacter").addEventListener("click", () => closeModal("characterModal"));
  $("charGenerate").addEventListener("click", createCharacter);
  // Mood-clip crop editor
  $("closeCrop").addEventListener("click", closeCropEditor);
  $("cropSave").addEventListener("click", saveCropChanges);
  $("cropList").addEventListener("click", (e) => {
    const b = e.target.closest(".crop-play");
    if (b) playCropRegion(+b.dataset.idx);
  });
  initCropDrag();
}

async function renameCurrentProject() {
  if (!state.currentProjectId) return;
  const name = (
    prompt("Rename project:", state.currentProject.name || "") || ""
  ).trim();
  if (!name) return;
  await api(`/api/projects/${state.currentProjectId}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  state.currentProject.name = name;
  $("libTitle").textContent = name;
  $("crumbProject").textContent = name;
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
