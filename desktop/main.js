// CHNMagicAI desktop shell.
//
// Flow: spawn the Python launcher (backend/launcher.py) → show a splash with a progress bar fed by
// the launcher's stdout (AIVB_PHASE|pct|msg + [setup]/[launcher] lines) → poll /healthz → when ready,
// open the main window on http://127.0.0.1:<port>/ and close the splash. The FastAPI server stays
// bound, so the same URL is still reachable from a normal browser (parity with RunPod).
//
// The heavy first-run dependency install still runs inside the launcher behind the splash.

const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

// --- ports: overridable so the dev build never collides with a live app on 8188 ---
const APP_PORT = parseInt(process.env.AIVB_APP_PORT || "8188", 10);
const COMFY_PORT = parseInt(process.env.AIVB_COMFY_PORT || "8199", 10);
const HEALTH_URL = `http://127.0.0.1:${APP_PORT}/healthz`;
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

let splash = null;
let mainWindow = null;
let child = null;
let ready = false;

// ------------------------------- path resolution -------------------------------

function resourcesDir() {
  // Packaged: <install>/resources ; Dev: the desktop/ folder.
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function bundledPython() {
  // A standalone Python shipped under desktop/python (packaged: resources/python). Falls back to a
  // system interpreter in dev when the bundle isn't present.
  const base = path.join(resourcesDir(), "python");
  for (const rel of ["python.exe", path.join("bin", "python3"), path.join("bin", "python")]) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return { exe: p, bundled: true };
  }
  for (const cand of ["python", "py", "python3"]) {
    try {
      const r = spawnSync(cand, ["--version"], { stdio: "ignore" });
      if (r.status === 0) return { exe: cand, bundled: false };
    } catch (_) { /* try next */ }
  }
  return { exe: "python", bundled: false };
}

function dataDir() {
  return path.join(app.getPath("appData"), "CHNMagicAI");
}

// Read-only app source (backend + engine source + config defaults + workflows).
function sourceRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "app-src") : path.join(__dirname, "..");
}

// Where the app actually RUNS from (needs to be writable for the venv, ComfyUI input/temp, etc.).
// Packaged: materialize the source into a writable data dir on first run. Dev: run in place.
function ensureRunRoot() {
  if (!app.isPackaged) return path.join(__dirname, "..");
  const runRoot = path.join(dataDir(), "app");
  if (!fs.existsSync(path.join(runRoot, "backend", "launcher.py"))) {
    fs.mkdirSync(runRoot, { recursive: true });
    fs.cpSync(sourceRoot(), runRoot, { recursive: true });
  }
  return runRoot;
}

// ------------------------------- launcher process -------------------------------

function sendProgress(payload) {
  if (splash && !splash.isDestroyed()) splash.webContents.send("progress", payload);
}

function handleLine(line) {
  const s = line.trim();
  if (!s) return;
  const m = s.match(/^AIVB_PHASE\|(\d+)\|(.*)$/);
  if (m) {
    sendProgress({ pct: parseInt(m[1], 10), msg: m[2] });
  } else if (/^\[setup\]|^\[launcher\]/.test(s)) {
    // Human detail line — update the message text without moving the bar.
    sendProgress({ msg: s.replace(/^\[(setup|launcher)\]\s*/, "") });
  }
  console.log(s);
}

function startLauncher() {
  const runRoot = ensureRunRoot();
  const py = bundledPython();
  const env = Object.assign({}, process.env, {
    AIVB_ENV: "desktop",
    AIVB_DATA_DIR: dataDir(),
    AIVB_OPEN_BROWSER: "0",
    AIVB_APP_HOST: "127.0.0.1",
    AIVB_COMFY_HOST: "127.0.0.1",
    AIVB_APP_PORT: String(APP_PORT),
    AIVB_COMFY_PORT: String(COMFY_PORT),
    PYTHONUNBUFFERED: "1",
  });
  if (py.bundled) env.AIVB_BASE_PYTHON = py.exe;

  const launcher = path.join(runRoot, "backend", "launcher.py");
  child = spawn(py.exe, [launcher], { cwd: runRoot, env });

  let buf = "";
  const onData = (data) => {
    buf += data.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (!ready) sendProgress({ pct: 0, msg: `Startup exited (code ${code}). See the console/logs.` });
  });
}

// Kill the launcher AND its whole subprocess tree (the re-exec'd launcher + ComfyUI child).
function killTree() {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch (_) { /* already gone */ }
  child = null;
}

// ------------------------------- readiness poll -------------------------------

function pollHealth() {
  const req = http.get(HEALTH_URL, (res) => {
    if (res.statusCode === 200) {
      res.resume();
      onReady();
    } else {
      res.resume();
      setTimeout(pollHealth, 1000);
    }
  });
  req.on("error", () => setTimeout(pollHealth, 1000));
  req.setTimeout(4000, () => req.destroy());
}

function onReady() {
  if (ready) return;
  ready = true;
  sendProgress({ pct: 100, msg: "Ready" });
  createMainWindow();
}

// ------------------------------- windows -------------------------------

function createSplash() {
  splash = new BrowserWindow({
    width: 520,
    height: 300,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splash.loadFile(path.join(__dirname, "splash.html"));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#0b1020",
    title: "CHNMagicAI",
    // No default File/Edit/View/Window/Help menu bar — this is a single-purpose app.
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.setMenuBarVisibility(false);
  // Open target=_blank / external links in the system browser, keep app navigation in-window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(APP_URL);
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (splash && !splash.isDestroyed()) splash.close();
    splash = null;
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ------------------------------- app lifecycle -------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = mainWindow || splash;
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(() => {
    // Drop the default application menu so no menu bar (or its Alt-toggle) appears.
    Menu.setApplicationMenu(null);
    createSplash();
    startLauncher();
    pollHealth();
  });

  app.on("window-all-closed", () => {
    killTree();
    app.quit();
  });

  app.on("before-quit", killTree);
  process.on("exit", killTree);
}
