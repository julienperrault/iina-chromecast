import {
  CastMode,
  CastPlayerState,
  CompatibilityResult,
  DiscoveredDevice,
  MediaProbeSummary,
} from "./plugin";

export type RpcAction =
  | "init"
  | "scan"
  | "probe"
  | "cast"
  | "select_tracks"
  | "play"
  | "pause"
  | "seek"
  | "volume"
  | "stop";

export interface DaemonConfig {
  language: string;
  ffmpegPath: string;
  ffprobePath: string;
  transcodeMode: "auto" | "remux" | "transcode" | "direct";
  videoBitrate: string;
  maxResolution: number;
  allow4kHevc: "auto" | "always" | "never";
}

export interface DaemonSnapshot {
  devices: DiscoveredDevice[];
  castState: CastPlayerState;
  activeDevice: DiscoveredDevice | null;
  mode: CastMode;
  modeReason: string;
  mediaInfo: MediaProbeSummary | null;
  compatibility: CompatibilityResult | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | string | null;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  finishedCounter: number;
  error: string | null;
}

export interface RpcRequestPayload {
  language?: string;
  ffmpegPath?: string;
  transcodeMode?: "auto" | "remux" | "transcode" | "direct";
  videoBitrate?: string;
  maxResolution?: string | number;
  allow4kHevc?: "auto" | "always" | "never";
  filePath?: string;
  url?: string;
  title?: string;
  deviceId?: string;
  currentTime?: number;
  time?: number;
  subtitlePath?: string | null;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | string | null;
  externalSubtitlePath?: string | null;
  externalSubtitleName?: string | null;
  position?: number;
  volume?: number;
  level?: number;
  muted?: boolean;
}

export interface RpcResponse<T = unknown> {
  ok: boolean;
  result?: T;
  state?: DaemonSnapshot;
  error?: string;
}
