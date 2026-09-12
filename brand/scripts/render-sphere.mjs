#!/usr/bin/env node
/**
 * render-sphere.mjs — regenerate every file in brand/exports/sphere/ from the
 * animated master at brand/sources/liquid-sphere/index.html.
 *
 *   node brand/scripts/render-sphere.mjs [--software] [--only=<name>]
 *
 *   --software      render with ANGLE/SwiftShader instead of the GPU. Correct
 *                   but roughly 25x slower (about 1.7 s per 512 px frame on an
 *                   M5 Pro, versus 70 ms on Metal), so a full run takes hours.
 *                   Use it only when the GPU path is unavailable.
 *   --only=<name>   render one output. <name> is an output file name, with or
 *                   without its extension:
 *                     mark-resting-1024   mark-working-1024
 *                     working-loop-512.webm   resting-loop-512.webm
 *                     working-loop-256.webp
 *
 * The master pulls three.js from unpkg through an import map, so the machine
 * needs network access. It is driven headlessly: LOOK.paused stops its own rAF
 * loop and every captured frame is setTime(t) -> step(0) -> render(), which
 * makes a frame a pure function of t.
 *
 * Seamless-loop proof: each sequence also renders one extra frame at t = loop
 * and compares it against frame 0 with `magick compare -metric RMSE`. That
 * number has to be ~0. The run also prints the RMSE between frames 0 and 1 as
 * a control: if the comparison were vacuous both numbers would be zero, so the
 * run fails when the neighbouring frames do not differ.
 *
 * External tools: ffmpeg (VP9 + frame scaling), img2webp or an ffmpeg built
 * with libwebp (animated WebP), ImageMagick `magick` (the loop proof).
 *
 * Animated-WebP size is driven by frame count, not quality. Measured on the
 * 384-frame 256 px working sequence: q80 24 fps = 2.89 MB, q70 = 2.53 MB,
 * q60 = 2.38 MB, but q80 at 12 fps = 1.45 MB. If working-loop-256.webp has to
 * fit a tighter budget, halve its frame rate rather than drop quality.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAND = path.resolve(HERE, "..");
const MASTER = path.join(BRAND, "sources", "liquid-sphere", "index.html");
const OUT_DIR = path.join(BRAND, "exports", "sphere");

/** Frame sequences. Each is rendered once and may feed several outputs. */
const SEQUENCES = {
  working: { state: "working", loop: 16, fps: 24, size: 512 },
  resting: { state: "resting", loop: 32, fps: 24, size: 512 },
};

/** Everything under brand/exports/sphere/, in render order. */
const OUTPUTS = [
  { file: "mark-resting-1024.png", kind: "still", state: "resting", time: 6.0, size: 1024 },
  { file: "mark-working-1024.png", kind: "still", state: "working", time: 4.5, size: 1024 },
  { file: "working-loop-512.webm", kind: "webm", seq: "working", size: 512, crf: 30 },
  { file: "resting-loop-512.webm", kind: "webm", seq: "resting", size: 512, crf: 30 },
  // The README loop. GitHub renders animated WebP and runs no scripts. Size is
  // driven by frame count, not quality (24 fps q80 = 2.9 MB, q60 = 2.4 MB with
  // visible banding; 12 fps q80 = 1.5 MB), so this one keeps every second frame.
  { file: "working-loop-256.webp", kind: "webp", seq: "working", size: 256, quality: 80, every: 2 },
];

/**
 * libwebp compression effort. Measured on the 384-frame 256 px sequence:
 * -m 6 took 248 s and produced 3,032,448 B; -m 4 took 1.8 s and produced
 * 3,080,302 B. 1.6 % of bytes is not worth 137x the encode time.
 */
const WEBP_METHOD = 4;

/** Loop proof: normalised RMSE between frame 0 and the frame at t = loop. */
const LOOP_RMSE_MAX = 0.002;
/** Control: neighbouring frames must differ by at least this, or the proof is vacuous. */
const NEIGHBOUR_RMSE_MIN = 0.002;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const software = argv.includes("--software");
const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const unknown = argv.filter((a) => a !== "--software" && !a.startsWith("--only="));
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(" ")}`);
  console.error("usage: node brand/scripts/render-sphere.mjs [--software] [--only=<name>]");
  process.exit(2);
}

const selected = onlyArg
  ? OUTPUTS.filter((o) => o.file === onlyArg || o.file.replace(/\.[^.]+$/, "") === onlyArg)
  : OUTPUTS;
if (selected.length === 0) {
  console.error(`--only=${onlyArg} matches nothing. Known outputs:`);
  for (const o of OUTPUTS) console.error(`  ${o.file}`);
  process.exit(2);
}

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`${cmd} could not be launched (${e.message}). Is it on PATH?`)),
    );
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function mustRun(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} exited ${r.code}\n${r.err.trim() || r.out.trim()}`);
  }
  return r;
}

