import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client, DefaultMediaReceiver } from "castv2-client";
import { t } from "../shared/i18n.js";
import type { DaemonConfig } from "../types/rpc.js";
import type { DiscoveredDevice, CompatibilityResult } from "../types/plugin.js";
import type { StreamServer } from "./streamer.js";
import type { SubtitleManager } from "./subtitles.js";
import { probeMedia, analyzeCompatibility } from "./compatibility.js";

/**
 * Determines the best local IPv4 address reachable by the target Chromecast host.
 */
export function getLocalIpAddress(targetHost: string): string {
  const interfaces = os.networkInterfaces();
  let fallbackIp = "127.0.0.1";
  const targetPrefix = targetHost
    ? targetHost.split(".").slice(0, 3).join(".") + "."
    : null;

  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (targetPrefix && iface.address.startsWith(targetPrefix)) {
          return iface.address;
        }
        if (fallbackIp === "127.0.0.1") {
          fallbackIp = iface.address;
        }
      }
    }
  }
  return fallbackIp;
}

export interface ActiveCastState {
  device: DiscoveredDevice | null;
  client: any;
  player: any;
  filePath: string | null;
  url: string | null;
  title: string | null;
  duration: number;
  seekOffset: number;
  mode: "idle" | "direct" | "remux" | "transcode" | "remote";
  modeReason: string;
  mediaInfo: any;
  probeData: any;
  compatibility: CompatibilityResult | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | string | null;
  externalSubtitlePath: string | null;
  vttContent: string | null;
  vttContentOffset: number | null;
  statusTimer: NodeJS.Timeout | null;
  playerState: string;
  idleReason: string | null;
  finishedCounter: number;
  currentTime: number;
  volume: number;
  muted: boolean;
  error: string | null;
  isLoadingMedia: boolean;
}

export function createInitialCastState(): ActiveCastState {
  return {
    device: null,
    client: null,
    player: null,
    filePath: null,
    url: null,
    title: null,
    duration: 0,
    seekOffset: 0,
    mode: "idle",
    modeReason: "",
    mediaInfo: null,
    probeData: null,
    compatibility: null,
    audioStreamIndex: null,
    subtitleStreamIndex: null,
    externalSubtitlePath: null,
    vttContent: null,
    vttContentOffset: null,
    statusTimer: null,
    playerState: "IDLE",
    idleReason: null,
    finishedCounter: 0,
    currentTime: 0,
    volume: 1,
    muted: false,
    error: null,
    isLoadingMedia: false,
  };
}

export interface CastOptions {
  deviceId: string;
  filePath?: string;
  url?: string;
  title?: string;
  startTime?: number;
  currentTime?: number;
  subtitlePath?: string | null;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | string | null;
  transcodeMode?: "auto" | "remux" | "transcode" | "direct";
}

interface LoadParams {
  streamUrl: string;
  contentType: string;
  streamType: "BUFFERED";
  title: string;
  duration: number;
  autoplay: boolean;
  initialCurrentTime: number;
  localIp: string;
  httpPort: number;
}

export class CastPlayerManager {
  public activeCast: ActiveCastState = createInitialCastState();
  private currentCastSessionId = 0;
  private probeCache = new Map<string, any>();

  constructor(
    private config: DaemonConfig,
    private streamServer: StreamServer,
    private subtitleManager: SubtitleManager,
    private devices: Map<string, DiscoveredDevice>
  ) {}

  public logError(msg: string): void {
    this.activeCast.error = msg;
  }

  public hasActiveSubtitles(): boolean {
    const idx = this.activeCast.subtitleStreamIndex;
    if (idx === "none" || idx === -1 || idx === null || idx === undefined) {
      return false;
    }
    if (idx === "external") {
      return Boolean(
        this.activeCast.externalSubtitlePath &&
          fs.existsSync(this.activeCast.externalSubtitlePath)
      );
    }
    return !isNaN(Number(idx));
  }

  public async startCasting({
    deviceId,
    filePath,
    url,
    title,
    startTime,
    currentTime,
    subtitlePath = null,
    audioStreamIndex = null,
    subtitleStreamIndex = null,
    transcodeMode = "auto",
  }: CastOptions): Promise<void> {
    const effectiveStartTime = startTime ?? currentTime ?? 0;
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(
        t(this.config.language, "error.device_not_found", { id: deviceId })
      );
    }

