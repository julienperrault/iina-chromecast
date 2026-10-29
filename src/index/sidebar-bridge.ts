import {
  state,
  runtime,
  getActiveLang,
  tr,
} from "./state.js";
import {
  sendRpc,
  pollDaemonState,
  updateAdaptivePolling,
} from "./daemon-client.js";

const { core, sidebar, preferences } = iina;

export function getLocalFilePath(url: string): string {
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

export function getActiveExternalSubtitlePath(): string | null {
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

export function notifySidebarFeedback(
  type: string,
  message: string,
  extra: Record<string, any> = {}
): void {
  sidebar.postMessage("action_feedback", {
    type,
    message,
    timestamp: Date.now(),
    ...extra,
  });
}

export function syncSidebar(force = false): void {
  const { currentTime, volume, muted, modeReason, ...sidebarState } = state;
  const payload = {
    ...sidebarState,
    resolvedLang: getActiveLang(),
    mirrorControlsPref: preferences.get("mirror_iina_controls") !== false,
  };

  const serialized = JSON.stringify(payload);
  if (!force && serialized === runtime.lastSidebarPayloadJson) {
    return;
  }
  runtime.lastSidebarPayloadJson = serialized;
  sidebar.postMessage("state_update", payload);
}

export function refreshCurrentMediaInfo(): void {
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
  state.externalSubtitleName = extSub ? extSub.split("/").pop() || null : null;
}

export async function probeCurrentFile(): Promise<void> {
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

export async function castToDevice(
  deviceId?: string,
  customMode?: "auto" | "remux" | "transcode" | "direct",
  forceStartFromZero = false
): Promise<void> {
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
    currentTime: startTime,
    subtitlePath,
    audioStreamIndex: state.selectedAudioStreamIndex,
    subtitleStreamIndex: state.selectedSubtitleStreamIndex,
    transcodeMode: modeToUse,
  });
}

export async function switchTracksOnCast(
  audioStreamIndex?: number | null,
  subtitleStreamIndex?: number | string | null
): Promise<void> {
  if (audioStreamIndex !== undefined) {
    state.selectedAudioStreamIndex =
      audioStreamIndex === null || String(audioStreamIndex) === ""
        ? null
        : Number(audioStreamIndex);
  }
  if (subtitleStreamIndex !== undefined) {
    state.selectedSubtitleStreamIndex = subtitleStreamIndex;
  }

  const subtitlePath = getActiveExternalSubtitlePath();
  const isCasting =
    state.activeDevice !== null &&
    ["PLAYING", "PAUSED", "BUFFERING"].includes(state.castState);

  if (isCasting) {
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

export function setupSidebarHandlers(): void {
  sidebar.onMessage("ui_ready", (msg: any) => {
    if (msg && msg.systemLocale) {
      runtime.detectedSystemLocale = msg.systemLocale;
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

  sidebar.onMessage("select_device", ({ deviceId }: { deviceId: string }) => {
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

  sidebar.onMessage("start_cast", ({ deviceId }: { deviceId?: string }) => {
    castToDevice(deviceId);
  });

  sidebar.onMessage("stop_cast", async () => {
    await sendRpc("stop");
    notifySidebarFeedback("info", tr("toast.cast_stopped"));
    syncSidebar(true);
  });

  sidebar.onMessage(
    "select_tracks",
    ({
      audioStreamIndex,
      subtitleStreamIndex,
    }: {
      audioStreamIndex?: number | null;
      subtitleStreamIndex?: number | string | null;
    }) => {
      switchTracksOnCast(audioStreamIndex, subtitleStreamIndex);
    }
  );
}