/**
 * Normalised RMSE between two PNGs, 0 = identical, 1 = maximally different.
 * `magick compare` exits 1 whenever the images differ at all, so the exit code
 * is not the verdict — the metric on stderr is. Exit >= 2 is a real failure.
 */
async function rmse(a, b) {
  const r = await run("magick", ["compare", "-metric", "RMSE", a, b, "null:"]);
  if (r.code >= 2) throw new Error(`magick compare failed on ${a} / ${b}\n${r.err.trim()}`);
  const m = /\(([0-9.eE+-]+)\)/.exec(r.err) ?? /\(([0-9.eE+-]+)\)/.exec(r.out);
  if (!m) throw new Error(`could not parse an RMSE out of: ${r.err.trim() || r.out.trim()}`);
  return Number(m[1]);
}

async function ffmpegHasLibwebp() {
  const r = await run("ffmpeg", ["-hide_banner", "-h", "encoder=libwebp"]);
  return /Encoder libwebp/.test(r.out);
}

const frameName = (i) => `frame-${String(i).padStart(5, "0")}.png`;

/** Per-frame durations in whole ms that sum to exactly loop * 1000. */
function durations(count, fps) {
  const d = [];
  for (let i = 0; i < count; i++) {
    d.push(Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps));
  }
  return d;
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

// ---------------------------------------------------------------- browser

const GPU_ARGS = ["--use-angle=metal"];
const SOFTWARE_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

async function launch() {
  const browser = await chromium.launch({
    headless: true,
    args: [...(software ? SOFTWARE_ARGS : GPU_ARGS), "--hide-scrollbars", "--mute-audio"],
  });
  return browser;
}

/**
 * Open the master at a given size and state, paused, ready for deterministic
 * frames. Returns { page, capture(t, file) }.
 */
async function openMaster(browser, { state, size, loop, tmp }) {
  const context = await browser.newContext({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const query = new URLSearchParams({ state, transparent: "1", bare: "1" });
  if (loop) query.set("loop", String(loop));
  const url = `${pathToFileURL(MASTER).href}?${query}`;

  const failures = [];
  page.on("pageerror", (e) => failures.push(String(e)));
  page.on("requestfailed", (r) => failures.push(`${r.url()} — ${r.failure()?.errorText}`));

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  try {
    await page.waitForFunction("!!window.__sphere", null, { timeout: 60_000 });
  } catch {
    throw new Error(
      `the master never booted (window.__sphere is missing). It imports three.js from unpkg, so this machine needs network access.\n${failures.join("\n")}`,
    );
  }

  // Stop the page's own rAF loop from advancing time between our calls, and
  // pin the blend so `live` is exactly the named state's parameters.
  await page.evaluate((s) => {
    window.__sphere.LOOK.paused = true;
    window.__sphere.setBlend(s === "working" ? 1 : 0);
  }, state);

  const canvas = page.locator("canvas");
  const capture = async (t, file) => {
    await page.evaluate((time) => {
      window.__sphere.setTime(time);
      window.__sphere.step(0);
      window.__sphere.render();
    }, t);
    await canvas.screenshot({ omitBackground: true, path: file });
  };

  // Warm up: the first render compiles the injected shader, and the first
  // screenshot sets up the capture path. Neither is kept.
  const warm = path.join(tmp, "warmup.png");
  await capture(0, warm);
  await capture(0, warm);
  await fs.rm(warm, { force: true });

  const gl = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("webgl2");
    const info = ctx?.getExtension("WEBGL_debug_renderer_info");
    return info ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
  });

  return { context, page, capture, gl };
}

// ---------------------------------------------------------------- rendering

