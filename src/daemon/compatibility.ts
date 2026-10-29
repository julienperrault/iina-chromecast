import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { t } from "../shared/i18n.js";
import { setBoundedMap } from "./discovery.js";
import type {
  CompatibilityResult,
  MediaProbeSummary,
  TrackInfo,
} from "../types/plugin.js";
import type { DaemonConfig } from "../types/rpc.js";

let lastResolvedCustomFfmpeg: string | null = null;

export function resolveBinaries(
  customFfmpegPath: string,
  config: DaemonConfig
): void {
  if (
    customFfmpegPath === lastResolvedCustomFfmpeg &&
    fs.existsSync(config.ffmpegPath)
  ) {
    return;
  }
  lastResolvedCustomFfmpeg = customFfmpegPath;

  const homeDir = os.homedir();
  const candidates = [
    customFfmpegPath,
    "/opt/homebrew/bin/ffmpeg", // Apple Silicon Homebrew
    "/usr/local/bin/ffmpeg", // Intel Mac Homebrew
    "/opt/local/bin/ffmpeg", // MacPorts
    path.join(homeDir, ".local/bin/ffmpeg"),
    path.join(homeDir, ".nix-profile/bin/ffmpeg"),
    "/run/current-system/sw/bin/ffmpeg", // Nix
    "/usr/bin/ffmpeg",
    "/bin/ffmpeg",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      config.ffmpegPath = candidate;
      const dir = path.dirname(candidate);
      const probeCandidate = path.join(dir, "ffprobe");
      if (fs.existsSync(probeCandidate)) {
        config.ffprobePath = probeCandidate;
      }
      break;
    }
  }

  // If ffprobe was not in the same directory, search standard fallback locations
  if (!fs.existsSync(config.ffprobePath)) {
    const probeCandidates = [
      "/opt/homebrew/bin/ffprobe",
      "/usr/local/bin/ffprobe",
      "/opt/local/bin/ffprobe",
      path.join(homeDir, ".local/bin/ffprobe"),
      "/usr/bin/ffprobe",
      "/bin/ffprobe",
    ];
    for (const p of probeCandidates) {
      if (fs.existsSync(p)) {
        config.ffprobePath = p;
        break;
      }
    }
  }
}

export function extractTracksList(
  probeData: any,
  language = "en"
): { audioTracks: TrackInfo[]; subtitleTracks: TrackInfo[] } {
  const streams = probeData?.streams || [];
  const audioTracks: TrackInfo[] = [];
  const subtitleTracks: TrackInfo[] = [];

  for (const s of streams) {
    if (s.codec_type === "audio") {
      const lang = s.tags?.language || "und";
      const title = s.tags?.title || "";
      const codec = (s.codec_name || "audio").toUpperCase();
      const channels = s.channels ? `${s.channels}ch` : "";
      const label = [
        title,
        lang !== "und" ? lang.toUpperCase() : null,
        codec,
        channels,
      ]
        .filter(Boolean)
        .join(" • ");
      audioTracks.push({
        streamIndex: s.index,
        codec: (s.codec_name || "").toLowerCase(),
        lang,
        title,
        channels: s.channels || 2,
        label:
          label ||
          t(language, "track.audio", { index: audioTracks.length + 1 }),
      });
    } else if (
      s.codec_type === "subtitle" &&
      ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text"].includes(
        (s.codec_name || "").toLowerCase()
      )
    ) {
      const lang = s.tags?.language || "und";
      const title = s.tags?.title || "";
      const codec = (s.codec_name || "sub").toUpperCase();
      const label = [title, lang !== "und" ? lang.toUpperCase() : null, codec]
        .filter(Boolean)
        .join(" • ");
      subtitleTracks.push({
        streamIndex: s.index,
        codec: (s.codec_name || "").toLowerCase(),
        lang,
        title,
        label:
          label ||
          t(language, "track.subtitle", {
            index: subtitleTracks.length + 1,
          }),
      });
    }
  }

  return { audioTracks, subtitleTracks };
}

export function probeMedia(
  filePath: string,
  ffprobePath: string,
  probeCache: Map<string, any>
): Promise<any> {
  let cacheKey = filePath;
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch (e) {}

  if (probeCache.has(cacheKey)) {
    return Promise.resolve(probeCache.get(cacheKey));
  }
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ];
    execFile(
      ffprobePath,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          return reject(new Error(`ffprobe failed: ${err.message}`));
        }
        try {
          const info = JSON.parse(stdout);
          setBoundedMap(probeCache, cacheKey, info);
          resolve(info);
        } catch (parseErr: any) {
          reject(new Error(`Failed to parse ffprobe JSON: ${parseErr.message}`));
        }
      }
    );
  });
}

export interface CompatibilityOptions {
  forceMode?: "auto" | "remux" | "transcode" | "direct";
  deviceSupports4kHevc?: boolean;
  selectedAudioStreamIndex?: number | null;
  allow4kHevcConfig?: "auto" | "always" | "never";
  language?: string;
}

