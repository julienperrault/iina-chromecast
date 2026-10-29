/**
 * IINA Chromecast Plugin - Main Entry Point
 * Architecture designed specifically for IINA 1.5 thread-safety:
 * - Spawns the Node.js Chromecast daemon in detached mode (`--spawn-daemon`) so `utils.exec()`
 *   exits in <50ms without blocking IINA's serial plugin DispatchQueue (`waitUntilExit`).
 * - Communicates with the daemon via `http.get` / `http.post` on `127.0.0.1:45890`.
 * - Avoids calling `menu.forceUpdate()` inside async callbacks to prevent the JSC Lock / MainThread deadlock.
 */

const { core, event, menu, sidebar, playlist, utils, preferences, http, console } = iina;
const { resolveLanguage, t } = require("./i18n");

const DAEMON_URL = "http://127.0.0.1:45890";
const POLL_INTERVAL_ACTIVE_MS = 1000;
const POLL_INTERVAL_IDLE_MS = 2500;
let detectedSystemLocale = "en";

function getActiveLang() {
  const pref = preferences.get("language") || "auto";
  return resolveLanguage(pref === "auto" ? null : pref, detectedSystemLocale);
}

function tr(key, params = {}) {
  return t(getActiveLang(), key, params);
}

let state = {
  devices: [],
  selectedDeviceId: null,
  castState: "IDLE", // "IDLE" | "ANALYZING" | "CONNECTING" | "PLAYING" | "PAUSED" | "BUFFERING"
  activeDevice: null,
  mode: "idle", // "idle" | "direct" | "remux" | "transcode" | "remote"
  modeReason: "",
  mediaInfo: null,
  probeCompatibility: null,
  selectedAudioStreamIndex: null,
  selectedSubtitleStreamIndex: null,
  externalSubtitleName: null,
  currentFileUrl: "",
  currentFilePath: "",
  currentTitle: "",
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  error: null,
};

let lastSeenFinishedCounter = 0;
let previousCastState = "IDLE";
let suppressLocalEvents = false;
let fileTransitionUntil = 0;
let lastLocalSeekMirrorAt = 0;
let pollTimer = null;
let currentPollIntervalMs = 0;
let isPolling = false;
let cachedNodeBinary = null;
let cachedDaemonPath = null;
let lastSidebarPayloadJson = "";
let lastSyncedPrefsSig = "";

function getPreferencesSignature() {
  return JSON.stringify({
    lang: preferences.get("language") || "auto",
    mode: preferences.get("transcode_mode") || "auto",
    hevc: preferences.get("allow_4k_hevc") || "auto",
    vb: preferences.get("video_quality") || "8M",
    res: preferences.get("max_resolution") || "1080",
    ff: preferences.get("ffmpeg_path") || "",
  });
}

// Bounces execution off Just.HTTP's background thread onto IINA's plugin timer loop
// to prevent JSC lock + MainThread / MPVQueue deadlocks when calling core.* or sidebar.*
function yieldToPluginLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isFileTransitioning() {
  if (Date.now() < fileTransitionUntil) return true;
  const currentUrl = core.status.url || "";
  if (state.currentFileUrl && currentUrl !== state.currentFileUrl) {
    fileTransitionUntil = Date.now() + 2200;
    return true;
  }
  return false;
}

