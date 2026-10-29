export type CastMode = "idle" | "direct" | "remux" | "transcode" | "remote";

export type CastPlayerState =
  | "IDLE"
  | "ANALYZING"
  | "CONNECTING"
  | "PLAYING"
  | "PAUSED"
  | "BUFFERING";

export interface DiscoveredDevice {
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
  supports4kHevc: boolean;
}

export interface TrackInfo {
  streamIndex: number;
  codec: string;
  lang: string;
  title: string;
  channels?: number;
  label: string;
}

export interface MediaProbeSummary {
  container: string;
  videoCodec: string;
  audioCodec: string;
  duration: number;
  width: number;
  height: number;
  pixFmt: string;
  embeddedSubIndex?: number | null;
  selectedAudioStreamIndex?: number | null;
  audioTracks: TrackInfo[];
  subtitleTracks: TrackInfo[];
  deviceSupports4kHevc?: boolean;
}

export interface CompatibilityResult {
  mode: CastMode;
  videoCopy: boolean;
  audioCopy: boolean;
  isHevcStream: boolean;
  reason: string;
  summary: MediaProbeSummary;
}

export interface PluginState {
  devices: DiscoveredDevice[];
  selectedDeviceId: string | null;
  castState: CastPlayerState;
  activeDevice: DiscoveredDevice | null;
  mode: CastMode;
  modeReason: string;
  mediaInfo: MediaProbeSummary | null;
  probeCompatibility: CompatibilityResult | null;
  selectedAudioStreamIndex: number | null;
  selectedSubtitleStreamIndex: number | string | null;
  externalSubtitleName: string | null;
  currentFileUrl: string;
  currentFilePath: string;
  currentTitle: string;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  error: string | null;
}
