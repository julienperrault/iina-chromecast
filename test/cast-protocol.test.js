const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  CastMessage,
  writeVarint,
  readVarint,
} = require("../src/shared/cast-protocol.ts");

test("writeVarint & readVarint: roundtrips single and multi-byte integers", () => {
  const numbers = [0, 1, 127, 128, 300, 16384, 1000000];
  for (const n of numbers) {
    const arr = [];
    writeVarint(arr, n);
    const buf = Buffer.from(arr);
    const [readVal, nextOffset] = readVarint(buf, 0);
    assert.equal(readVal, n);
    assert.equal(nextOffset, buf.length);
  }
});

test("CastMessage: roundtrips UTF8 JSON message", () => {
  const original = {
    protocolVersion: 0,
    sourceId: "sender-0",
    destinationId: "receiver-0",
    namespace: "urn:x-cast:com.google.cast.media",
    payloadType: 0,
    payloadUtf8: JSON.stringify({ type: "PAUSE", requestId: 42 }),
  };

  const serialized = CastMessage.serialize(original);
  assert.ok(Buffer.isBuffer(serialized));
  assert.ok(serialized.length > 0);

  const parsed = CastMessage.parse(serialized);
  assert.equal(parsed.protocolVersion, 0);
  assert.equal(parsed.sourceId, "sender-0");
  assert.equal(parsed.destinationId, "receiver-0");
  assert.equal(parsed.namespace, "urn:x-cast:com.google.cast.media");
  assert.equal(parsed.payloadType, 0);
  assert.equal(parsed.payloadUtf8, original.payloadUtf8);

  const parsedJson = JSON.parse(parsed.payloadUtf8);
  assert.equal(parsedJson.type, "PAUSE");
  assert.equal(parsedJson.requestId, 42);
});

test("CastMessage: roundtrips binary payload", () => {
  const binaryData = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xee, 0xdd]);
  const original = {
    protocolVersion: 0,
    sourceId: "sender-bin",
    destinationId: "receiver-bin",
    namespace: "urn:x-cast:custom",
    payloadType: 1,
    payloadBinary: binaryData,
  };

  const serialized = CastMessage.serialize(original);
  const parsed = CastMessage.parse(serialized);

  assert.equal(parsed.payloadType, 1);
  assert.deepEqual(parsed.payloadBinary, binaryData);
});
