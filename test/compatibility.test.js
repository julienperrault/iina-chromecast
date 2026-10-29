const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  extractTracksList,
  analyzeCompatibility,
} = require("../src/daemon/compatibility.ts");

test("extractTracksList: parses streams into audio and subtitle tracks", () => {
  const probeData = {
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
      },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        channels: 2,
        tags: { language: "fra", title: "Français Original" },
      },
      {
        index: 2,
        codec_type: "audio",
        codec_name: "ac3",
        channels: 6,
        tags: { language: "eng", title: "English 5.1" },
      },
      {
        index: 3,
        codec_type: "subtitle",
        codec_name: "subrip",
        tags: { language: "fre", title: "Français Complet" },
      },
      {
        index: 4,
        codec_type: "subtitle",
        codec_name: "webvtt",
        tags: { language: "eng", title: "English SDH" },
      },
    ],
  };

  const { audioTracks, subtitleTracks } = extractTracksList(probeData, "en");
  assert.equal(audioTracks.length, 2);
  assert.equal(audioTracks[0].streamIndex, 1);
  assert.equal(audioTracks[0].codec, "aac");
  assert.equal(audioTracks[0].lang, "fra");
  assert.match(audioTracks[0].label, /Français Original/);

  assert.equal(audioTracks[1].streamIndex, 2);
  assert.equal(audioTracks[1].channels, 6);
  assert.match(audioTracks[1].label, /AC3/);

  assert.equal(subtitleTracks.length, 2);
  assert.equal(subtitleTracks[0].streamIndex, 3);
  assert.equal(subtitleTracks[0].codec, "subrip");
  assert.match(subtitleTracks[0].label, /Français Complet/);
});

test("analyzeCompatibility: selects direct play for native MP4 (H264 + AAC)", () => {
  const probeData = {
    format: { duration: 120 },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080 },
      { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 },
    ],
  };

  const res = analyzeCompatibility("/movies/sample.mp4", probeData, {
    deviceSupports4kHevc: false,
  });

  assert.equal(res.mode, "direct");
  assert.equal(res.videoCopy, true);
  assert.equal(res.audioCopy, true);
  assert.equal(res.isHevcStream, false);
});

test("analyzeCompatibility: selects remux for MKV container with H.264", () => {
  const probeData = {
    format: { duration: 120 },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080 },
      { index: 1, codec_type: "audio", codec_name: "ac3", channels: 6 },
    ],
  };

  const res = analyzeCompatibility("/movies/sample.mkv", probeData, {
    deviceSupports4kHevc: false,
  });

  assert.equal(res.mode, "remux");
  assert.equal(res.videoCopy, true);
  assert.equal(res.audioCopy, false); // AC3 needs AAC conversion in remux
});

test("analyzeCompatibility: allows remux of HEVC on 4K capable devices", () => {
  const probeData = {
    format: { duration: 240 },
    streams: [
      { index: 0, codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p", width: 3840, height: 2160 },
      { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 },
    ],
  };

  const res = analyzeCompatibility("/movies/4k_demo.mkv", probeData, {
    deviceSupports4kHevc: true,
  });

  assert.equal(res.mode, "remux");
  assert.equal(res.videoCopy, true);
  assert.equal(res.audioCopy, true);
  assert.equal(res.isHevcStream, true);
});

test("analyzeCompatibility: forces transcode for HEVC on legacy non-4K devices", () => {
  const probeData = {
    format: { duration: 240 },
    streams: [
      { index: 0, codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p", width: 1920, height: 1080 },
      { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 },
    ],
  };

  const res = analyzeCompatibility("/movies/hevc_hd.mkv", probeData, {
    deviceSupports4kHevc: false,
  });

  assert.equal(res.mode, "transcode");
  assert.equal(res.videoCopy, false);
});

test("analyzeCompatibility: transcodes 10-bit H.264 content", () => {
  const probeData = {
    format: { duration: 180 },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p10le", width: 1920, height: 1080 },
      { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 },
    ],
  };

  const res = analyzeCompatibility("/movies/anime_10bit.mkv", probeData, {
    deviceSupports4kHevc: true,
  });

  assert.equal(res.mode, "transcode");
  assert.equal(res.videoCopy, false);
});

test("analyzeCompatibility: respects user forced modes", () => {
  const probeData = {
    format: { duration: 180 },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080 },
      { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 },
    ],
  };

  const forcedTranscode = analyzeCompatibility("/movies/video.mp4", probeData, {
    forceMode: "transcode",
  });
  assert.equal(forcedTranscode.mode, "transcode");

  const forcedDirect = analyzeCompatibility("/movies/video.mkv", probeData, {
    forceMode: "direct",
  });
  assert.equal(forcedDirect.mode, "direct");
});
