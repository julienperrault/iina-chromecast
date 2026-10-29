const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  shiftVttTimestamps,
  VTT_TIMESTAMP_REGEX,
  SubtitleManager,
} = require("../src/daemon/subtitles.ts");

function referenceShift(vttText, offsetSeconds) {
  if (!offsetSeconds || offsetSeconds === 0) return vttText;
  const parseTs = (h, m, s, ms) =>
    Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const formatTs = (totalSec) => {
    const clamped = Math.max(0, totalSec);
    const hrs = Math.floor(clamped / 3600);
    const mins = Math.floor((clamped % 3600) / 60);
    const secs = Math.floor(clamped % 60);
    const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}.${pad3(millis)}`;
  };

  return vttText.replace(
    VTT_TIMESTAMP_REGEX,
    (_match, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
      const start = parseTs(h1, m1, s1, ms1) - offsetSeconds;
      const end = parseTs(h2, m2, s2, ms2) - offsetSeconds;
      if (end <= 0) {
        return `00:00:00.000 --> 00:00:00.001`;
      }
      return `${formatTs(start)} --> ${formatTs(end)}`;
    }
  );
}

test("shiftVttTimestamps: returns unchanged text when offset is 0 or negative", () => {
  const vtt = "WEBVTT\n\n00:01:10.500 --> 00:01:15.000\nHello World!";
  assert.equal(shiftVttTimestamps(vtt, 0), vtt);
  assert.equal(shiftVttTimestamps(vtt, -5), vtt);
});

test("shiftVttTimestamps: correctly subtracts offset from timestamps", () => {
  const vtt =
    "WEBVTT\n\n" +
    "1\n" +
    "00:02:30.000 --> 00:02:35.500\n" +
    "First cue\n\n" +
    "2\n" +
    "01:00:00.000 --> 01:00:04.250\n" +
    "Second cue\n";

  // Shift by 2 minutes (120 seconds)
  const shifted = shiftVttTimestamps(vtt, 120);

  assert.match(
    shifted,
    /00:00:30\.000 --> 00:00:35\.500\nFirst cue/
  );
  assert.match(
    shifted,
    /00:58:00\.000 --> 00:58:04\.250\nSecond cue/
  );
});

test("shiftVttTimestamps: clamps expired cues when offset is greater than cue end", () => {
  const vtt =
    "WEBVTT\n\n" +
    "00:00:10.000 --> 00:00:15.000\n" +
    "Past cue\n";

  // Shift by 30 seconds (after cue end)
  const shifted = shiftVttTimestamps(vtt, 30);
  assert.match(
    shifted,
    /00:00:00\.000 --> 00:00:00\.001\nPast cue/
  );
});

test("shiftVttTimestamps: supports short MM:SS.mmm format without hours", () => {
  const vtt = "WEBVTT\n\n01:20.000 --> 01:25.000\nShort timestamp cue";
  // Shift by 60 seconds
  const shifted = shiftVttTimestamps(vtt, 60);
  assert.match(shifted, /00:00:20\.000 --> 00:00:25\.000/);
});

test("shiftVttTimestamps: matches regex reference on various timestamp shapes", () => {
  const samples = [
    "WEBVTT\n\n00:00.000 --> 00:05.000\nStart",
    "WEBVTT\n\n0:01:02.003 --> 0:01:04.500\nSingle digit hour",
    "WEBVTT\n\n12:34:56.789 --> 12:35:00.000\nLate cue",
    "WEBVTT\n\n00:05:00.123   -->   00:06:00.456\nSpaced arrow",
    "WEBVTT\n\n1\n00:01:00.000 --> 00:02:00.000\nLine 1: 10 -> 20\n\n2\n02:00.000 --> 03:00.000\nShort",
  ];

  for (const s of samples) {
    for (const offset of [10, 65.5, 300, 4000]) {
      const fast = shiftVttTimestamps(s, offset);
      const ref = referenceShift(s, offset);
      assert.equal(fast, ref, `Mismatch for offset ${offset}:\nExpected:\n${ref}\nGot:\n${fast}`);
    }
  }
});

test("SubtitleManager: handles 404 when no active subtitles", () => {
  const manager = new SubtitleManager();
  let responseData = "";
  let statusCode = 0;
  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end(data) {
      if (data) responseData = data.toString("utf8");
    },
  };
  const activeCast = {
    subtitleStreamIndex: "none",
  };

  manager.handleSubtitleRequest({
    req: {},
    res,
    parsedUrl: new URL("http://localhost:45890/subtitles.vtt?start=120"),
    ffmpegPath: "ffmpeg",
    activeCast,
  });

  assert.equal(statusCode, 404);
  assert.equal(responseData, "No subtitles");
});