// --- Utility: Find Node & Daemon ---
function findNodeBinary() {
  const customNode = preferences.get("node_path");
  if (cachedNodeBinary && !customNode) {
    return cachedNodeBinary;
  }

  const userCandidates = [];
  try {
    const nvmBase = utils.resolvePath("~/.nvm/versions/node");
    if (iina.file.exists(nvmBase)) {
      const versions = iina.file.list(nvmBase, { includeSubDir: false }) || [];
      const sorted = versions
        .filter((v) => v.isDir)
        .map((v) => v.filename)
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
    "/usr/local/bin/node",   // Intel Mac Homebrew
    "/opt/local/bin/node",    // MacPorts
    "/run/current-system/sw/bin/node", // Nix
    "/usr/bin/node",
    "/bin/node",
    "node",
  ].filter(Boolean);

  for (const bin of candidates) {
    if (utils.fileInPath(bin)) {
      cachedNodeBinary = bin;
      return bin;
    }
  }
  cachedNodeBinary = "/opt/homebrew/bin/node";
  return cachedNodeBinary;
}

function getDaemonScriptPath() {
  if (cachedDaemonPath) return cachedDaemonPath;

  const dataDir = (utils.resolvePath("@data") || "").replace(/\/+$/, "");
  const pluginDirFromData = dataDir.replace(/\/\.data\/([^/]+)$/, "/$1");
  const pluginsBase = "~/Library/Application Support/com.colliderli.iina/plugins";

  const candidates = [
    pluginDirFromData ? `${pluginDirFromData}/dist/daemon.js` : "",
    utils.resolvePath(`${pluginsBase}/io.iina.chromecast.iinaplugin-dev/dist/daemon.js`),
    utils.resolvePath(`${pluginsBase}/io.iina.chromecast.iinaplugin/dist/daemon.js`),
    utils.resolvePath("dist/daemon.js"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && utils.fileInPath(candidate)) {
      cachedDaemonPath = candidate;
      return cachedDaemonPath;
    }
  }

  cachedDaemonPath = candidates[0] || utils.resolvePath("dist/daemon.js");
  return cachedDaemonPath;
}

function getLocalFilePath(url) {
  if (!url) return "";
  if (url.startsWith("file://")) {
    try {
      return decodeURIComponent(url.replace(/^file:\/\//, ""));
    } catch (e) {
      return url.replace(/^file:\/\//, "");
    }
  }
  if (url.startsWith("/")) {
    return url;
  }
  return "";
}

function getActiveExternalSubtitlePath() {
  if (preferences.get("enable_subtitles") === false) return null;
  try {
    const currentSub = core.subtitle.currentTrack;
    if (currentSub && currentSub.isExternal) {
      const extFile = iina.mpv.getString("current-tracks/sub/external-filename");
      if (extFile) return getLocalFilePath(extFile) || extFile;
    }
  } catch (e) {}
  return null;
}

function notifySidebarFeedback(type, message, extra = {}) {
  sidebar.postMessage("action_feedback", {
    type,
    message,
    timestamp: Date.now(),
    ...extra,
  });
}

// --- Non-blocking Daemon Launcher & HTTP RPC ---
async function ensureDaemonStarted() {
  try {
    const check = await http.get(`${DAEMON_URL}/state`, {
      headers: {},
      params: {},
      data: {},
    });
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
  console.log(`Spawning detached Chromecast daemon: ${nodeBin} ${daemonPath} --spawn-daemon`);

  try {
    await utils.exec(nodeBin, [daemonPath, "--spawn-daemon"]);
  } catch (err) {
    console.error(`Failed to spawn daemon: ${err}`);
  }

  setTimeout(() => {
    configureDaemon();
  }, 350);
}

async function configureDaemon() {
  lastSyncedPrefsSig = getPreferencesSignature();
  await sendRpc("init", {
    language: getActiveLang(),
    ffmpegPath: preferences.get("ffmpeg_path") || "",
    transcodeMode: preferences.get("transcode_mode") || "auto",
    videoBitrate: preferences.get("video_quality") || "8M",
    maxResolution: preferences.get("max_resolution") || "1080",
    allow4kHevc: preferences.get("allow_4k_hevc") || "auto",
  });
  probeCurrentFile();
}

async function sendRpc(action, payload = {}) {
  try {
    const res = await http.post(`${DAEMON_URL}/rpc`, {
      headers: { "Content-Type": "application/json" },
      params: {},
      data: { action, payload: { language: getActiveLang(), ...payload } },
    });
    await yieldToPluginLoop();
    const parsed = res?.data || (res?.text ? JSON.parse(res.text) : null);
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

async function pollDaemonState() {
  if (isPolling) return;
  isPolling = true;
  try {
    const currentPrefsSig = getPreferencesSignature();
    if (lastSyncedPrefsSig && currentPrefsSig !== lastSyncedPrefsSig) {
      await configureDaemon();
    }
    const res = await http.get(`${DAEMON_URL}/state`, {
      headers: {},
      params: {},
      data: {},
    });
    await yieldToPluginLoop();
    const parsed = res?.data || (res?.text ? JSON.parse(res.text) : null);
    if (parsed && parsed.state) {
      applyDaemonSnapshot(parsed.state);
    }
  } catch (err) {
    // Ignore transient network errors
  } finally {
    isPolling = false;
  }
}

function updateAdaptivePolling() {
  const desiredMs =
    state.castState === "IDLE" ? POLL_INTERVAL_IDLE_MS : POLL_INTERVAL_ACTIVE_MS;
  if (pollTimer && currentPollIntervalMs === desiredMs) {
    return;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  currentPollIntervalMs = desiredMs;
  pollTimer = setInterval(() => {
    pollDaemonState();
  }, desiredMs);
}

function applyDaemonSnapshot(snap) {
  if (!snap) return;

  if (Array.isArray(snap.devices)) {
    const prevCount = state.devices.length;
    state.devices = snap.devices;
    if (!state.selectedDeviceId && state.devices.length > 0) {
      state.selectedDeviceId = state.devices[0].id;
    }
    if (prevCount === 0 && state.devices.length > 0) {
      probeCurrentFile();
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
  if (state.castState === "PLAYING" && previousCastState !== "PLAYING") {
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
    notifySidebarFeedback(
      "success",
      tr("toast.cast_active", { name: devName })
    );

    if (
      preferences.get("pause_local_on_cast") !== false &&
      Date.now() >= fileTransitionUntil &&
      !core.status.paused
    ) {
      suppressLocalEvents = true;
      core.pause();
      setTimeout(() => {
        suppressLocalEvents = false;
      }, 850);
    }
  }
  previousCastState = state.castState;
  updateAdaptivePolling();

  // Keep IINA's timeline bar gently synchronized while casting (never during file transitions)
  if (typeof snap.currentTime === "number") {
    state.currentTime = snap.currentTime;
    if (
      state.castState === "PLAYING" &&
      !suppressLocalEvents &&
      !isFileTransitioning() &&
      core.status.paused &&
      Date.now() - lastLocalSeekMirrorAt > 3000 &&
      Math.abs((core.status.position || 0) - snap.currentTime) > 3
    ) {
      suppressLocalEvents = true;
      core.seekTo(snap.currentTime);
      setTimeout(() => {
        suppressLocalEvents = false;
      }, 850);
    }
  }

  // Handle automatic playlist advancement on media finished
  if (
    typeof snap.finishedCounter === "number" &&
    snap.finishedCounter > lastSeenFinishedCounter
  ) {
    lastSeenFinishedCounter = snap.finishedCounter;
    if (preferences.get("auto_next_playlist") !== false) {
      playNextInPlaylist();
    }
  }

  syncSidebar();
}

// --- Media & Playlist Helpers ---
function refreshCurrentMediaInfo() {
  const url = core.status.url || "";
  const title = core.status.title || "Vidéo IINA";
  const filePath = getLocalFilePath(url);

  if (filePath !== state.currentFilePath) {
    state.selectedAudioStreamIndex = null;
    state.selectedSubtitleStreamIndex = null;
    state.probeCompatibility = null;
  }

  state.currentFileUrl = url;
  state.currentFilePath = filePath;
  state.currentTitle = title;
  state.duration = core.status.duration || state.duration || 0;

  const extSub = getActiveExternalSubtitlePath();
  state.externalSubtitleName = extSub ? extSub.split("/").pop() : null;
}

async function probeCurrentFile() {
  refreshCurrentMediaInfo();
  if (!state.currentFilePath) {
    syncSidebar();
    return;
  }

  const targetDeviceId =
    state.activeDevice?.id || state.selectedDeviceId || state.devices[0]?.id;
  const res = await sendRpc("probe", {
    filePath: state.currentFilePath,
    deviceId: targetDeviceId,
    audioStreamIndex: state.selectedAudioStreamIndex,
    transcodeMode: preferences.get("transcode_mode") || "auto",
  });

  if (res && res.compatibility) {
    state.probeCompatibility = res.compatibility;
    const summary = res.compatibility.summary;
    if (summary) {
      if (state.selectedAudioStreamIndex === null) {
        state.selectedAudioStreamIndex = summary.selectedAudioStreamIndex;
      }
      if (state.selectedSubtitleStreamIndex === null) {
        const extSub = getActiveExternalSubtitlePath();
        state.selectedSubtitleStreamIndex = extSub
          ? "external"
          : summary.embeddedSubIndex ?? "none";
      }
    }
    syncSidebar(true);
  }
}

function playNextInPlaylist() {
  try {
    const items = playlist.list() || [];
    const idx = items.findIndex((i) => i.isPlaying || i.isCurrent);
    if (idx >= 0 && idx + 1 < items.length) {
      core.osd(tr("osd.next_episode"));
      notifySidebarFeedback("info", tr("toast.next_episode"));
      playlist.playNext();
      return true;
    }
  } catch (e) {}
  return false;
}

async function castToDevice(deviceId, customMode, forceStartFromZero = false) {
  const targetId = deviceId || state.selectedDeviceId || state.devices[0]?.id;
  if (!targetId) {
    core.osd(tr("osd.no_device"));
    notifySidebarFeedback("warning", tr("toast.select_device_first"));
    sidebar.show();
    return;
  }

  state.selectedDeviceId = targetId;
  refreshCurrentMediaInfo();

  if (!state.currentFilePath && !state.currentFileUrl) {
    core.osd(tr("osd.no_video"));
    notifySidebarFeedback("warning", tr("toast.open_video_first"));
    return;
  }

  const startTime =
    !forceStartFromZero && preferences.get("resume_from_position") !== false
      ? Math.floor(core.status.position || 0)
      : 0;

  const modeToUse = customMode || preferences.get("transcode_mode") || "auto";
  const subtitlePath = getActiveExternalSubtitlePath();

  const dev = state.devices.find((d) => d.id === targetId);
  const devName = dev ? dev.name : "Chromecast";
  core.osd(tr("osd.connecting", { name: devName }));
  notifySidebarFeedback("loading", tr("toast.connecting", { name: devName }));

  state.castState = "CONNECTING";
  updateAdaptivePolling();
  syncSidebar(true);

  await sendRpc("cast", {
    deviceId: targetId,
    filePath: state.currentFilePath,
    url: state.currentFileUrl,
    title: state.currentTitle,
    startTime,
    subtitlePath,
    audioStreamIndex: state.selectedAudioStreamIndex,
    subtitleStreamIndex: state.selectedSubtitleStreamIndex,
    transcodeMode: modeToUse,
  });
}

async function switchTracksOnCast(audioStreamIndex, subtitleStreamIndex) {
  if (audioStreamIndex !== undefined) {
    state.selectedAudioStreamIndex =
      audioStreamIndex === null || audioStreamIndex === ""
        ? null
        : Number(audioStreamIndex);
  }
  if (subtitleStreamIndex !== undefined) {
    state.selectedSubtitleStreamIndex = subtitleStreamIndex;
  }

  const subtitlePath = getActiveExternalSubtitlePath();
  if (isCastingActive()) {
    core.osd(tr("osd.switching_track"));
    notifySidebarFeedback("loading", tr("toast.applying_track"));
    await sendRpc("select_tracks", {
      audioStreamIndex: state.selectedAudioStreamIndex,
      subtitleStreamIndex: state.selectedSubtitleStreamIndex,
      externalSubtitlePath: subtitlePath,
    });
    notifySidebarFeedback("success", tr("toast.track_updated_cast"));
  } else {
    await probeCurrentFile();
    notifySidebarFeedback("success", tr("toast.track_selected"));
  }
  syncSidebar(true);
}

function isCastingActive() {
  return (
    state.activeDevice !== null &&
    ["PLAYING", "PAUSED", "BUFFERING"].includes(state.castState)
  );
}

// --- Native IINA Controls Mirroring to Chromecast ---
function setupNativeControlsMirroring() {
  let pauseMirrorDebounceTimer = null;
  let seekMirrorDebounceTimer = null;
  let volumeMirrorDebounceTimer = null;
  let sidMirrorDebounceTimer = null;
  let aidMirrorDebounceTimer = null;

  // Detect file transitions early (before iina.file-loaded) so track/pause events during load are ignored
  event.on("mpv.start-file", () => {
    fileTransitionUntil = Date.now() + 2500;
    suppressLocalEvents = true;
  });

  event.on("mpv.end-file", () => {
    fileTransitionUntil = Date.now() + 2500;
    suppressLocalEvents = true;
  });

  event.on("mpv.pause.changed", () => {
    if (suppressLocalEvents || Date.now() < fileTransitionUntil || !isCastingActive()) return;
    if (preferences.get("mirror_iina_controls") === false) return;

    if (pauseMirrorDebounceTimer) clearTimeout(pauseMirrorDebounceTimer);
    pauseMirrorDebounceTimer = setTimeout(() => {
      if (suppressLocalEvents || isFileTransitioning() || !isCastingActive()) return;
      const localPaused = core.status.paused;
      if (!localPaused) {
        suppressLocalEvents = true;
        core.pause();
        setTimeout(() => {
          suppressLocalEvents = false;
        }, 350);

        if (state.castState === "PAUSED") {
          core.osd(tr("osd.play"));
          sendRpc("play");
        } else if (state.castState === "PLAYING") {
          core.osd(tr("osd.pause"));
          sendRpc("pause");
        }
      }
    }, 90);
  });

  event.on("mpv.playback-restart", () => {
    if (suppressLocalEvents || Date.now() < fileTransitionUntil || !isCastingActive()) return;
    if (preferences.get("mirror_iina_controls") === false) return;

    if (seekMirrorDebounceTimer) clearTimeout(seekMirrorDebounceTimer);
    seekMirrorDebounceTimer = setTimeout(() => {
      if (suppressLocalEvents || isFileTransitioning() || !isCastingActive()) return;
      const newPos = core.status.position;
      if (
        typeof newPos === "number" &&
        Math.abs(newPos - (state.currentTime || 0)) > 4
      ) {
        lastLocalSeekMirrorAt = Date.now();
        state.currentTime = newPos;
        const targetSec = Math.floor(newPos);
        core.osd(tr("osd.seek", { time: formatSeconds(targetSec) }));
        sendRpc("seek", { time: targetSec });
      }
    }, 180);
  });

  event.on("mpv.volume.changed", () => {
    if (suppressLocalEvents || Date.now() < fileTransitionUntil || !isCastingActive()) return;
    if (preferences.get("mirror_iina_controls") === false) return;

    if (volumeMirrorDebounceTimer) clearTimeout(volumeMirrorDebounceTimer);
    volumeMirrorDebounceTimer = setTimeout(() => {
      if (suppressLocalEvents || isFileTransitioning() || !isCastingActive()) return;
      const vol = Math.max(0, Math.min(100, core.audio.volume || 100)) / 100;
      sendRpc("volume", { level: vol });
    }, 80);
  });

  event.on("mpv.mute.changed", () => {
    if (suppressLocalEvents || Date.now() < fileTransitionUntil || !isCastingActive()) return;
    if (preferences.get("mirror_iina_controls") === false) return;

    setTimeout(() => {
      if (suppressLocalEvents || isFileTransitioning() || !isCastingActive()) return;
      sendRpc("volume", { muted: Boolean(core.audio.muted) });
    }, 80);
  });

  // Mirror Subtitle Track changes made directly in IINA's UI
  event.on("mpv.sid.changed", () => {
    if (suppressLocalEvents || Date.now() < fileTransitionUntil) return;
    if (sidMirrorDebounceTimer) clearTimeout(sidMirrorDebounceTimer);
    sidMirrorDebounceTimer = setTimeout(() => {
      if (suppressLocalEvents || isFileTransitioning()) return;
      refreshCurrentMediaInfo();
      if (!isCastingActive()) {
        syncSidebar();
        return;
      }
      const subTrack = core.subtitle.currentTrack;
      if (!subTrack) {
        switchTracksOnCast(undefined, "none");
      } else if (subTrack.isExternal) {
        switchTracksOnCast(undefined, "external");
      } else {
        const summary = state.mediaInfo || state.probeCompatibility?.summary;
        const subTracks = summary?.subtitleTracks || [];
        const mapped = subTracks[subTrack.id - 1];
        if (mapped) {
          switchTracksOnCast(undefined, mapped.streamIndex);
        }
      }
    }, 250);
  });

  // Mirror Audio Track changes made directly in IINA's UI
  event.on("mpv.aid.changed", () => {
    if (suppressLocalEvents || Date.now() < fileTransitionUntil) return;
    if (aidMirrorDebounceTimer) clearTimeout(aidMirrorDebounceTimer);
    aidMirrorDebounceTimer = setTimeout(() => {
      if (suppressLocalEvents || isFileTransitioning()) return;
      refreshCurrentMediaInfo();
      if (!isCastingActive()) {
        syncSidebar();
        return;
      }
      const audioTrack = core.audio.currentTrack;
      if (audioTrack) {
        const summary = state.mediaInfo || state.probeCompatibility?.summary;
        const audioTracks = summary?.audioTracks || [];
        const mapped = audioTracks[audioTrack.id - 1];
        if (mapped) {
          switchTracksOnCast(mapped.streamIndex, undefined);
        }
      }
    }, 250);
  });
}

function formatSeconds(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

// --- Sidebar Webview Integration ---
function syncSidebar(force = false) {
  const { currentTime, volume, muted, modeReason, ...sidebarState } = state;
  const payload = {
    ...sidebarState,
    resolvedLang: getActiveLang(),
    mirrorControlsPref: preferences.get("mirror_iina_controls") !== false,
  };

  const serialized = JSON.stringify(payload);
  if (!force && serialized === lastSidebarPayloadJson) {
    return;
  }
  lastSidebarPayloadJson = serialized;
  sidebar.postMessage("state_update", payload);
}

function setupSidebarHandlers() {
  sidebar.onMessage("ui_ready", (msg) => {
    if (msg && msg.systemLocale) {
      detectedSystemLocale = msg.systemLocale;
    }
    refreshCurrentMediaInfo();
    probeCurrentFile();
    syncSidebar(true);
  });

  sidebar.onMessage("scan_devices", async () => {
    await sendRpc("scan");
    setTimeout(async () => {
      await pollDaemonState();
      const count = state.devices.length;
      const msg =
        count > 1
          ? tr("toast.scan_found_many", { count })
          : count === 1
          ? tr("toast.scan_found_one")
          : tr("toast.scan_none");
      notifySidebarFeedback(count > 0 ? "success" : "warning", msg, {
        scanCompleted: true,
        deviceCount: count,
      });
      syncSidebar(true);
    }, 950);
  });

  sidebar.onMessage("select_device", ({ deviceId }) => {
    state.selectedDeviceId = deviceId;
    const dev = state.devices.find((d) => d.id === deviceId);
    if (dev) {
      notifySidebarFeedback(
        "success",
        tr("toast.device_selected", { name: dev.name })
      );
    }
    probeCurrentFile();
    syncSidebar(true);
  });

  sidebar.onMessage("start_cast", ({ deviceId }) => {
    castToDevice(deviceId);
  });

  sidebar.onMessage("stop_cast", async () => {
    await sendRpc("stop");
    notifySidebarFeedback("info", tr("toast.cast_stopped"));
    syncSidebar(true);
  });

  sidebar.onMessage("select_tracks", ({ audioStreamIndex, subtitleStreamIndex }) => {
    switchTracksOnCast(audioStreamIndex, subtitleStreamIndex);
  });
}

// --- Static Menu Registration (No dynamic menu.forceUpdate() calls!) ---
menu.addItem(
  menu.item(
    tr("menu.open_sidebar"),
    () => {
      sidebar.show();
    },
    { keyBinding: "Alt+c" }
  )
);

menu.addItem(
  menu.item(tr("menu.cast_selected"), () => {
    castToDevice();
  })
);

menu.addItem(
  menu.item(tr("menu.play_pause"), () => {
    if (state.castState === "PAUSED") {
      sendRpc("play");
    } else {
      sendRpc("pause");
    }
  })
);

menu.addItem(
  menu.item(tr("menu.stop_cast"), () => {
    sendRpc("stop");
  })
);

// --- IINA Event Listeners ---
let uiInitialized = false;
let fileLoadedSettleTimer = null;

function initPluginUI() {
  if (uiInitialized) return;
  uiInitialized = true;

  sidebar.loadFile("ui/sidebar.html");
  setupSidebarHandlers();
  setupNativeControlsMirroring();
  ensureDaemonStarted();
  updateAdaptivePolling();
}

event.on("iina.window-loaded", () => {
  initPluginUI();
});

event.on("iina.file-loaded", () => {
  initPluginUI();

  const shouldContinueCasting =
    isCastingActive() ||
    (state.castState === "CONNECTING" && state.activeDevice !== null);
  const targetDeviceId = state.activeDevice?.id || state.selectedDeviceId;

  fileTransitionUntil = Date.now() + 2500;
  suppressLocalEvents = true;

  if (fileLoadedSettleTimer) clearTimeout(fileLoadedSettleTimer);
  fileLoadedSettleTimer = setTimeout(() => {
    refreshCurrentMediaInfo();
    state.currentTime = 0;

    if (shouldContinueCasting && targetDeviceId) {
      if (
        preferences.get("pause_local_on_cast") !== false &&
        !core.status.paused
      ) {
        core.pause();
      }
      castToDevice(targetDeviceId, null, true);
    } else {
      probeCurrentFile();
      syncSidebar(true);
    }

    setTimeout(() => {
      suppressLocalEvents = false;
    }, 900);
  }, 180);
});

event.on("iina.window-will-close", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (isCastingActive()) {
    sendRpc("stop");
  }
});
