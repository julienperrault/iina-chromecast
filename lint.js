/**
 * IINA Chromecast Project Linter & Static Analyzer
 * Validates:
 * 1. JavaScript syntax & bundle compilation (src/*.js, build.js, lint.js)
 * 2. IINA 1.5 Thread-Safety & Code Quality rules (no `var`, no `debugger`, no `menu.forceUpdate()`,
 *    mandatory `yieldToPluginLoop()` after `http.get`/`http.post`)
 * 3. HTML inline <script> syntax & DOM/i18n attribute binding (ui/sidebar.html, ui/preferences.html)
 * 4. Info.json & package.json schema and preference key consistency
 * 5. Multi-language (en, fr, es) dictionary completeness & placeholder parity
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const esbuild = require("esbuild");
const { SUPPORTED_LANGUAGES, TRANSLATIONS } = require("./src/i18n");

const ROOT = __dirname;
let errorCount = 0;
let warningCount = 0;
let checksPassed = 0;

function pass(msg) {
  checksPassed += 1;
  console.log(`  ✓ ${msg}`);
}

function warn(msg) {
  warningCount += 1;
  console.warn(`  ⚠ [WARN] ${msg}`);
}

function fail(msg) {
  errorCount += 1;
  console.error(`  ✗ [ERROR] ${msg}`);
}

function extractPlaceholders(str) {
  const matches = String(str).match(/\{(\w+)\}/g) || [];
  return matches.sort().join(",");
}

function checkJsFiles() {
  console.log("\n[1/5] Checking JavaScript syntax, bundle & thread-safety rules...");
  const jsFiles = [
    "src/i18n.js",
    "src/daemon.js",
    "src/index.js",
    "build.js",
    "lint.js",
  ];

  for (const rel of jsFiles) {
    const fullPath = path.join(ROOT, rel);
    if (!fs.existsSync(fullPath)) {
      fail(`Missing JS file: ${rel}`);
      continue;
    }
    const code = fs.readFileSync(fullPath, "utf8");

    try {
      new vm.Script(code, { filename: rel });
      pass(`Syntax valid: ${rel}`);
    } catch (err) {
      fail(`Syntax error in ${rel}: ${err.message}`);
    }

    // Disallow `debugger` statements and legacy `var ` declarations
    const lines = code.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (/^\s*debugger\s*;?\s*$/.test(trimmed)) {
        fail(`${rel}:${idx + 1} contains forbidden 'debugger' statement`);
      }
      if (/^\s*var\s+/.test(line)) {
        warn(`${rel}:${idx + 1} uses legacy 'var' instead of 'const'/'let'`);
      }
    });
  }

  // IINA 1.5 specific thread-safety checks in src/index.js
  const indexCode = fs.readFileSync(path.join(ROOT, "src/index.js"), "utf8");
  const codeLines = indexCode
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

  if (codeLines.includes("menu.forceUpdate(")) {
    fail("src/index.js calls menu.forceUpdate(), which causes a JSC/MainThread deadlock in IINA 1.5");
  } else {
    pass("IINA 1.5 anti-deadlock check: no menu.forceUpdate() calls");
  }

  const httpAwaitCount = (codeLines.match(/await\s+http\.(get|post)\s*\(/g) || []).length;
  const yieldCount = (codeLines.match(/await\s+yieldToPluginLoop\s*\(\s*\)/g) || []).length;
  if (httpAwaitCount > 0 && yieldCount >= httpAwaitCount) {
    pass(`IINA 1.5 Just.HTTP thread-bounce check: ${yieldCount}/${httpAwaitCount} HTTP calls guarded by yieldToPluginLoop()`);
  } else {
    fail(`src/index.js has ${httpAwaitCount} 'await http.get/post' calls but only ${yieldCount} 'await yieldToPluginLoop()' guards`);
  }

  // Verify esbuild bundling succeeds in-memory
  try {
    esbuild.buildSync({
      entryPoints: [path.join(ROOT, "src/index.js")],
      bundle: true,
      platform: "node",
      target: "es2020",
      write: false,
    });
    pass("esbuild dry-run bundle check passed for src/index.js");
  } catch (err) {
    fail(`esbuild bundle check failed: ${err.message}`);
  }
}

function checkHtmlFiles() {
  console.log("\n[2/5] Checking UI HTML files & inline <script> blocks...");
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, "Info.json"), "utf8"));
  const validPrefKeys = new Set(Object.keys(info.preferenceDefaults || {}));

  const htmlFiles = ["ui/sidebar.html", "ui/preferences.html"];
  for (const rel of htmlFiles) {
    const fullPath = path.join(ROOT, rel);
    const html = fs.readFileSync(fullPath, "utf8");

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!scriptMatch) {
      fail(`${rel} is missing an inline <script> block`);
      continue;
    }

    try {
      new vm.Script(scriptMatch[1], { filename: `${rel}<script>` });
      pass(`Inline <script> syntax valid: ${rel}`);
    } catch (err) {
      fail(`Inline <script> syntax error in ${rel}: ${err.message}`);
    }

    // Check data-pref-key attributes in preferences.html
    const prefMatches = [...html.matchAll(/data-pref-key="([^"]+)"/g)];
    for (const m of prefMatches) {
      const key = m[1];
      if (!validPrefKeys.has(key)) {
        fail(`${rel} references unknown preference key '${key}' (not in Info.json preferenceDefaults)`);
      }
    }
    if (prefMatches.length > 0) {
      pass(`${rel}: all ${prefMatches.length} data-pref-key attributes match Info.json`);
    }
  }
}

function checkI18nCompleteness() {
  console.log("\n[3/5] Checking separate i18n/*.json files (en, fr, es) & UI bindings...");
  for (const lang of SUPPORTED_LANGUAGES) {
    const jsonPath = path.join(ROOT, "i18n", `${lang}.json`);
    if (!fs.existsSync(jsonPath)) {
      fail(`Missing separate translation file: i18n/${lang}.json`);
    } else {
      pass(`Found translation file: i18n/${lang}.json`);
    }
  }

  const baseLang = "en";
  const baseKeys = Object.keys(TRANSLATIONS[baseLang] || {});

  if (baseKeys.length === 0) {
    fail("i18n/en.json has no keys");
    return;
  }

  for (const lang of SUPPORTED_LANGUAGES) {
    const dict = TRANSLATIONS[lang];
    if (!dict) {
      fail(`Missing language dictionary '${lang}'`);
      continue;
    }

    const langKeys = Object.keys(dict);
    for (const k of baseKeys) {
      if (!(k in dict)) {
        fail(`i18n/${lang}.json is missing translation key '${k}'`);
      } else {
        const basePh = extractPlaceholders(TRANSLATIONS[baseLang][k]);
        const langPh = extractPlaceholders(dict[k]);
        if (basePh !== langPh) {
          fail(
            `i18n/${lang}.json placeholder mismatch for '${k}': expected '${basePh}', got '${langPh}'`
          );
        }
      }
    }

    for (const k of langKeys) {
      if (!(k in TRANSLATIONS[baseLang])) {
        warn(`i18n/${lang}.json has extra key '${k}' not present in '${baseLang}'`);
      }
    }

    pass(`i18n/${lang}.json: ${langKeys.length} keys verified with matching placeholders`);
  }

  // Verify all data-i18n attributes in ui/sidebar.html and ui/preferences.html exist in i18n/*.json
  for (const rel of ["ui/sidebar.html", "ui/preferences.html"]) {
    const html = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const attrs = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
    for (const key of attrs) {
      if (!(key in TRANSLATIONS.en)) {
        fail(`${rel} references data-i18n="${key}" which is missing in i18n/en.json`);
      }
    }
    pass(`${rel}: all ${attrs.length} data-i18n attributes exist in i18n/*.json`);
  }
}

function checkManifests() {
  console.log("\n[4/5] Checking Info.json & package.json manifests...");
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, "Info.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  if (!info.identifier || !info.entry || !info.version) {
    fail("Info.json is missing required fields (identifier, entry, version)");
  } else {
    pass(`Info.json manifest valid (${info.identifier} v${info.version})`);
  }

  for (const lang of SUPPORTED_LANGUAGES) {
    if (!info.localized || !info.localized[lang]) {
      fail(`Info.json is missing localized entry for '${lang}'`);
    }
  }
  pass(`Info.json localized metadata present for: ${SUPPORTED_LANGUAGES.join(", ")}`);

  if (!pkg.devDependencies || !pkg.devDependencies["iina-plugin-definition"]) {
    fail("package.json is missing iina-plugin-definition in devDependencies");
  } else {
    pass(`package.json devDependencies valid (iina-plugin-definition: ${pkg.devDependencies["iina-plugin-definition"]})`);
  }
}

function checkDocumentation() {
  console.log("\n[5/6] Checking project documentation, LICENSE & Makefile...");
  const requiredDocs = ["README.md", "LICENSE", "docs/ARCHITECTURE.md", "Makefile"];
  for (const rel of requiredDocs) {
    const fullPath = path.join(ROOT, rel);
    if (!fs.existsSync(fullPath)) {
      fail(`Missing project file: ${rel}`);
    } else {
      pass(`Found ${rel}`);
    }
  }
}

function checkDeadCode() {
  console.log("\n[6/6] Checking for dead code & unused translations...");
  const baseLang = "en";
  const baseKeys = Object.keys(TRANSLATIONS[baseLang] || {});
  const codeFiles = [
    "src/index.js",
    "src/daemon.js",
    "ui/sidebar.html",
    "ui/preferences.html",
  ];
  const fileContents = codeFiles.map((rel) => ({
    name: rel,
    content: fs.readFileSync(path.join(ROOT, rel), "utf8"),
  }));

  const unusedKeys = [];
  for (const key of baseKeys) {
    let found = false;
    for (const { content } of fileContents) {
      if (
        content.includes(`"${key}"`) ||
        content.includes(`'${key}'`) ||
        content.includes(`\`${key}\``) ||
        content.includes(`>${key}<`)
      ) {
        found = true;
        break;
      }
    }
    if (!found) {
      unusedKeys.push(key);
    }
  }

  if (unusedKeys.length > 0) {
    fail(`Found ${unusedKeys.length} unused i18n translation key(s): ${unusedKeys.join(", ")}`);
  } else {
    pass(`All ${baseKeys.length} translation keys are actively referenced across codebase`);
  }

  // Check function declarations in src/*.js
  for (const rel of ["src/index.js", "src/daemon.js"]) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const fnRegex = /function\s+([a-zA-Z0-9_$]+)\s*\(/g;
    let match;
    const fns = [];
    while ((match = fnRegex.exec(code)) !== null) {
      fns.push({ name: match[1], index: match.index });
    }
    const deadFns = [];
    for (const fn of fns) {
      const before = code.slice(0, fn.index);
      const after = code.slice(fn.index + fn.name.length + 8);
      const regex = new RegExp(`\\b${fn.name}\\b`, "g");
      const refCount = (before.match(regex) || []).length + (after.match(regex) || []).length;
      if (refCount === 0) {
        deadFns.push(fn.name);
      }
    }
    if (deadFns.length > 0) {
      fail(`${rel} contains ${deadFns.length} unreferenced function(s): ${deadFns.join(", ")}`);
    } else {
      pass(`${rel}: all ${fns.length} functions are actively referenced`);
    }
  }
}

const isDeadcodeOnly = process.argv.includes("--deadcode-only");

if (isDeadcodeOnly) {
  console.log("=== IINA Chromecast Dead Code & Unused Translation Audit ===");
  checkDeadCode();
} else {
  checkJsFiles();
  checkHtmlFiles();
  checkI18nCompleteness();
  checkManifests();
  checkDocumentation();
  checkDeadCode();
}

console.log(
  `\nSummary: ${checksPassed} checks passed, ${warningCount} warning(s), ${errorCount} error(s).`
);

if (errorCount > 0) {
  process.exit(1);
}
