import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { t } from "../shared/i18n.js";
import { setBoundedMap } from "./discovery.js";
import { resolveFfmpegBinary } from "../shared/dependencies.js";
import type {
  CompatibilityResult,
  MediaProbeSummary,
  TrackInfo,
} from "../types/plugin.js";
import type { DaemonConfig } from "../types/rpc.js";

const SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text"]);

export function resolveBinaries(customFfmpegPath: string, config: DaemonConfig): void {
  const resolved = resolveFfmpegBinary(customFfmpegPath);
  if (resolved) {
    config.ffmpegPath = resolved;
    const probe = path.join(path.dirname(resolved), "ffprobe");
    if (fs.existsSync(probe)) config.ffprobePath = probe;
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
    const lang = s.tags?.language || "und";
    const title = s.tags?.title || "";
    const codec = (s.codec_name || "").toLowerCase();

    if (s.codec_type === "audio") {
      const channels = s.channels ? `${s.channels}ch` : "";
      const label = [title, lang !== "und" ? lang.toUpperCase() : null, codec.toUpperCase(), channels]
        .filter(Boolean)
        .join(" • ");
      audioTracks.push({
        streamIndex: s.index,
        codec,
        lang,
        title,
        channels: s.channels || 2,
        label: label || t(language, "track.audio", { index: audioTracks.length + 1 }),
      });
    } else if (s.codec_type === "subtitle" && SUB_CODECS.has(codec)) {
      const label = [title, lang !== "und" ? lang.toUpperCase() : null, codec.toUpperCase()]
        .filter(Boolean)
        .join(" • ");
      subtitleTracks.push({
        streamIndex: s.index,
        codec,
        lang,
        title,
        label: label || t(language, "track.subtitle", { index: subtitleTracks.length + 1 }),
      });
    }
  }

  return { audioTracks, subtitleTracks };
}

export function probeMedia(
  filePath: string,
  ffprobePath: string,
  probeCache: Map<string, any>,
  providedProbeData?: any
): Promise<any> {
  if (providedProbeData && Array.isArray(providedProbeData.streams)) {
    return Promise.resolve(providedProbeData);
  }

  let cacheKey = filePath;
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {}

  if (probeCache.has(cacheKey)) {
    return Promise.resolve(probeCache.get(cacheKey));
  }

  if (!ffprobePath || !fs.existsSync(ffprobePath)) {
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    const synthetic = {
      streams: [{ index: 0, codec_type: "video", codec_name: ext === "mp4" ? "h264" : ext }],
      format: { format_name: ext, duration: 0 },
    };
    return Promise.resolve(synthetic);
  }

  return new Promise((resolve, reject) => {
    const args = ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath];
    execFile(ffprobePath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      try {
        const info = JSON.parse(stdout);
        setBoundedMap(probeCache, cacheKey, info);
        resolve(info);
      } catch (parseErr: any) {
        reject(new Error(`Failed to parse ffprobe JSON: ${parseErr.message}`));
      }
    });
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

  let audioStream = selectedAudioStreamIndex !== null && selectedAudioStreamIndex !== undefined && String(selectedAudioStreamIndex) !== ""
    ? streams.find((s: any) => s.codec_type === "audio" && s.index === Number(selectedAudioStreamIndex))
    : null;
  const firstAudioStream = streams.find((s: any) => s.codec_type === "audio");
  if (!audioStream) audioStream = firstAudioStream;

  const isNonDefaultAudioSelected = Boolean(audioStream && firstAudioStream && audioStream.index !== firstAudioStream.index);

  const vCodec = (videoStream?.codec_name || "").toLowerCase();
  const pixFmt = (videoStream?.pix_fmt || "yuv420p").toLowerCase();
  const aCodec = (audioStream?.codec_name || "").toLowerCase();
  const width = Number(videoStream?.width || 0);
  const height = Number(videoStream?.height || 0);
  const duration = Number(format.duration || videoStream?.duration || 0);

  const is10Bit = pixFmt.includes("10") || pixFmt.includes("12");
  const isHevc = vCodec === "hevc" || vCodec === "h265";
  const allowHevc = allow4kHevcConfig === "always" || (allow4kHevcConfig === "auto" && deviceSupports4kHevc);

  const isVideoH264Compat = vCodec === "h264" && !is10Bit;
  const isVideoHevcCompat = isHevc && allow4kHevcConfig === "always";
  const isVideoWebmCompat = (vCodec === "vp8" || vCodec === "vp9") && (!is10Bit || allowHevc);
  const isAudioMp4Compat = aCodec === "aac" || aCodec === "mp3";
  const isAudioWebmCompat = aCodec === "vorbis" || aCodec === "opus";
  const isMp4Container = ext === ".mp4" || ext === ".m4v";
  const isWebmContainer = ext === ".webm";

  const summary: MediaProbeSummary = {
    videoCodec: vCodec || "unknown",
    audioCodec: aCodec || "none",
    pixFmt,
    width,
    height,
    duration,
    container: ext.replace(".", "") || "unknown",
    embeddedSubIndex: subtitleTracks[0]?.streamIndex ?? null,
    selectedAudioStreamIndex: audioStream ? audioStream.index : null,
    audioTracks,
    subtitleTracks,
    deviceSupports4kHevc: Boolean(allowHevc),
  };

  if (forceMode === "direct") {
    return { mode: "direct", videoCopy: true, audioCopy: true, isHevcStream: isHevc, reason: t(language, "compat.forced_direct"), summary };
  }
  if (forceMode === "transcode") {
    return { mode: "transcode", videoCopy: false, audioCopy: false, isHevcStream: false, reason: t(language, "compat.forced_transcode"), summary };
  }

  if (!isNonDefaultAudioSelected && isMp4Container && (isVideoH264Compat || isVideoHevcCompat) && (isAudioMp4Compat || !audioStream)) {
    return {
      mode: "direct", videoCopy: true, audioCopy: true, isHevcStream: isHevc,
      reason: t(language, "compat.native_mp4", { vCodec: vCodec.toUpperCase(), hevc: isHevc ? " 4K/HEVC" : "", aCodec: aCodec.toUpperCase() }),
      summary,
    };
  }

  if (!isNonDefaultAudioSelected && isWebmContainer && isVideoWebmCompat && (isAudioWebmCompat || !audioStream)) {
    return {
      mode: "direct", videoCopy: true, audioCopy: true, isHevcStream: false,
      reason: t(language, "compat.native_webm", { vCodec: vCodec.toUpperCase(), aCodec: aCodec.toUpperCase() }),
      summary,
    };
  }

  const allowHevcRemux = isHevc && allowHevc;
  const maxRemuxWidth = allowHevcRemux ? 4096 : 1920;
  if ((isVideoH264Compat || allowHevcRemux) && width <= maxRemuxWidth) {
    const audioCopy = isAudioMp4Compat;
    return {
      mode: "remux", videoCopy: true, audioCopy, isHevcStream: isHevc,
      reason: audioCopy
        ? t(language, "compat.remux_copy", { ext: ext.toUpperCase(), vCodec: vCodec.toUpperCase(), aCodec: aCodec.toUpperCase() })
        : t(language, "compat.remux_audio", { vCodec: vCodec.toUpperCase(), aCodec: aCodec.toUpperCase() }),
      summary,
    };
  }

  return {
    mode: "transcode", videoCopy: false, audioCopy: isAudioMp4Compat, isHevcStream: false,
    reason: t(language, "compat.transcode", { vCodec: vCodec.toUpperCase(), bit10: is10Bit ? " 10-bit" : "" }),
    summary,
  };
}
