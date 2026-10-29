import {
  state,
  runtime,
  getActiveLang,
  tr,
  isFileTransitioning,
} from "./state.js";
import type { RpcAction, RpcRequestPayload, DaemonSnapshot } from "../types/rpc.js";

const { core, utils, preferences, http, console } = iina;

export const DAEMON_URL = "http://127.0.0.1:45890";
export const POLL_INTERVAL_ACTIVE_MS = 1000;
export const POLL_INTERVAL_IDLE_MS = 2500;

export function yieldToPluginLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function getPreferencesSignature(): string {
  return JSON.stringify({
    lang: preferences.get("language") || "auto",
    mode: preferences.get("transcode_mode") || "auto",
    hevc: preferences.get("allow_4k_hevc") || "auto",
    vb: preferences.get("video_quality") || "8M",
    res: preferences.get("max_resolution") || "1080",
    ff: preferences.get("ffmpeg_path") || "",
  });
}

export function findNodeBinary(): string {
  const customNode = preferences.get("node_path");
  if (runtime.cachedNodeBinary && !customNode) {
    return runtime.cachedNodeBinary;
  }

  const userCandidates: string[] = [];
  try {
    const nvmBase = utils.resolvePath("~/.nvm/versions/node");
    if (iina.file.exists(nvmBase)) {
      const versions = iina.file.list(nvmBase, { includeSubDir: false }) || [];
      const sorted = versions
        .filter((v: any) => v.isDir)
        .map((v: any) => v.filename)
        .sort()
        .reverse();
      if (sorted.length > 0) {
        userCandidates.push(`${nvmBase}/${sorted[0]}/bin/node`);
      }
    }
  } catch (e) {}

  const candidates = [
    customNode,
    ...userCandidates,
    utils.resolvePath("~/.local/share/fnm/current/bin/node"),
    utils.resolvePath("~/.volta/bin/node"),
    utils.resolvePath("~/.asdf/shims/node"),
    utils.resolvePath("~/.local/bin/node"),
    "/opt/homebrew/bin/node", // Apple Silicon Homebrew
    "/usr/local/bin/node", // Intel Mac Homebrew
    "/opt/local/bin/node", // MacPorts
    "/run/current-system/sw/bin/node", // Nix
    "/usr/bin/node",
    "/bin/node",
    "node",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (utils.fileInPath(bin)) {
      runtime.cachedNodeBinary = bin;
      return bin;
    }
  }
  runtime.cachedNodeBinary = "/opt/homebrew/bin/node";
  return runtime.cachedNodeBinary;
}

export function getDaemonScriptPath(): string {
  if (runtime.cachedDaemonPath) return runtime.cachedDaemonPath;

  const dataDir = (utils.resolvePath("@data") || "").replace(/\/+$/, "");
  const pluginDirFromData = dataDir.replace(/\/\.data\/([^/]+)$/, "/$1");
  const pluginsBase =
    "~/Library/Application Support/com.colliderli.iina/plugins";

  const candidates = [
    pluginDirFromData ? `${pluginDirFromData}/dist/daemon.js` : "",
    utils.resolvePath(
      `${pluginsBase}/io.iina.chromecast.iinaplugin-dev/dist/daemon.js`
    ),
    utils.resolvePath(
      `${pluginsBase}/io.iina.chromecast.iinaplugin/dist/daemon.js`
    ),
    utils.resolvePath("dist/daemon.js"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && utils.fileInPath(candidate)) {
      runtime.cachedDaemonPath = candidate;
      return runtime.cachedDaemonPath;
    }
  }

  runtime.cachedDaemonPath = candidates[0] || utils.resolvePath("dist/daemon.js");
  return runtime.cachedDaemonPath;
}

// Callbacks to be registered by other modules
let onSidebarSyncNeeded: ((force?: boolean) => void) | null = null;
let onProbeNeeded: () => void = null as any;
let onNextPlaylistNeeded: () => boolean = null as any;
let onSidebarFeedback: ((type: string, message: string, extra?: Record<string, any>) => void) | null = null;

