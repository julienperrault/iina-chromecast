const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

/**
 * Replaces `castv2/lib/proto.js` (which pulls in 91 KB of `protobufjs` + `long`)
 * with a direct wire-format encoder/decoder for `CastMessage` (< 1 KB minified),
 * and stubs out `debug` (saves 8 KB).
 */
const slimDaemonDepsPlugin = {
  name: "slim-daemon-deps",
  setup(build) {
    build.onResolve({ filter: /^debug$/ }, () => ({
      path: "debug-noop",
      namespace: "noop-debug",
    }));

    build.onLoad({ filter: /.*/, namespace: "noop-debug" }, () => ({
      contents: "module.exports = () => () => {};",
      loader: "js",
    }));

    build.onLoad({ filter: /castv2[\/\\]lib[\/\\]proto\.js$/ }, () => ({
      contents: `module.exports = require(${JSON.stringify(
        path.join(__dirname, "src/shared/cast-protocol.ts")
      )});`,
      loader: "js",
    }));
  },
};

/**
 * Filters `i18n/{en,fr,es}.json` during bundling so each bundle only embeds
 * the exact translation key prefixes it uses (zero cross-bundle i18n duplication).
 */
function createScopedI18nPlugin(allowedPrefixes) {
  return {
    name: "scoped-i18n",
    setup(build) {
      build.onLoad({ filter: /i18n[\/\\](en|fr|es)\.json$/ }, (args) => {
        const fullDict = JSON.parse(fs.readFileSync(args.path, "utf8"));
        const scoped = {};
        for (const [key, val] of Object.entries(fullDict)) {
          if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
            scoped[key] = val;
          }
        }
        return {
          contents: JSON.stringify(scoped),
          loader: "json",
        };
      });
    },
  };
}

async function runBuild() {
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });

  // 1. Bundle & minify the Node.js Chromecast & FFmpeg daemon
  await esbuild.build({
    entryPoints: ["src/daemon/daemon.ts"],
    bundle: true,
    minify: true,
    treeShaking: true,
    legalComments: "none",
    platform: "node",
    target: "node18",
    outfile: "dist/daemon.js",
    plugins: [
      slimDaemonDepsPlugin,
      createScopedI18nPlugin(["track.", "compat.", "error."]),
    ],
  });

  // 2. Bundle & minify the IINA plugin entry point (resolves dist/daemon.js directly on disk)
  await esbuild.build({
    entryPoints: ["src/index/index.ts"],
    bundle: true,
    minify: true,
    treeShaking: true,
    legalComments: "none",
    format: "iife",
    target: "es2020",
    outfile: "dist/index.js",
    plugins: [createScopedI18nPlugin(["menu.", "mode.", "osd.", "toast."])],
  });

  // 3. Bundle the shared WebView i18n helper for ui/sidebar.html and ui/preferences.html
  await esbuild.build({
    entryPoints: ["src/shared/i18n.ts"],
    bundle: true,
    minify: true,
    treeShaking: true,
    legalComments: "none",
    format: "iife",
    platform: "browser",
    target: "es2020",
    outfile: "dist/i18n-ui.js",
    plugins: [createScopedI18nPlugin(["ui.", "pref."])],
  });

  const daemonBytes = fs.statSync(path.join(__dirname, "dist", "daemon.js")).size;
  const indexBytes = fs.statSync(path.join(__dirname, "dist", "index.js")).size;
  const i18nBytes = fs.statSync(path.join(__dirname, "dist", "i18n-ui.js")).size;
  const totalKb = ((daemonBytes + indexBytes + i18nBytes) / 1024).toFixed(1);

  console.log(
    `Build completed: dist/daemon.js (${(daemonBytes / 1024).toFixed(1)} KB), dist/index.js (${(indexBytes / 1024).toFixed(1)} KB), dist/i18n-ui.js (${(i18nBytes / 1024).toFixed(1)} KB) — Total: ${totalKb} KB`
  );
}

runBuild().catch((err) => {
  console.error(err);
  process.exit(1);
});
