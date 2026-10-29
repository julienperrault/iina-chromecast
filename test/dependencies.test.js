const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  resolveDaemonScript,
  resolveNodeBinary,
  resolveFfmpegBinary,
  getDependencies,
  resetDependencyCache,
} = require("../src/shared/dependencies.ts");

test("dependencies: resolveDaemonScript finds dist/daemon.js if built", () => {
  resetDependencyCache();
  const path = resolveDaemonScript(process.cwd());
  assert.ok(path);
  assert.ok(path.includes("dist/daemon.js"));
});

test("dependencies: resolveNodeBinary finds node", () => {
  resetDependencyCache();
  const node = resolveNodeBinary();
  assert.ok(node);
  assert.ok(node.includes("node"));

  const custom = resolveNodeBinary(process.execPath);
  assert.equal(custom, process.execPath);
});

test("dependencies: resolveFfmpegBinary resolves existing ffmpeg or null", () => {
  resetDependencyCache();
  const res = resolveFfmpegBinary();
  if (res) {
    assert.ok(res.includes("ffmpeg"));
  }
});

test("dependencies: getDependencies returns consolidated object", () => {
  resetDependencyCache();
  const deps = getDependencies();
  assert.equal(typeof deps, "object");
  assert.ok("daemonScript" in deps);
  assert.ok("nodePath" in deps);
  assert.ok("ffmpegPath" in deps);
  assert.ok("hasFfmpeg" in deps);
});
