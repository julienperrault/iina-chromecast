const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const Module = require("node:module");

// Auto-resolve .js imports to .ts source files in development/testing
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  try {
    return originalResolve.call(this, request, parent, isMain, options);
  } catch (err) {
    if (request.endsWith(".js") && parent && parent.filename) {
      const candidate = path.resolve(path.dirname(parent.filename), request.replace(/\.js$/, ".ts"));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw err;
  }
};

// Register in-memory TypeScript compilation via esbuild for tests with 0 extra npm dependencies
require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { code } = esbuild.transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "node18",
  });
  module._compile(code, filename);
};