export function registerClientHooks(hooks: {
  syncSidebar: (force?: boolean) => void;
  probeCurrentFile: () => void;
  playNextInPlaylist: () => boolean;
  notifySidebarFeedback: (type: string, message: string, extra?: Record<string, any>) => void;
}): void {
  onSidebarSyncNeeded = hooks.syncSidebar;
  onProbeNeeded = hooks.probeCurrentFile;
  onNextPlaylistNeeded = hooks.playNextInPlaylist;
  onSidebarFeedback = hooks.notifySidebarFeedback;
}

export async function sendRpc(
  action: RpcAction,
  payload: RpcRequestPayload = {}
): Promise<any> {
  try {
    const res = await http.post(`${DAEMON_URL}/rpc`, {
      headers: { "Content-Type": "application/json" },
      params: {},
      data: { action, payload: { language: getActiveLang(), ...payload } },
    });
    await yieldToPluginLoop();
    const parsed =
      (res as any)?.data ||
      ((res as any)?.text ? JSON.parse((res as any).text) : null);
    if (parsed) {
      if (parsed.result && parsed.result.devices) {
        applyDaemonSnapshot(parsed.result);
      } else if (parsed.state) {
        applyDaemonSnapshot(parsed.state);
      }
      return parsed.result || parsed;
    }
  } catch (err) {
    // Daemon might still be booting
  }
  return null;
}

export async function ensureDaemonStarted(): Promise<void> {
  try {
    const check = (await http.get(`${DAEMON_URL}/state`, {
      headers: {},
      params: {},
      data: {},
    })) as any;
    await yieldToPluginLoop();
    if (check && check.statusCode === 200) {
      await configureDaemon();
      return;
    }
  } catch (e) {
    // Daemon not running yet, spawn it in detached mode
  }

  const nodeBin = findNodeBinary();
  const daemonPath = getDaemonScriptPath();
  console.log(
    `Spawning detached Chromecast daemon: ${nodeBin} ${daemonPath} --spawn-daemon`
  );

  try {
    await utils.exec(nodeBin, [daemonPath, "--spawn-daemon"]);
  } catch (err) {
    console.error(`Failed to spawn daemon: ${err}`);
  }

  setTimeout(() => {
    configureDaemon();
  }, 350);
}

export async function configureDaemon(): Promise<void> {
  runtime.lastSyncedPrefsSig = getPreferencesSignature();
  await sendRpc("init", {
    language: getActiveLang(),
    ffmpegPath: preferences.get("ffmpeg_path") || "",
    transcodeMode: preferences.get("transcode_mode") || "auto",
    videoBitrate: preferences.get("video_quality") || "8M",
    maxResolution: preferences.get("max_resolution") || "1080",
    allow4kHevc: preferences.get("allow_4k_hevc") || "auto",
  });
  if (onProbeNeeded) onProbeNeeded();
}

export async function pollDaemonState(): Promise<void> {
  if (runtime.isPolling) return;
  runtime.isPolling = true;
  try {
    const currentPrefsSig = getPreferencesSignature();
    if (
      runtime.lastSyncedPrefsSig &&
      currentPrefsSig !== runtime.lastSyncedPrefsSig
    ) {
      await configureDaemon();
    }
    const res = (await http.get(`${DAEMON_URL}/state`, {
      headers: {},
      params: {},
      data: {},
    })) as any;
    await yieldToPluginLoop();
    const parsed = res?.data || (res?.text ? JSON.parse(res.text) : null);
    if (parsed && parsed.state) {
      applyDaemonSnapshot(parsed.state);
    }
  } catch (err) {
    // Ignore transient network errors
  } finally {
    runtime.isPolling = false;
  }
}

export function updateAdaptivePolling(): void {
  const desiredMs =
    state.castState === "IDLE"
      ? POLL_INTERVAL_IDLE_MS
      : POLL_INTERVAL_ACTIVE_MS;
  if (runtime.pollTimer && runtime.currentPollIntervalMs === desiredMs) {
    return;
  }
  if (runtime.pollTimer) {
    clearInterval(runtime.pollTimer);
  }
  runtime.currentPollIntervalMs = desiredMs;
  runtime.pollTimer = setInterval(() => {
    pollDaemonState();
  }, desiredMs);
}

