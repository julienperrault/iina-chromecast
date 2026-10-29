/**
 * Zero-dependency micro-benchmarks for the daemon hot paths.
 *
 *   npm run bench                              # run & print
 *   node bench/run.js --save bench/base.json   # run & save results
 *   node bench/run.js --compare bench/base.json
 */
require("../test/setup.js");

const fs = require("node:fs");
const { shiftVttTimestamps } = require("../src/daemon/subtitles.ts");
const { CastMessage } = require("../src/shared/cast-protocol.ts");
const { t } = require("../src/shared/i18n.ts");
const {
  analyzeCompatibility,
  extractTracksList,
} = require("../src/daemon/compatibility.ts");
const { makeVtt, STATUS_MSG, PROBE_4K_MKV } = require("./fixtures.js");

const VTT_2H = makeVtt(2 * 3600);
const STATUS_BUF = CastMessage.serialize(STATUS_MSG);

// ---------- Harness ----------

let sink = 0;
function consume(v) {
  if (v == null) return 0;
  if (typeof v === "string" || Buffer.isBuffer(v)) return v.length;
  return 1;
}

function bench(name, fn, minMs = 500) {
  for (let i = 0; i < 100; i++) sink ^= consume(fn());
  // Best of 5 rounds: robust against GC pauses and CPU frequency noise.
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    let iters = 0;
    const start = process.hrtime.bigint();
    let elapsed = 0n;
    const budget = BigInt(Math.round((minMs / 5) * 1e6));
    while (elapsed < budget) {
      for (let i = 0; i < 20; i++) sink ^= consume(fn());
      iters += 20;
      elapsed = process.hrtime.bigint() - start;
    }
    best = Math.min(best, Number(elapsed) / iters);
  }
  return { name, nsPerOp: best };
}

const cases = [
  ["shiftVttTimestamps (2h film, ~1700 cues, offset 1h)", () => shiftVttTimestamps(VTT_2H, 3600)],
  ["CastMessage.serialize (MEDIA_STATUS)", () => CastMessage.serialize(STATUS_MSG)],
  ["CastMessage.parse (MEDIA_STATUS)", () => CastMessage.parse(STATUS_BUF)],
  ["t() with params", () => t("fr", "compat.remux_copy", { ext: ".MKV", vCodec: "H264", aCodec: "AAC" })],
  ["t() without params", () => t("en", "track.subtitle_default")],
  ["extractTracksList", () => extractTracksList(PROBE_4K_MKV, "en")],
  ["analyzeCompatibility (4K HEVC MKV)", () =>
    analyzeCompatibility("/films/film.mkv", PROBE_4K_MKV, { deviceSupports4kHevc: true, language: "fr" })],
];

// ---------- Output ----------

const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const savePath = argValue("--save");
const comparePath = argValue("--compare");
const baseline = comparePath ? JSON.parse(fs.readFileSync(comparePath, "utf8")) : [];

const fmt = (ns) =>
  ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(0)} ns`;

console.log(`Node ${process.version}\n`);
const results = cases.map(([name, fn]) => {
  const r = bench(name, fn);
  let line = `${name.padEnd(55)} ${fmt(r.nsPerOp).padStart(10)}/op`;
  const base = baseline.find((b) => b.name === name);
  if (base) line += `   (avant ${fmt(base.nsPerOp)} → ×${(base.nsPerOp / r.nsPerOp).toFixed(2)})`;
  console.log(line);
  return r;
});

if (savePath) fs.writeFileSync(savePath, JSON.stringify(results, null, 2) + "\n");
if (sink === 0.5) console.log(sink);