async function renderStill(browser, out, tmp) {
  const target = path.join(OUT_DIR, out.file);
  const started = Date.now();
  const { context, capture, gl } = await openMaster(browser, {
    state: out.state,
    size: out.size,
    tmp,
  });
  await capture(out.time, target);
  await context.close();
  console.log(
    `  ${out.file}: ${out.size}px ${out.state} @ t=${out.time} — ${((Date.now() - started) / 1000).toFixed(1)} s  [${gl}]`,
  );
}

/**
 * Render one loop's worth of frames plus the proof frame at t = loop, and
 * verify the loop closes. Returns the directory holding frame-00000.png…
 */
async function renderSequence(browser, name, tmp) {
  const seq = SEQUENCES[name];
  const count = Math.round(seq.loop * seq.fps);
  const dir = path.join(tmp, `frames-${name}`);
  await fs.mkdir(dir, { recursive: true });

  const { context, capture, gl } = await openMaster(browser, {
    state: seq.state,
    size: seq.size,
    loop: seq.loop,
    tmp,
  });
  console.log(
    `  sequence ${name}: ${count} frames, ${seq.size}px, state=${seq.state}, loop=${seq.loop}s @ ${seq.fps} fps  [${gl}]`,
  );

  const started = Date.now();
  for (let i = 0; i < count; i++) {
    await capture(i / seq.fps, path.join(dir, frameName(i)));
    if (i > 0 && i % 96 === 0) {
      const fps = i / ((Date.now() - started) / 1000);
      process.stdout.write(`    ${i}/${count} frames (${fps.toFixed(2)} fps)\n`);
    }
  }
  const proof = path.join(dir, "proof-at-loop.png");
  await capture(seq.loop, proof);
  await context.close();

  const elapsed = (Date.now() - started) / 1000;
  const fps = count / elapsed;
  console.log(`    ${count} frames in ${elapsed.toFixed(1)} s — ${fps.toFixed(2)} frames/s`);

  // --- seamless-loop proof, with its own control ---
  const first = path.join(dir, frameName(0));
  const loopRmse = await rmse(first, proof);
  const neighbourRmse = await rmse(first, path.join(dir, frameName(1)));
  console.log(
    `    loop proof: RMSE(frame 0, t=${seq.loop}s) = ${loopRmse.toFixed(6)}   control RMSE(frame 0, frame 1) = ${neighbourRmse.toFixed(6)}`,
  );
  if (neighbourRmse < NEIGHBOUR_RMSE_MIN) {
    throw new Error(
      `loop proof is vacuous for "${name}": neighbouring frames 0 and 1 differ by only ${neighbourRmse} (< ${NEIGHBOUR_RMSE_MIN}), so a near-zero loop RMSE proves nothing. Frames kept at ${dir}`,
    );
  }
  if (loopRmse > LOOP_RMSE_MAX) {
    throw new Error(
      `sequence "${name}" does NOT loop: frame at t=${seq.loop}s differs from frame 0 by RMSE ${loopRmse} (limit ${LOOP_RMSE_MAX}). The ?loop=<seconds> quantisation in brand/sources/liquid-sphere/index.html is wrong. Frames kept at ${dir}`,
    );
  }

  await fs.rm(proof);
  return { dir, count, seq };
}

// ---------------------------------------------------------------- encoding

async function encodeWebp(dir, count, fps, out, quality, encoder) {
  if (encoder === "ffmpeg") {
    await mustRun("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      String(fps),
      "-start_number",
      "0",
      "-i",
      path.join(dir, "frame-%05d.png"),
      "-c:v",
      "libwebp",
      "-lossless",
      "0",
      "-quality",
      String(quality),
      "-compression_level",
      String(WEBP_METHOD),
      "-loop",
      "0",
      "-an",
      out,
    ]);
    return;
  }
  const args = ["-loop", "0", "-lossy", "-q", String(quality), "-m", String(WEBP_METHOD)];
  const d = durations(count, fps);
  for (let i = 0; i < count; i++) args.push("-d", String(d[i]), frameName(i));
  args.push("-o", out);
  await mustRun("img2webp", args, { cwd: dir });
}

/** Keep every n-th frame, renumbered from 0, so an output can run at fps/n. */
async function decimateFrames(dir, count, every, tmp, tag) {
  const out = path.join(tmp, `${tag}-every${every}`);
  await fs.mkdir(out, { recursive: true });
  let kept = 0;
  for (let i = 0; i < count; i += every) {
    await fs.copyFile(path.join(dir, frameName(i)), path.join(out, frameName(kept)));
    kept++;
  }
  return { dir: out, count: kept };
}

