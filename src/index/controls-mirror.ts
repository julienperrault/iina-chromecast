import {
  state,
  runtime,
  tr,
  isCastingActive,
  isFileTransitioning,
} from "./state.js";
import { sendRpc } from "./daemon-client.js";
import {
  refreshCurrentMediaInfo,
  syncSidebar,
  switchTracksOnCast,
  notifySidebarFeedback,
} from "./sidebar-bridge.js";

const { core, event, playlist, preferences } = iina;

export function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

export function playNextInPlaylist(): boolean {
  try {
    const items = playlist.list() || [];
    const idx = items.findIndex((i: any) => i.isPlaying || i.isCurrent);
    if (idx >= 0 && idx + 1 < items.length) {
      core.osd(tr("osd.next_episode"));
      notifySidebarFeedback("info", tr("toast.next_episode"));
      playlist.playNext();
      return true;
    }
  } catch (e) {}
  return false;
}

export function setupNativeControlsMirroring(): void {
  let pauseMirrorDebounceTimer: NodeJS.Timeout | null = null;
  let seekMirrorDebounceTimer: NodeJS.Timeout | null = null;
  let volumeMirrorDebounceTimer: NodeJS.Timeout | null = null;
  let sidMirrorDebounceTimer: NodeJS.Timeout | null = null;
  let aidMirrorDebounceTimer: NodeJS.Timeout | null = null;

  event.on("mpv.start-file", () => {
    runtime.fileTransitionUntil = Date.now() + 2500;
    runtime.suppressLocalEvents = true;
  });

  event.on("mpv.end-file", () => {
    runtime.fileTransitionUntil = Date.now() + 2500;
    runtime.suppressLocalEvents = true;
  });

  event.on("mpv.pause.changed", () => {
    if (
      runtime.suppressLocalEvents ||
      Date.now() < runtime.fileTransitionUntil ||
      !isCastingActive()
    )
      return;
    if (preferences.get("mirror_iina_controls") === false) return;

    if (pauseMirrorDebounceTimer) clearTimeout(pauseMirrorDebounceTimer);
    pauseMirrorDebounceTimer = setTimeout(() => {
      if (
        runtime.suppressLocalEvents ||
        isFileTransitioning() ||
        !isCastingActive()
      )
        return;
      const localPaused = core.status.paused;
      if (!localPaused) {
        runtime.suppressLocalEvents = true;
        core.pause();
        setTimeout(() => {
          runtime.suppressLocalEvents = false;
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
    if (
      runtime.suppressLocalEvents ||
      Date.now() < runtime.fileTransitionUntil ||
      !isCastingActive()
    )
      return;
    if (preferences.get("mirror_iina_controls") === false) return;

    if (seekMirrorDebounceTimer) clearTimeout(seekMirrorDebounceTimer);
    seekMirrorDebounceTimer = setTimeout(() => {
      if (
        runtime.suppressLocalEvents ||
        isFileTransitioning() ||
        !isCastingActive()
      )
        return;
      const newPos = core.status.position;
      if (
        typeof newPos === "number" &&
        Math.abs(newPos - (state.currentTime || 0)) > 4
      ) {
        runtime.lastLocalSeekMirrorAt = Date.now();
        state.currentTime = newPos;
        const targetSec = Math.floor(newPos);
        core.osd(tr("osd.seek", { time: formatSeconds(targetSec) }));
        sendRpc("seek", { currentTime: targetSec });
      }
    }, 180);
  });

  event.on("mpv.volume.changed", () => {
    if (
      runtime.suppressLocalEvents ||
      Date.now() < runtime.fileTransitionUntil ||
      !isCastingActive()
    )
      return;
    if (preferences.get("mirror_iina_controls") === false) return;

    if (volumeMirrorDebounceTimer) clearTimeout(volumeMirrorDebounceTimer);
    volumeMirrorDebounceTimer = setTimeout(() => {
      if (
        runtime.suppressLocalEvents ||
        isFileTransitioning() ||
        !isCastingActive()
      )
        return;
      const vol =
        Math.max(0, Math.min(100, core.audio.volume || 100)) / 100;
      sendRpc("volume", { volume: vol });
    }, 80);
  });

  event.on("mpv.mute.changed", () => {
    if (
      runtime.suppressLocalEvents ||
      Date.now() < runtime.fileTransitionUntil ||
      !isCastingActive()
    )
      return;
    if (preferences.get("mirror_iina_controls") === false) return;

    setTimeout(() => {
      if (
        runtime.suppressLocalEvents ||
        isFileTransitioning() ||
        !isCastingActive()
      )
        return;
      sendRpc("volume", { muted: Boolean(core.audio.muted) });
    }, 80);
  });

  event.on("mpv.sid.changed", () => {
    if (
      runtime.suppressLocalEvents ||
      Date.now() < runtime.fileTransitionUntil
    )
      return;
    if (sidMirrorDebounceTimer) clearTimeout(sidMirrorDebounceTimer);
    sidMirrorDebounceTimer = setTimeout(() => {
      if (runtime.suppressLocalEvents || isFileTransitioning()) return;
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
        const summary =
          state.mediaInfo || state.probeCompatibility?.summary;
        const subTracks = summary?.subtitleTracks || [];
        const mapped = subTracks[subTrack.id - 1];
        if (mapped) {
          switchTracksOnCast(undefined, mapped.streamIndex);
        }
      }
    }, 250);
  });

  event.on("mpv.aid.changed", () => {
    if (
      runtime.suppressLocalEvents ||
      Date.now() < runtime.fileTransitionUntil
    )
      return;
    if (aidMirrorDebounceTimer) clearTimeout(aidMirrorDebounceTimer);
    aidMirrorDebounceTimer = setTimeout(() => {
      if (runtime.suppressLocalEvents || isFileTransitioning()) return;
      refreshCurrentMediaInfo();
      if (!isCastingActive()) {
        syncSidebar();
        return;
      }
      const audioTrack = core.audio.currentTrack;
      if (audioTrack) {
        const summary =
          state.mediaInfo || state.probeCompatibility?.summary;
        const audioTracks = summary?.audioTracks || [];
        const mapped = audioTracks[audioTrack.id - 1];
        if (mapped) {
          switchTracksOnCast(mapped.streamIndex, undefined);
        }
      }
    }, 250);
  });
}