export function applyDaemonSnapshot(snap: DaemonSnapshot): void {
  if (!snap) return;

  if (Array.isArray(snap.devices)) {
    const prevCount = state.devices.length;
    state.devices = snap.devices;
    if (!state.selectedDeviceId && state.devices.length > 0) {
      state.selectedDeviceId = state.devices[0].id;
    }
    if (prevCount === 0 && state.devices.length > 0 && onProbeNeeded) {
      onProbeNeeded();
    }
  }

  state.castState = snap.castState || "IDLE";
  state.activeDevice = snap.activeDevice || null;
  state.mode = snap.mode || "idle";
  state.modeReason = snap.modeReason || "";
  if (snap.mediaInfo) {
    state.mediaInfo = snap.mediaInfo;
  }
  if (snap.compatibility) {
    state.probeCompatibility = snap.compatibility;
  }
  if (
    snap.castState !== "IDLE" &&
    snap.audioStreamIndex !== undefined &&
    snap.audioStreamIndex !== null
  ) {
    state.selectedAudioStreamIndex = snap.audioStreamIndex;
  }
  if (
    snap.castState !== "IDLE" &&
    snap.subtitleStreamIndex !== undefined &&
    snap.subtitleStreamIndex !== null
  ) {
    state.selectedSubtitleStreamIndex = snap.subtitleStreamIndex;
  }
  if (typeof snap.duration === "number" && snap.duration > 0) {
    state.duration = snap.duration;
  }
  if (typeof snap.volume === "number") {
    state.volume = snap.volume;
  }
  if (typeof snap.muted === "boolean") {
    state.muted = snap.muted;
  }
  state.error = snap.error || null;

  // Transition into PLAYING
  if (state.castState === "PLAYING" && runtime.previousCastState !== "PLAYING") {
    const modeLabel =
      state.mode === "direct"
        ? tr("mode.direct.short")
        : state.mode === "remux"
        ? tr("mode.remux.short")
        : state.mode === "transcode"
        ? tr("mode.transcode.short")
        : tr("mode.remote.short");
    const devName = state.activeDevice?.name || "Chromecast";
    core.osd(tr("osd.connected", { name: devName, mode: modeLabel }));
    if (onSidebarFeedback) {
      onSidebarFeedback("success", tr("toast.cast_active", { name: devName }));
    }

    if (
      preferences.get("pause_local_on_cast") !== false &&
      Date.now() >= runtime.fileTransitionUntil &&
      !core.status.paused
    ) {
      runtime.suppressLocalEvents = true;
      core.pause();
      setTimeout(() => {
        runtime.suppressLocalEvents = false;
      }, 850);
    }
  }
  runtime.previousCastState = state.castState;
  updateAdaptivePolling();

  // Keep IINA's timeline bar synchronized
  if (typeof snap.currentTime === "number") {
    state.currentTime = snap.currentTime;
    if (
      state.castState === "PLAYING" &&
      !runtime.suppressLocalEvents &&
      !isFileTransitioning() &&
      core.status.paused &&
      Date.now() - runtime.lastLocalSeekMirrorAt > 3000 &&
      Math.abs((core.status.position || 0) - snap.currentTime) > 3
    ) {
      runtime.suppressLocalEvents = true;
      core.seekTo(snap.currentTime);
      setTimeout(() => {
        runtime.suppressLocalEvents = false;
      }, 850);
    }
  }

  // Handle automatic playlist advancement on media finished
  if (
    typeof snap.finishedCounter === "number" &&
    snap.finishedCounter > runtime.lastSeenFinishedCounter
  ) {
    runtime.lastSeenFinishedCounter = snap.finishedCounter;
    if (
      preferences.get("auto_next_playlist") !== false &&
      onNextPlaylistNeeded
    ) {
      onNextPlaylistNeeded();
    }
  }

  if (onSidebarSyncNeeded) {
    onSidebarSyncNeeded();
  }
}
