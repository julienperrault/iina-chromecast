const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const { shiftVttTimestamps } = require("../src/daemon/subtitles.ts");

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