    const sessionId = ++this.currentCastSessionId;
    const canReusePlayer = Boolean(
      this.activeCast.client &&
        this.activeCast.player &&
        this.activeCast.device?.id === device.id
    );

    this.activeCast.isLoadingMedia = true;
    this.activeCast.device = device;
    this.activeCast.playerState = "CONNECTING";
    this.activeCast.currentTime = Math.floor(effectiveStartTime);
    this.activeCast.seekOffset = 0;
    this.activeCast.error = null;
    this.streamServer.killActiveFfmpeg();
    this.subtitleManager.killActiveSubProc();

    if (!canReusePlayer && (this.activeCast.client || this.activeCast.player)) {
      await this.stopCasting(false, true);
      if (sessionId !== this.currentCastSessionId) return;
    }

    this.config.transcodeMode = transcodeMode || this.config.transcodeMode;
    const httpPort = await this.streamServer.ensureServer(
      this.config,
      this.activeCast,
      this.subtitleManager
    );
    if (sessionId !== this.currentCastSessionId) return;

    const localIp = getLocalIpAddress(device.host);
    let streamUrl = "";
    let contentType = "video/mp4";
    let duration = 0;

    let actualFilePath = filePath;
    if (!actualFilePath && url?.startsWith("file://")) {
      actualFilePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
    }

    if (actualFilePath && fs.existsSync(actualFilePath)) {
      this.activeCast.filePath = actualFilePath;
      this.activeCast.url = url || null;
      this.activeCast.externalSubtitlePath = subtitlePath;

      const probeData = await probeMedia(
        actualFilePath,
        this.config.ffprobePath,
        this.probeCache
      );
      if (sessionId !== this.currentCastSessionId) return;
      this.activeCast.probeData = probeData;

      const compat = analyzeCompatibility(actualFilePath, probeData, {
        forceMode: this.config.transcodeMode,
        deviceSupports4kHevc: device.supports4kHevc,
        selectedAudioStreamIndex: audioStreamIndex,
        allow4kHevcConfig: this.config.allow4kHevc,
        language: this.config.language,
      });

      this.activeCast.compatibility = compat;
      this.activeCast.mode = compat.mode;
      this.activeCast.modeReason = compat.reason;
      this.activeCast.mediaInfo = compat.summary;
      this.activeCast.duration = compat.summary.duration || 0;
      this.activeCast.audioStreamIndex = compat.summary.selectedAudioStreamIndex ?? null;

      this.activeCast.subtitleStreamIndex =
        subtitleStreamIndex !== null && subtitleStreamIndex !== undefined
          ? subtitleStreamIndex
          : subtitlePath
          ? "external"
          : compat.summary.embeddedSubIndex ?? null;

      this.activeCast.seekOffset =
        compat.mode === "direct" ? 0 : Math.floor(effectiveStartTime);
      this.activeCast.currentTime = Math.floor(effectiveStartTime);
      duration = this.activeCast.duration;

      this.activeCast.vttContent = null;
      this.activeCast.vttContentOffset = null;

      contentType = this.streamServer.getStreamContentType(this.activeCast);
      streamUrl = `http://${localIp}:${httpPort}/video?start=${this.activeCast.seekOffset}&t=${Date.now()}`;
    } else if (url && /^https?:\/\//i.test(url)) {
      this.activeCast.filePath = null;
      this.activeCast.url = url;
      this.activeCast.mode = "remote";
      this.activeCast.modeReason = t(this.config.language, "compat.remote");
      this.activeCast.seekOffset = 0;
      streamUrl = url;
    } else {
      this.activeCast.isLoadingMedia = false;
      this.activeCast.playerState = "IDLE";
      this.activeCast.device = null;
      throw new Error(t(this.config.language, "error.no_valid_video"));
    }

    this.activeCast.title =
      title || (actualFilePath ? path.basename(actualFilePath) : "IINA Stream");

    console.log(
      `[cast-player] startCasting on "${device.name}" (${device.host}:${device.port}) mode=${this.activeCast.mode} streamUrl=${streamUrl}`
    );

