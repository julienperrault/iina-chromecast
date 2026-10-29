const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  detect4kHevcSupport,
  isAudioOnlyDevice,
  setBoundedMap,
  KEYWORDS_4K,
  KEYWORDS_AUDIO_ONLY,
} = require("../src/daemon/discovery.ts");

test("detect4kHevcSupport: identifies 4K and HEVC capable hardware", () => {
  assert.equal(detect4kHevcSupport("Chromecast Ultra", "Salon TV"), true);
  assert.equal(detect4kHevcSupport("Chromecast", "Google TV 4K"), true);
  assert.equal(detect4kHevcSupport("SHIELD Android TV", "Nvidia Shield"), true);
  assert.equal(detect4kHevcSupport("MiBOX", "Xiaomi Mi Box 4k"), true);
  assert.equal(detect4kHevcSupport("Bravia 4K", "Sony TV"), true);
  assert.equal(detect4kHevcSupport("Kirkwood", "Chromecast HD"), true);
});

test("detect4kHevcSupport: rejects 1080p legacy hardware", () => {
  assert.equal(detect4kHevcSupport("Chromecast", "Chambre"), false);
  assert.equal(detect4kHevcSupport("Chromecast (Gen 2)", "Living Room"), false);
  assert.equal(detect4kHevcSupport("Chromecast Gen 3", "Bureau"), false);
});

test("detect4kHevcSupport: respects explicit allow4kHevc override", () => {
  assert.equal(detect4kHevcSupport("Chromecast Gen 2", "Chambre", "always"), true);
  assert.equal(detect4kHevcSupport("Chromecast Ultra", "Salon", "never"), false);
});

test("isAudioOnlyDevice: correctly identifies speakers without display", () => {
  assert.equal(isAudioOnlyDevice("Google Home Mini", "Cuisine"), true);
  assert.equal(isAudioOnlyDevice("Nest Mini", "Chambre"), true);
  assert.equal(isAudioOnlyDevice("Nest Audio", "Salon Audio"), true);
  assert.equal(isAudioOnlyDevice("Chromecast Audio", "Hi-Fi"), true);
  assert.equal(isAudioOnlyDevice("Smart Speaker", "Enceinte"), true);
});

test("isAudioOnlyDevice: keeps video displays intact", () => {
  assert.equal(isAudioOnlyDevice("Chromecast Ultra", "TV Salon"), false);
  assert.equal(isAudioOnlyDevice("Google TV", "TV Chambre"), false);
  assert.equal(isAudioOnlyDevice("SHIELD", "Nvidia Shield"), false);
});

test("setBoundedMap: evicts oldest entry when reaching maximum capacity", () => {
  const map = new Map();
  setBoundedMap(map, "a", 1, 3);
  setBoundedMap(map, "b", 2, 3);
  setBoundedMap(map, "c", 3, 3);
  assert.equal(map.size, 3);
  assert.deepEqual(Array.from(map.keys()), ["a", "b", "c"]);

  setBoundedMap(map, "d", 4, 3);
  assert.equal(map.size, 3);
  assert.equal(map.has("a"), false);
  assert.deepEqual(Array.from(map.keys()), ["b", "c", "d"]);

  // Updating existing key does not evict
  setBoundedMap(map, "c", 30, 3);
  assert.equal(map.size, 3);
  assert.equal(map.get("c"), 30);
});
