/**
 * End-to-end subtitle serving benchmark with a fake `ffmpeg` (shell script that
 * simulates ~80 ms of demuxing, then prints a 2h WebVTT file).
 *
 * Scenario: cast start (embedded subtitle track) followed by 5 seeks; for each,
 * the Chromecast fetches /subtitles.vtt?start=N. Measures latency per request and
 * the number of ffmpeg processes spawned.
 */
require("../test/setup.js");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { SubtitleManager } = require("../src/daemon/subtitles.ts");
const { makeVtt } = require("./fixtures.js");

function createFakeFfmpeg(dir, delaySec = 0.08) {
  const vttPath = path.join(dir, "subs.vtt");
  const countPath = path.join(dir, "count");
  fs.writeFileSync(vttPath, makeVtt(2 * 3600));
  fs.writeFileSync(countPath, "");
  const bin = path.join(dir, "ffmpeg");
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${countPath}"\nsleep ${delaySec}\ncat "${vttPath}"\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, spawnCount: () => fs.readFileSync(countPath, "utf8").split("\n").filter(Boolean).length };
}

function request(manager, ffmpegPath, activeCast, start) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = "GET";
    let bytes = 0;
    const res = {
      writeHead() {},
      setHeader() {},
      write(chunk) { bytes += chunk.length; return true; },
      end(chunk) { if (chunk) bytes += chunk.length; resolve(bytes); },
    };
    manager.handleSubtitleRequest({
      req, res, ffmpegPath, activeCast,
      parsedUrl: new URL(`http://x/subtitles.vtt?start=${start}`),
    });
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iina-cast-bench-"));
  const media = path.join(dir, "film.mkv");
  fs.writeFileSync(media, "");
  const fake = createFakeFfmpeg(dir);

  const manager = new SubtitleManager();
  const activeCast = {
    filePath: media, subtitleStreamIndex: 3, externalSubtitlePath: null,
    seekOffset: 0, vttContent: null, vttContentOffset: null,
  };
  // New implementation exposes a background preload started at cast time.
  if (typeof manager.preloadSubtitles === "function") manager.preloadSubtitles(fake.bin, activeCast);

  const timings = [];
  for (const start of [0, 600, 1800, 3600, 1200, 5400]) {
    activeCast.seekOffset = start;
    const t0 = process.hrtime.bigint();
    await request(manager, fake.bin, activeCast, start);
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const total = timings.reduce((a, b) => a + b, 0);
  console.log(`Sous-titres (1 chargement + 5 seeks) : total ${total.toFixed(0)} ms, ` +
    `par requête [${timings.map((t) => t.toFixed(0)).join(", ")}] ms, ` +
    `processus ffmpeg lancés : ${fake.spawnCount()}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

main();
