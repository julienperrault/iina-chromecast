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

    build.onLoad({ filter: /castv2[\/\\]lib[\/\\]proto\.js$/ }, () => {
      const contents = `
        function writeVarint(arr, val) {
          val = val >>> 0;
          while (val > 0x7f) {
            arr.push((val & 0x7f) | 0x80);
            val >>>= 7;
          }
          arr.push(val);
        }

        function writeBytes(chunks, tag, buf) {
          const head = [tag];
          writeVarint(head, buf.length);
          chunks.push(Buffer.from(head), buf);
        }

        function readVarint(buf, offset) {
          let val = 0;
          let shift = 0;
          let b;
          do {
            b = buf[offset++];
            val |= (b & 0x7f) << shift;
            shift += 7;
          } while (b & 0x80);
          return [val >>> 0, offset];
        }

        function skipField(buf, offset, wireType) {
          if (wireType === 0) return readVarint(buf, offset)[1];
          if (wireType === 1) return offset + 8;
          if (wireType === 2) {
            const [len, next] = readVarint(buf, offset);
            return next + len;
          }
          if (wireType === 5) return offset + 4;
          return buf.length;
        }

        exports.CastMessage = {
          serialize(msg) {
            const chunks = [];
            const pv = [0x08];
            writeVarint(pv, msg.protocolVersion || 0);
            chunks.push(Buffer.from(pv));

            if (msg.sourceId !== undefined) writeBytes(chunks, 0x12, Buffer.from(msg.sourceId, "utf8"));
            if (msg.destinationId !== undefined) writeBytes(chunks, 0x1a, Buffer.from(msg.destinationId, "utf8"));
            if (msg.namespace !== undefined) writeBytes(chunks, 0x22, Buffer.from(msg.namespace, "utf8"));

            const pt = [0x28];
            writeVarint(pt, msg.payloadType || 0);
            chunks.push(Buffer.from(pt));

            if (msg.payloadUtf8 !== undefined) writeBytes(chunks, 0x32, Buffer.from(msg.payloadUtf8, "utf8"));
            if (msg.payloadBinary !== undefined) writeBytes(chunks, 0x3a, msg.payloadBinary);

            return Buffer.concat(chunks);
          },

          parse(buf) {
            const msg = {
              protocolVersion: 0,
              sourceId: "",
              destinationId: "",
              namespace: "",
              payloadType: 0,
              payloadUtf8: undefined,
              payloadBinary: undefined,
            };
            let offset = 0;
            while (offset < buf.length) {
              let tag;
              [tag, offset] = readVarint(buf, offset);
              const field = tag >>> 3;
              const wire = tag & 0x07;
              if (field === 1 && wire === 0) {
                [msg.protocolVersion, offset] = readVarint(buf, offset);
              } else if (field === 5 && wire === 0) {
                [msg.payloadType, offset] = readVarint(buf, offset);
              } else if ((field === 2 || field === 3 || field === 4 || field === 6 || field === 7) && wire === 2) {
                let len;
                [len, offset] = readVarint(buf, offset);
                const slice = buf.subarray(offset, offset + len);
                offset += len;
                if (field === 2) msg.sourceId = slice.toString("utf8");
                else if (field === 3) msg.destinationId = slice.toString("utf8");
                else if (field === 4) msg.namespace = slice.toString("utf8");
                else if (field === 6) msg.payloadUtf8 = slice.toString("utf8");
                else if (field === 7) msg.payloadBinary = slice;
              } else {
                offset = skipField(buf, offset, wire);
              }
            }
            return msg;
          },
        };
      `;
      return { contents, loader: "js" };
    });
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
    entryPoints: ["src/daemon.js"],
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
    entryPoints: ["src/index.js"],
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
    entryPoints: ["src/i18n.js"],
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