    const loadParams: LoadParams = {
      streamUrl,
      contentType,
      streamType: "BUFFERED",
      title: this.activeCast.title,
      duration,
      autoplay: true,
      initialCurrentTime:
        this.activeCast.mode === "direct" ? Math.floor(effectiveStartTime) : 0,
      localIp,
      httpPort,
    };

    if (canReusePlayer && this.activeCast.player) {
      try {
        await this.loadCurrentStreamOnPlayer({
          player: this.activeCast.player,
          ...loadParams,
        });
        return;
      } catch {
        if (sessionId !== this.currentCastSessionId) return;
        await this.stopCasting(false, true);
        if (sessionId !== this.currentCastSessionId) return;
      }
    }

    await this.connectAndLoadMedia(device, loadParams);
  }

  private connectAndLoadMedia(
    device: DiscoveredDevice,
    params: LoadParams
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.activeCast.client = client;

      client.on("error", (err: Error) => {
        console.error(`[cast-player] Client error: ${err.message}`);
        this.logError(`Chromecast error: ${err.message}`);
      });

      console.log(`[cast-player] Connecting to ${device.host}:${device.port}...`);
      client.connect({ host: device.host, port: device.port }, (err?: any) => {
        if (err) {
          console.error(`[cast-player] Connect failed:`, err);
          this.activeCast.isLoadingMedia = false;
          this.activeCast.playerState = "IDLE";
          this.activeCast.device = null;
          const isEperm =
            err.code === "EPERM" || String(err.message).includes("EPERM");
          const errorMsg = isEperm
            ? t(this.config.language, "error.local_network_eperm")
            : t(this.config.language, "error.connect_failed", {
                name: device.name,
                err: err.message,
              });
          const wrappedErr: any = new Error(errorMsg);
          if (isEperm) wrappedErr.code = "LOCAL_NETWORK_EPERM";
          return reject(wrappedErr);
        }

        console.log(`[cast-player] Connected. Launching DefaultMediaReceiver...`);
        client.launch(
          DefaultMediaReceiver,
          (launchErr: Error | null, player: any) => {
            if (launchErr) {
              console.error(`[cast-player] Launch failed:`, launchErr);
              this.activeCast.isLoadingMedia = false;
              this.activeCast.playerState = "IDLE";
              this.activeCast.device = null;
              return reject(
                new Error(
                  t(this.config.language, "error.launch_failed", {
                    err: launchErr.message,
                  })
                )
              );
            }

            console.log(`[cast-player] DefaultMediaReceiver launched successfully`);
            this.activeCast.player = player;
            player.on("status", (status: any) => {
              this.handlePlayerStatus(status);
            });

            this.loadCurrentStreamOnPlayer({
              player,
              ...params,
            })
              .then(resolve)
              .catch(reject);
          }
        );
      });
    });
  }

  public loadCurrentStreamOnPlayer({
    player,
    streamUrl,
    contentType,
    streamType,
    title,
    duration,
    autoplay,
    initialCurrentTime,
    localIp,
    httpPort,
  }: LoadParams & { player: any }): Promise<any> {
    return new Promise((resolve, reject) => {
      this.activeCast.isLoadingMedia = true;
      const media: any = {
        contentId: streamUrl,
        contentType,
        streamType,
        metadata: {
          type: 0,
          metadataType: 0,
          title: title || "IINA Video",
        },
      };

      if (duration > 0) {
        media.duration = duration;
      }

      const loadOptions: any = {
        autoplay: autoplay !== false,
        currentTime: initialCurrentTime || 0,
      };

      if (this.hasActiveSubtitles()) {
        const subOffset =
          this.activeCast.mode === "direct" ? 0 : this.activeCast.seekOffset;
        const subTracks = this.activeCast.mediaInfo?.subtitleTracks || [];
        const activeSubMeta = subTracks.find(
          (track: any) =>
            track.streamIndex === Number(this.activeCast.subtitleStreamIndex)
        );
        media.tracks = [
          {
            trackId: 1,
            type: "TEXT",
            trackContentId: `http://${localIp}:${httpPort}/subtitles.vtt?start=${subOffset}&t=${Date.now()}`,
            trackContentType: "text/vtt",
            name:
              activeSubMeta?.label ||
              t(this.config.language, "track.subtitle_default"),
            language:
              activeSubMeta?.lang && activeSubMeta.lang !== "und"
                ? activeSubMeta.lang
                : "fr-FR",
            subtype: "SUBTITLES",
          },
        ];
        loadOptions.activeTrackIds = [1];
      }

      console.log(`[cast-player] Sending LOAD to player. Media:`, JSON.stringify(media));
      player.load(media, loadOptions, (loadErr: Error | null, status: any) => {
        this.activeCast.isLoadingMedia = false;
        if (loadErr) {
          console.error(`[cast-player] player.load error:`, loadErr);
          this.activeCast.playerState = "IDLE";
          return reject(
            new Error(
              t(this.config.language, "error.load_failed", {
                err: loadErr.message,
              })
            )
          );
        }

        console.log(`[cast-player] player.load success status:`, JSON.stringify(status));
        this.activeCast.playerState =
          status?.playerState && status.playerState !== "IDLE"
            ? status.playerState
            : "BUFFERING";
        this.handlePlayerStatus(status);
        this.startStatusPolling();
        resolve(status);
      });
    });
  }

  public handlePlayerStatus(status: any): void {
    if (!status) return;
    console.log(`[cast-player] handlePlayerStatus: state=${status.playerState}, idleReason=${status.idleReason}, currentTime=${status.currentTime}`);
    if (this.activeCast.isLoadingMedia) return;

    if (
      status.playerState === "IDLE" &&
      !status.idleReason &&
      ["BUFFERING", "CONNECTING", "PLAYING"].includes(
        this.activeCast.playerState
      )
    ) {
      return;
    }

    const previousState = this.activeCast.playerState;
    this.activeCast.playerState =
      status.playerState || this.activeCast.playerState;
    this.activeCast.idleReason = status.idleReason || null;

    if (typeof status.currentTime === "number") {
      this.activeCast.currentTime =
        this.activeCast.seekOffset + status.currentTime;
    }
    if (
      !this.activeCast.duration &&
      typeof status.media?.duration === "number" &&
      status.media.duration > 0
    ) {
      this.activeCast.duration = status.media.duration;
    }
    if (status.volume) {
      if (typeof status.volume.level === "number") {
        this.activeCast.volume = status.volume.level;
      }
      if (typeof status.volume.muted === "boolean") {
        this.activeCast.muted = status.volume.muted;
      }
    }

    if (
      this.activeCast.playerState === "IDLE" &&
      status.idleReason === "FINISHED" &&
      previousState !== "IDLE"
    ) {
      this.activeCast.finishedCounter += 1;
    }
  }

  public startStatusPolling(): void {
    if (this.activeCast.statusTimer) {
      clearInterval(this.activeCast.statusTimer);
    }
    this.activeCast.statusTimer = setInterval(() => {
      if (
        !this.activeCast.player ||
        !this.activeCast.client ||
        this.activeCast.isLoadingMedia
      )
        return;
      if (!["PLAYING", "BUFFERING", "CONNECTING"].includes(this.activeCast.playerState)) {
        return;
      }
      try {
        this.activeCast.player.getStatus((err: any, status: any) => {
          if (!err && status) this.handlePlayerStatus(status);
        });
      } catch {}
    }, 1000);
  }

  private async reloadActiveStream(resumePosition: number): Promise<void> {
    if (!this.activeCast.player || !this.activeCast.device) return;

    this.activeCast.seekOffset =
      this.activeCast.mode === "direct" ? 0 : resumePosition;
    this.activeCast.currentTime = resumePosition;
    this.activeCast.vttContent = null;
    this.activeCast.vttContentOffset = null;

    const localIp = getLocalIpAddress(this.activeCast.device.host);
    const httpPort = this.streamServer.getPort();
    const streamUrl = `http://${localIp}:${httpPort}/video?start=${this.activeCast.seekOffset}&t=${Date.now()}`;

    await this.loadCurrentStreamOnPlayer({
      player: this.activeCast.player,
      streamUrl,
      contentType: this.streamServer.getStreamContentType(this.activeCast),
      streamType: "BUFFERED",
      title: this.activeCast.title || "IINA Video",
      duration: this.activeCast.duration,
      autoplay: true,
      initialCurrentTime:
        this.activeCast.mode === "direct" ? resumePosition : 0,
      localIp,
      httpPort,
    });
  }

  public async selectTracks({
    audioStreamIndex,
    subtitleStreamIndex,
    externalSubtitlePath,
  }: {
    audioStreamIndex?: number | null;
    subtitleStreamIndex?: number | string | null;
    externalSubtitlePath?: string | null;
  }): Promise<void> {
    if (
      !this.activeCast.player ||
      !this.activeCast.device ||
      !this.activeCast.filePath
    )
      return;

    const resumePosition = Math.floor(this.activeCast.currentTime || 0);
    if (audioStreamIndex !== undefined) {
      this.activeCast.audioStreamIndex =
        audioStreamIndex === null || String(audioStreamIndex) === ""
          ? null
          : Number(audioStreamIndex);
    }
    if (subtitleStreamIndex !== undefined) {
      this.activeCast.subtitleStreamIndex = subtitleStreamIndex;
    }
    if (externalSubtitlePath !== undefined) {
      this.activeCast.externalSubtitlePath = externalSubtitlePath;
    }

    if (this.activeCast.probeData) {
      const compat = analyzeCompatibility(
        this.activeCast.filePath,
        this.activeCast.probeData,
        {
          forceMode: this.config.transcodeMode,
          deviceSupports4kHevc: this.activeCast.device.supports4kHevc,
          selectedAudioStreamIndex: this.activeCast.audioStreamIndex,
          allow4kHevcConfig: this.config.allow4kHevc,
          language: this.config.language,
        }
      );
      this.activeCast.compatibility = compat;
      this.activeCast.mode = compat.mode;
      this.activeCast.modeReason = compat.reason;
      this.activeCast.mediaInfo = compat.summary;
    }

    await this.reloadActiveStream(resumePosition);
  }

  public play(): void {
    this.activeCast.player?.play((err: any, status: any) => {
      if (!err) this.handlePlayerStatus(status);
    });
  }

  public pause(): void {
    this.activeCast.player?.pause((err: any, status: any) => {
      if (!err) this.handlePlayerStatus(status);
    });
  }

  public async seek(targetSeconds: number): Promise<void> {
    if (!this.activeCast.player || !this.activeCast.device) return;
    const clamped = Math.max(0, Number(targetSeconds) || 0);

    if (this.activeCast.mode === "direct" || this.activeCast.mode === "remote") {
      this.activeCast.player.seek(clamped, (err: any, status: any) => {
        if (!err) this.handlePlayerStatus(status);
      });
    } else {
      try {
        await this.reloadActiveStream(Math.floor(clamped));
      } catch (err: any) {
        this.logError(`Seek reload error: ${err.message}`);
      }
    }
  }

  public setVolume(level?: number, muted?: boolean): void {
    if (!this.activeCast.client) return;
    const volObj: any = {};
    if (typeof level === "number") volObj.level = Math.max(0, Math.min(1, level));
    if (typeof muted === "boolean") volObj.muted = muted;

    this.activeCast.client.setVolume(volObj, (err: any, vol: any) => {
      if (!err && vol) {
        if (typeof vol.level === "number") this.activeCast.volume = vol.level;
        if (typeof vol.muted === "boolean") this.activeCast.muted = vol.muted;
      }
    });
  }

  public async stopCasting(
    closeApp = true,
    preserveConnectingState = false
  ): Promise<void> {
    if (!preserveConnectingState) {
      this.currentCastSessionId += 1;
    }
    if (this.activeCast.statusTimer) {
      clearInterval(this.activeCast.statusTimer);
      this.activeCast.statusTimer = null;
    }

    const { player, client } = this.activeCast;
    this.activeCast.client = null;
    this.activeCast.player = null;

    if (!preserveConnectingState) {
      this.activeCast.isLoadingMedia = false;
      this.activeCast.device = null;
      this.activeCast.mode = "idle";
      this.activeCast.playerState = "IDLE";
      this.activeCast.currentTime = 0;
      this.activeCast.seekOffset = 0;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 400);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (closeApp && client && player) {
        try {
          client.stop(player, done);
        } catch {
          done();
        }
      } else if (player) {
        try {
          player.stop(done);
        } catch {
          done();
        }
      } else {
        done();
      }
    });

    this.streamServer.killActiveFfmpeg();
    this.subtitleManager.killActiveSubProc();

    if (client) {
      try {
        client.close();
      } catch {}
    }
  }
}
