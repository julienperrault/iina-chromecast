const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  parseRange,
  buildFfmpegStreamArgs,
} = require("../src/daemon/streamer.ts");

test("parseRange: returns null when header is absent or not bytes=", () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("", 1000), null);
  assert.equal(parseRange("items=0-10", 1000), null);
});

test("parseRange: parses explicit start-end ranges", () => {
  const result = parseRange("bytes=0-499", 1000);
  assert.deepEqual(result, {
    start: 0,
    end: 499,
    chunkSize: 500,
  });
});

test("parseRange: parses open-ended start- ranges", () => {
  const result = parseRange("bytes=500-", 1000);
  assert.deepEqual(result, {
    start: 500,
    end: 999,
    chunkSize: 500,
  });
});

test("parseRange: parses suffix -N ranges", () => {
  const result = parseRange("bytes=-200", 1000);
  assert.deepEqual(result, {
    start: 800,
    end: 999,
    chunkSize: 200,
  });
});

test("parseRange: clamps end byte to totalSize - 1 if exceeding", () => {
  const result = parseRange("bytes=500-2000", 1000);
  assert.deepEqual(result, {
    start: 500,
    end: 999,
    chunkSize: 500,
  });
});

test("parseRange: rejects invalid ranges (returns false)", () => {
  assert.equal(parseRange("bytes=1500-", 1000), false);
  assert.equal(parseRange("bytes=500-400", 1000), false);
  assert.equal(parseRange("bytes=abc-def", 1000), false);
  assert.equal(parseRange("bytes=-0", 1000), false);
  assert.equal(parseRange("bytes=-abc", 1000), false);
  assert.equal(parseRange("bytes=no-dash", 1000), false);
});

test("buildFfmpegStreamArgs: generates video copy args when videoCopy is true", () => {
  const args = buildFfmpegStreamArgs({
    filePath: "/media/video.mp4",
    startSec: 120,
    compat: {
      videoCopy: true,
      audioCopy: true,
      isHevcStream: true,
      mode: "remux",
      reason: "test",
      summary: {},
    },
    config: {
      maxResolution: 1080,
      videoBitrate: "8M",
    },
    audioStreamIndex: 1,
  });

  assert.ok(args.includes("-noaccurate_seek"));
  assert.ok(args.includes("-ss"));
  assert.equal(args[args.indexOf("-ss") + 1], "120");
  assert.ok(args.includes("-c:v"));
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.ok(args.includes("-tag:v"));
  assert.equal(args[args.indexOf("-tag:v") + 1], "hvc1");
  assert.ok(args.includes("-c:a"));
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.ok(args.includes("-map"));
  assert.ok(args.includes("0:1?"));
});

test("buildFfmpegStreamArgs: generates videotoolbox transcode args when videoCopy is false", () => {
  const args = buildFfmpegStreamArgs({
    filePath: "/media/video.mkv",
    startSec: 0,
    compat: {
      videoCopy: false,
      audioCopy: false,
      isHevcStream: false,
      mode: "transcode",
      reason: "test",
      summary: {},
    },
    config: {
      maxResolution: 720,
      videoBitrate: "4M",
    },
    audioStreamIndex: null,
  });

  assert.ok(args.includes("-hwaccel"));
  assert.equal(args[args.indexOf("-hwaccel") + 1], "videotoolbox");
  assert.ok(args.includes("-c:v"));
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_videotoolbox");
  assert.ok(args.includes("-b:v"));
  assert.equal(args[args.indexOf("-b:v") + 1], "4M");
  assert.ok(args.includes("-c:a"));
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.ok(args.includes("scale='min(1280,iw)':-2"));
  assert.ok(args.includes("0:a:0?"));
});
