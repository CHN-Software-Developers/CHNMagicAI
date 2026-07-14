// Build-time: download a standalone Python 3.10 (python-build-standalone) into desktop/python so the
// packaged desktop app has a zero-prerequisite interpreter to create the engine venv from.
//
// Run once before `npm run build`:  npm run fetch-python
// The version/tag are overridable via env (PBS_VERSION, PBS_TAG) if the pinned build ever 404s.
//
// Extraction uses `tar` (Windows 10+/11 ship bsdtar, which reads .tar.gz). The install_only archive
// unpacks to a top-level `python/` directory, giving desktop/python/python.exe.

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, rmSync, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = process.env.PBS_VERSION || "3.10.15";
const TAG = process.env.PBS_TAG || "20241016";
const TRIPLE = "x86_64-pc-windows-msvc-install_only";
const URL =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/` +
  `cpython-${VERSION}+${TAG}-${TRIPLE}.tar.gz`;

const outDir = path.join(__dirname, "python");
const archive = path.join(__dirname, `python-${VERSION}.tar.gz`);

async function main() {
  if (existsSync(path.join(outDir, "python.exe"))) {
    console.log("Bundled Python already present at", outDir);
    return;
  }
  console.log("Downloading", URL);
  const res = await fetch(URL);
  if (!res.ok) {
    console.error(`Download failed: HTTP ${res.status}.`);
    console.error("Adjust PBS_VERSION / PBS_TAG to a valid python-build-standalone release:");
    console.error("  https://github.com/astral-sh/python-build-standalone/releases");
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // install_only archive extracts to a top-level "python/" — strip it so files land in desktop/python.
  const r = spawnSync("tar", ["-xf", archive, "-C", __dirname], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("tar extraction failed (need bsdtar / GNU tar on PATH).");
    process.exit(1);
  }
  rmSync(archive, { force: true });
  if (!existsSync(path.join(outDir, "python.exe"))) {
    console.error("Extraction did not produce python/python.exe — inspect the archive layout.");
    process.exit(1);
  }
  console.log("Bundled Python ready at", outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
