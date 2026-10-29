import { state, runtime, isCastingActive } from "./state.js";
import {
  ensureDaemonStarted,
  updateAdaptivePolling,
  sendRpc,
  registerClientHooks,
} from "./daemon-client.js";
import {
  syncSidebar,
  probeCurrentFile,
  refreshCurrentMediaInfo,
  setupSidebarHandlers,
  castToDevice,
  notifySidebarFeedback,
} from "./sidebar-bridge.js";
import {
  setupNativeControlsMirroring,
  playNextInPlaylist,
} from "./controls-mirror.js";
import { registerMenuEntries } from "./menu.js";

const { core, event, sidebar, preferences } = iina;

let uiInitialized = false;
let fileLoadedSettleTimer: NodeJS.Timeout | null = null;

export function initPluginUI(): void {
  if (uiInitialized) return;
  uiInitialized = true;

  sidebar.loadFile("ui/sidebar.html");
  setupSidebarHandlers();
  setupNativeControlsMirroring();
  registerMenuEntries();
  ensureDaemonStarted();
  updateAdaptivePolling();
}

registerClientHooks({
  syncSidebar,
  probeCurrentFile,
  playNextInPlaylist,
  notifySidebarFeedback,
});

// Initialize plugin UI, menus, and daemon immediately upon entry
initPluginUI();

event.on("iina.window-loaded", () => {
  initPluginUI();
});

event.on("iina.file-loaded", () => {
  initPluginUI();

  const shouldContinueCasting =
    isCastingActive() ||
    (state.castState === "CONNECTING" && state.activeDevice !== null);
  const targetDeviceId = state.activeDevice?.id || state.selectedDeviceId;

  runtime.fileTransitionUntil = Date.now() + 2500;
  runtime.suppressLocalEvents = true;

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
      castToDevice(targetDeviceId, undefined, true);
    } else {
      probeCurrentFile();
      syncSidebar(true);
    }

    setTimeout(() => {
      runtime.suppressLocalEvents = false;
    }, 900);
  }, 180);
});

event.on("iina.window-will-close", () => {
  if (runtime.pollTimer) {
    clearInterval(runtime.pollTimer);
    runtime.pollTimer = null;
  }
  if (isCastingActive()) {
    sendRpc("stop");
  }
});
