import { resolveLanguage, t } from "../shared/i18n.js";
import type { PluginState } from "../types/plugin.js";

const { preferences } = iina;

export const state: PluginState = {
  devices: [],
  selectedDeviceId: null,
  castState: "IDLE",
  activeDevice: null,
  mode: "idle",
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

export const runtime = {
  detectedSystemLocale: "en",
  lastSeenFinishedCounter: 0,
  previousCastState: "IDLE",
  suppressLocalEvents: false,
  fileTransitionUntil: 0,
  lastLocalSeekMirrorAt: 0,
  pollTimer: null as NodeJS.Timeout | null,
  currentPollIntervalMs: 0,
  isPolling: false,
  cachedNodeBinary: null as string | null,
  cachedDaemonPath: null as string | null,
  lastSidebarPayloadJson: "",
  lastSyncedPrefsSig: "",
  lastReportedError: null as string | null,
};

export function getActiveLang(): string {
  const pref = preferences.get("language") || "auto";
  return resolveLanguage(
    pref === "auto" ? null : pref,
    runtime.detectedSystemLocale
  );
}

export function tr(key: string, params: Record<string, string | number> = {}): string {
  return t(getActiveLang(), key, params);
}

export function isCastingActive(): boolean {
  return (
    state.activeDevice !== null &&
    ["PLAYING", "PAUSED", "BUFFERING"].includes(state.castState)
  );
}

export function isFileTransitioning(): boolean {
  if (Date.now() < runtime.fileTransitionUntil) return true;
  const currentUrl = iina.core.status.url || "";
  if (state.currentFileUrl && currentUrl !== state.currentFileUrl) {
    runtime.fileTransitionUntil = Date.now() + 2200;
    return true;
  }
  return false;
}