export function analyzeCompatibility(
  filePath: string,
  probeData: any,
  options: CompatibilityOptions = {}
): CompatibilityResult {
  const {
    forceMode = "auto",
    deviceSupports4kHevc = false,
    selectedAudioStreamIndex = null,
    allow4kHevcConfig = "auto",
    language = "en",
  } = options;

  const ext = path.extname(filePath).toLowerCase();
  const streams = probeData.streams || [];
  const format = probeData.format || {};
  const { audioTracks, subtitleTracks } = extractTracksList(probeData, language);

  const videoStream = streams.find(
    (s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1
  );

  let audioStream: any = null;
  if (
    selectedAudioStreamIndex !== null &&
    selectedAudioStreamIndex !== undefined &&
    String(selectedAudioStreamIndex) !== ""
  ) {
    audioStream = streams.find(
      (s: any) =>
        s.codec_type === "audio" && s.index === Number(selectedAudioStreamIndex)
    );
  }
  const firstAudioStream = streams.find((s: any) => s.codec_type === "audio");
  if (!audioStream) {
    audioStream = firstAudioStream;
  }

  const isNonDefaultAudioSelected =
    audioStream &&
    firstAudioStream &&
    audioStream.index !== firstAudioStream.index;

  const vCodec = (videoStream?.codec_name || "").toLowerCase();
  const pixFmt = (videoStream?.pix_fmt || "yuv420p").toLowerCase();
  const aCodec = (audioStream?.codec_name || "").toLowerCase();
  const width = Number(videoStream?.width || 0);
  const height = Number(videoStream?.height || 0);
  const duration = Number(format.duration || videoStream?.duration || 0);

  const is10Bit = pixFmt.includes("10") || pixFmt.includes("12");
  const isHevc = vCodec === "hevc" || vCodec === "h265";

  const allowHevcDirectOrRemux =
    allow4kHevcConfig === "always" ||
    (allow4kHevcConfig === "auto" && deviceSupports4kHevc);

  const isVideoH264Compat = vCodec === "h264" && !is10Bit;
  const isVideoHevcCompat = isHevc && allowHevcDirectOrRemux;
  const isVideoWebmCompat =
    (vCodec === "vp8" || vCodec === "vp9") &&
    (!is10Bit || allowHevcDirectOrRemux);

  const isAudioMp4Compat = aCodec === "aac" || aCodec === "mp3";
  const isAudioWebmCompat = aCodec === "vorbis" || aCodec === "opus";

  const isMp4Container = ext === ".mp4" || ext === ".m4v";
  const isWebmContainer = ext === ".webm";

  const defaultSubIndex =
    subtitleTracks.length > 0 ? subtitleTracks[0].streamIndex : null;

  const summary: MediaProbeSummary = {
    videoCodec: vCodec || "unknown",
    audioCodec: aCodec || "none",
    pixFmt,
    width,
    height,
    duration,
    container: ext.replace(".", "") || "unknown",
    embeddedSubIndex: defaultSubIndex,
    selectedAudioStreamIndex: audioStream ? audioStream.index : null,
    audioTracks,
    subtitleTracks,
    deviceSupports4kHevc: Boolean(allowHevcDirectOrRemux),
  };

  if (forceMode === "direct") {
    return {
      mode: "direct",
      videoCopy: true,
      audioCopy: true,
      isHevcStream: isHevc,
      reason: t(language, "compat.forced_direct"),
      summary,
    };
  }

  if (forceMode === "transcode") {
    return {
      mode: "transcode",
      videoCopy: false,
      audioCopy: false,
      isHevcStream: false,
      reason: t(language, "compat.forced_transcode"),
      summary,
    };
  }

  if (
    !isNonDefaultAudioSelected &&
    isMp4Container &&
    (isVideoH264Compat || isVideoHevcCompat) &&
    (isAudioMp4Compat || !audioStream)
  ) {
    return {
      mode: "direct",
      videoCopy: true,
      audioCopy: true,
      isHevcStream: isHevc,
      reason: t(language, "compat.native_mp4", {
        vCodec: vCodec.toUpperCase(),
        hevc: isHevc ? " 4K/HEVC" : "",
        aCodec: aCodec.toUpperCase(),
      }),
      summary,
    };
  }

  if (
    !isNonDefaultAudioSelected &&
    isWebmContainer &&
    isVideoWebmCompat &&
    (isAudioWebmCompat || !audioStream)
  ) {
    return {
      mode: "direct",
      videoCopy: true,
      audioCopy: true,
      isHevcStream: false,
      reason: t(language, "compat.native_webm", {
        vCodec: vCodec.toUpperCase(),
        aCodec: aCodec.toUpperCase(),
      }),
      summary,
    };
  }

  const maxRemuxWidth = allowHevcDirectOrRemux ? 4096 : 1920;
  if ((isVideoH264Compat || isVideoHevcCompat) && width <= maxRemuxWidth) {
    const audioCopy = isAudioMp4Compat;
    return {
      mode: "remux",
      videoCopy: true,
      audioCopy,
      isHevcStream: isHevc,
      reason: audioCopy
        ? t(language, "compat.remux_copy", {
            ext: ext.toUpperCase(),
            vCodec: vCodec.toUpperCase(),
            aCodec: aCodec.toUpperCase(),
          })
        : t(language, "compat.remux_audio", {
            vCodec: vCodec.toUpperCase(),
            aCodec: aCodec.toUpperCase(),
          }),
      summary,
    };
  }

  return {
    mode: "transcode",
    videoCopy: false,
    audioCopy: isAudioMp4Compat,
    isHevcStream: false,
    reason: t(language, "compat.transcode", {
      vCodec: vCodec.toUpperCase(),
      bit10: is10Bit ? " 10-bit" : "",
    }),
    summary,
  };
}
