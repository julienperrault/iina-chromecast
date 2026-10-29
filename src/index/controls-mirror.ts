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

function createDebouncedMirrorHandler(
  delayMs: number,
  handler: () => void,
  requiresMirrorPref = true
): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (runtime.suppressLocalEvents || Date.now() < runtime.fileTransitionUntil) {
      return;
    }
    if (
      requiresMirrorPref &&
      (preferences.get("mirror_iina_controls") === false || !isCastingActive())
    ) {
      return;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (runtime.suppressLocalEvents || isFileTransitioning()) return;
      if (requiresMirrorPref && !isCastingActive()) return;
      handler();
    }, delayMs);
  };
}

export function setupNativeControlsMirroring(): void {
  const onFileBoundary = () => {
    runtime.fileTransitionUntil = Date.now() + 2500;
    runtime.suppressLocalEvents = true;
  };

  event.on("mpv.start-file", onFileBoundary);
  event.on("mpv.end-file", onFileBoundary);

  event.on(
    "mpv.pause.changed",
    createDebouncedMirrorHandler(90, () => {
      if (!core.status.paused) {
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
    })
  );

  event.on(
    "mpv.playback-restart",
    createDebouncedMirrorHandler(180, () => {
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
    })
  );

  event.on(
    "mpv.volume.changed",
    createDebouncedMirrorHandler(80, () => {
      const vol = Math.max(0, Math.min(100, core.audio.volume || 100)) / 100;
      sendRpc("volume", { volume: vol });
    })
  );

  event.on(
    "mpv.mute.changed",
    createDebouncedMirrorHandler(80, () => {
      sendRpc("volume", { muted: Boolean(core.audio.muted) });
    })
  );

  event.on(
    "mpv.sid.changed",
    createDebouncedMirrorHandler(
      250,
      () => {
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
      },
      false
    )
  );

  event.on(
    "mpv.aid.changed",
    createDebouncedMirrorHandler(
      250,
      () => {
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
      },
      false
    )
  );
}
