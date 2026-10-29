/**
 * Centralized Dependency Resolver for IINA Chromecast Plugin
 * Universal: Manages detection of Node.js runtime, companion daemon script (dist/daemon.js) and FFmpeg.
 */

export interface ResolvedDependencies {
  daemonScript: string | null;
  nodePath: string | null;
  ffmpegPath: string | null;
  hasFfmpeg: boolean;
}

const CACHE: {
  daemonScript?: string | null;
  nodePath?: string | null;
  ffmpegPath?: string | null;
} = {};

const STANDARD_NODE_PATHS = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

const STANDARD_FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

function checkFileExists(targetPath: string): boolean {
  if (!targetPath) return false;
  if (typeof iina !== "undefined" && iina.utils && typeof iina.utils.fileInPath === "function") {
    return iina.utils.fileInPath(targetPath);
  }
  try {
    const fs = typeof require !== "undefined" ? require("fs") : null;
    return Boolean(fs && fs.existsSync(targetPath));
  } catch {
    return false;
  }
}

/**
 * Resolves the path to the companion daemon JavaScript bundle (dist/daemon.js).
 */
export function resolveDaemonScript(pluginRoot?: string): string | null {
  if (CACHE.daemonScript !== undefined && !pluginRoot) {
    return CACHE.daemonScript;
  }

  const candidates: string[] = [];

  if (pluginRoot) {
    candidates.push(`${pluginRoot}/dist/daemon.js`);
  }

  if (typeof iina !== "undefined" && iina.utils && typeof iina.utils.resolvePath === "function") {
    const directDist = iina.utils.resolvePath("dist/daemon.js");
    if (directDist) candidates.push(directDist);

    const pluginDist = iina.utils.resolvePath("@plugin/dist/daemon.js");
    if (pluginDist) candidates.push(pluginDist);

    const userPluginsDir = iina.utils.resolvePath("~/Library/Application Support/com.colliderli.iina/plugins");
    if (userPluginsDir) {
      candidates.push(`${userPluginsDir}/io.iina.chromecast.iinaplugin/dist/daemon.js`);
      candidates.push(`${userPluginsDir}/io.iina.chromecast.iinaplugin-dev/dist/daemon.js`);
      candidates.push(`${userPluginsDir}/io.iina.chromecast/dist/daemon.js`);
    }

    const dataDir = (iina.utils.resolvePath("@data") || "").replace(/\/+$/, "");
    if (dataDir) {
      const pluginsDir = dataDir.replace(/\/\.?data(\/.*)?$/, "");
      const pluginDirFromData = dataDir.replace(/\/\.?data\/([^/]+)$/, "/$1");

      candidates.push(`${pluginDirFromData}/dist/daemon.js`);
      candidates.push(`${pluginDirFromData}.iinaplugin/dist/daemon.js`);
      candidates.push(`${pluginDirFromData}.iinaplugin-dev/dist/daemon.js`);

      if (pluginsDir) {
        candidates.push(`${pluginsDir}/io.iina.chromecast.iinaplugin-dev/dist/daemon.js`);
        candidates.push(`${pluginsDir}/io.iina.chromecast.iinaplugin/dist/daemon.js`);
        candidates.push(`${pluginsDir}/io.iina.chromecast/dist/daemon.js`);
      }
    }
  }

  try {
    const cwd = process.cwd();
    if (cwd) candidates.push(`${cwd}/dist/daemon.js`);
  } catch {}

  try {
    if (typeof __dirname !== "undefined" && __dirname) {
      candidates.push(`${__dirname}/daemon.js`);
      candidates.push(`${__dirname}/../dist/daemon.js`);
    }
  } catch {}

  for (const candidate of candidates) {
    const clean = candidate.replace(/\/+/g, "/");
    if (checkFileExists(clean)) {
      CACHE.daemonScript = clean;
      return clean;
    }
  }

  CACHE.daemonScript = null;
  return null;
}

/**
 * Resolves the Node.js executable path on macOS.
 * Priority: Custom preference -> /opt/homebrew/bin/node -> /usr/local/bin/node -> /usr/bin/node -> system PATH.
 */
export function resolveNodeBinary(customPath?: string | null): string {
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (trimmed === "node" || checkFileExists(trimmed)) {
      CACHE.nodePath = trimmed;
      return trimmed;
    }
  }

  if (CACHE.nodePath) return CACHE.nodePath;

  for (const candidate of STANDARD_NODE_PATHS) {
    if (checkFileExists(candidate)) {
      CACHE.nodePath = candidate;
      return candidate;
    }
  }

  if (checkFileExists("node")) {
    CACHE.nodePath = "node";
    return "node";
  }

  CACHE.nodePath = "node";
  return "node";
}

/**
 * Resolves the path to the FFmpeg executable.
 * Priority: Custom preference -> system PATH -> standard Homebrew / MacPorts locations.
 */
export function resolveFfmpegBinary(customPath?: string | null): string | null {
  if (CACHE.ffmpegPath !== undefined && !customPath) {
    return CACHE.ffmpegPath;
  }

  // 1. Custom explicit path from preferences
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (trimmed === "ffmpeg" || checkFileExists(trimmed)) {
      CACHE.ffmpegPath = trimmed;
      return trimmed;
    }
  }

  // 2. Standard macOS locations
  for (const candidate of STANDARD_FFMPEG_PATHS) {
    if (checkFileExists(candidate)) {
      CACHE.ffmpegPath = candidate;
      return candidate;
    }
  }

  CACHE.ffmpegPath = null;
  return null;
}

/**
 * Returns all detected dependencies in a single centralized call.
 */
export function getDependencies(options: {
  customFfmpegPath?: string | null;
  pluginRoot?: string;
} = {}): ResolvedDependencies {
  const daemonScript = resolveDaemonScript(options.pluginRoot);
  const nodePath = resolveNodeBinary();
  const ffmpegPath = resolveFfmpegBinary(options.customFfmpegPath);

  return {
    daemonScript,
    nodePath,
    ffmpegPath,
    hasFfmpeg: Boolean(ffmpegPath),
  };
}

export function resetDependencyCache(): void {
  delete CACHE.daemonScript;
  delete CACHE.nodePath;
  delete CACHE.ffmpegPath;
}