async function encodeWebm(dir, fps, out, crf) {
  await mustRun("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    String(fps),
    "-start_number",
    "0",
    "-i",
    path.join(dir, "frame-%05d.png"),
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    "-b:v",
    "0",
    "-crf",
    String(crf),
    "-row-mt",
    "1",
    "-deadline",
    "good",
    "-cpu-used",
    "2",
    "-an",
    out,
  ]);
}

/**
 * Scale a rendered frame sequence. The master's transparent pixels are
 * straight-alpha black, so a naive filter drags that black into the silhouette;
 * premultiply around the scale keeps the edge honest.
 */
async function scaleFrames(dir, size, tmp, tag) {
  const outDir = path.join(tmp, `frames-${tag}-${size}`);
  await fs.mkdir(outDir, { recursive: true });
  await mustRun("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-start_number",
    "0",
    "-i",
    path.join(dir, "frame-%05d.png"),
    "-vf",
    `premultiply=inplace=1,scale=${size}:${size}:flags=lanczos,unpremultiply=inplace=1`,
    "-pix_fmt",
    "rgba",
    "-start_number",
    "0",
    path.join(outDir, "frame-%05d.png"),
  ]);
  return outDir;
}

// ---------------------------------------------------------------- main

async function main() {
  await fs.access(MASTER).catch(() => {
    throw new Error(`master not found at ${MASTER}`);
  });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const webpEncoder = (await ffmpegHasLibwebp()) ? "ffmpeg" : "img2webp";
  console.log(
    `render mode: ${software ? "ANGLE/SwiftShader (--software)" : "GPU via ANGLE/Metal"}; animated WebP encoder: ${webpEncoder}`,
  );
  if (webpEncoder === "img2webp") {
    console.log(
      "  (this ffmpeg is not built with libwebp; falling back to libwebp's own img2webp)",
    );
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rennet-sphere-"));
  const browser = await launch();
  const written = [];
  let kept = false;

  try {
    const needed = [...new Set(selected.filter((o) => o.seq).map((o) => o.seq))];
    const rendered = new Map();

    for (const out of selected.filter((o) => o.kind === "still")) {
      await renderStill(browser, out, tmp);
      written.push(out.file);
    }
    for (const name of needed) {
      rendered.set(name, await renderSequence(browser, name, tmp));
    }
    await browser.close();

    const scaled = new Map();
    for (const out of selected.filter((o) => o.kind !== "still")) {
      const { dir, count, seq } = rendered.get(out.seq);
      let frames = dir;
      if (out.size !== seq.size) {
        const key = `${out.seq}-${out.size}`;
        if (!scaled.has(key)) {
          scaled.set(key, await scaleFrames(dir, out.size, tmp, out.seq));
        }
        frames = scaled.get(key);
      }
      let frameCount = count;
      let fps = seq.fps;
      if (out.every && out.every > 1) {
        const thinned = await decimateFrames(
          frames,
          count,
          out.every,
          tmp,
          `${out.seq}-${out.size}`,
        );
        frames = thinned.dir;
        frameCount = thinned.count;
        fps = seq.fps / out.every;
      }
      const target = path.join(OUT_DIR, out.file);
      const started = Date.now();
      if (out.kind === "webp") {
        await encodeWebp(frames, frameCount, fps, target, out.quality, webpEncoder);
      } else {
        await encodeWebm(frames, fps, target, out.crf);
      }
      console.log(`  ${out.file}: encoded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      written.push(out.file);
    }
  } catch (error) {
    kept = true;
    await browser.close().catch(() => {});
    console.error(`\nFAILED: ${error.message}`);
    console.error(`temp frames kept at ${tmp}`);
    process.exitCode = 1;
    return;
  } finally {
    if (!kept) await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log("\noutputs:");
  let total = 0;
  for (const file of written) {
    const { size } = await fs.stat(path.join(OUT_DIR, file));
    total += size;
    console.log(
      `  ${file.padEnd(24)} ${String(size).padStart(9)} B  ${size > 1024 * 1024 ? mb(size) : kb(size)}`,
    );
  }
  console.log(`  ${"total".padEnd(24)} ${String(total).padStart(9)} B  ${mb(total)}`);
}

await main();
