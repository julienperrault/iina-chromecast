import http, { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { DaemonConfig, DaemonSnapshot } from "../types/rpc.js";
import type { DiscoveredDevice } from "../types/plugin.js";
import { DiscoveryService, detect4kHevcSupport } from "./discovery.js";
import { resolveBinaries, probeMedia, analyzeCompatibility } from "./compatibility.js";
import { StreamServer } from "./streamer.js";
import { SubtitleManager } from "./subtitles.js";
import { CastPlayerManager } from "./cast-player.js";

const CONTROL_PORT = 45890;

// If invoked with `--spawn-daemon`, spawn a detached background process and exit immediately (0)
if (process.argv.includes("--spawn-daemon")) {
  const child = spawn(process.execPath, [__filename, "--run-server"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

const config: DaemonConfig = {
  language: "auto",
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  ffprobePath: "/opt/homebrew/bin/ffprobe",
  transcodeMode: "auto",
  videoBitrate: "8M",
  maxResolution: 1080,
  allow4kHevc: "auto",
};

const devices = new Map<string, DiscoveredDevice>();
const probeCache = new Map<string, any>();

const streamServer = new StreamServer();
const subtitleManager = new SubtitleManager();
const castPlayer = new CastPlayerManager(
  config,
  streamServer,
  subtitleManager,
  devices
);
const discovery = new DiscoveryService(() => config, devices);

function getSortedDevices(): DiscoveredDevice[] {
  return Array.from(devices.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

function buildFullStateSnapshot(): DaemonSnapshot {
  const active = castPlayer.activeCast;
  return {
    devices: getSortedDevices(),
    castState: active.playerState as any,
    activeDevice: active.device,
    mode: active.mode,
    modeReason: active.modeReason,
    mediaInfo: active.mediaInfo,
    compatibility: active.compatibility,
    audioStreamIndex: active.audioStreamIndex,
    subtitleStreamIndex: active.subtitleStreamIndex,
    currentTime: active.currentTime,
    duration: active.duration,
    volume: active.volume,
    muted: active.muted,
    finishedCounter: active.finishedCounter,
    error: active.error,
  };
}

async function handleAction(action: string, payload: any = {}): Promise<any> {
  if (payload.language) {
    config.language = payload.language;
  }
  switch (action) {
    case "init":
      if (payload.ffmpegPath !== undefined)
        resolveBinaries(payload.ffmpegPath, config);
      if (payload.transcodeMode) config.transcodeMode = payload.transcodeMode;
      if (payload.videoBitrate) config.videoBitrate = payload.videoBitrate;
      if (payload.maxResolution)
        config.maxResolution = Number(payload.maxResolution) || 1080;
      if (payload.allow4kHevc) config.allow4kHevc = payload.allow4kHevc;
      for (const [id, dev] of devices.entries()) {
        dev.supports4kHevc = detect4kHevcSupport(
          dev.model,
          dev.name,
          config.allow4kHevc
        );
        devices.set(id, dev);
      }
      discovery.queryMdns(true);
      return buildFullStateSnapshot();

    case "scan":
      discovery.queryMdns(true);
      return buildFullStateSnapshot();

    case "cast":
      castPlayer.startCasting(payload).catch((err) => {
        castPlayer.logError(err.message);
      });
      return buildFullStateSnapshot();

    case "select_tracks":
      castPlayer.selectTracks(payload).catch((err) => {
        castPlayer.logError(err.message);
      });
      return buildFullStateSnapshot();

    case "play":
      castPlayer.play();
      return buildFullStateSnapshot();

    case "pause":
      castPlayer.pause();
      return buildFullStateSnapshot();

    case "seek":
      castPlayer.seek(payload.time).catch((err) => {
        castPlayer.logError(err.message);
      });
      return buildFullStateSnapshot();

    case "volume":
      castPlayer.setVolume(payload.level, payload.muted);
      return buildFullStateSnapshot();

    case "stop":
      await castPlayer.stopCasting();
      return buildFullStateSnapshot();

    case "probe":
      if (payload.filePath && fs.existsSync(payload.filePath)) {
        const probeData = await probeMedia(
          payload.filePath,
          config.ffprobePath,
          probeCache
        );
        const targetDev = payload.deviceId
          ? devices.get(payload.deviceId)
          : Array.from(devices.values())[0];
        const compat = analyzeCompatibility(payload.filePath, probeData, {
          forceMode: payload.transcodeMode || config.transcodeMode,
          deviceSupports4kHevc: targetDev ? targetDev.supports4kHevc : false,
          selectedAudioStreamIndex: payload.audioStreamIndex,
          allow4kHevcConfig: config.allow4kHevc,
          language: config.language,
        });
        return { compatibility: compat, state: buildFullStateSnapshot() };
      }
      return { compatibility: null, state: buildFullStateSnapshot() };

    default:
      return buildFullStateSnapshot();
  }
}

export function startControlServer(): http.Server {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: buildFullStateSnapshot() }));
      return;
    }

    if (req.method === "POST" && req.url === "/rpc") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body || "{}");
          const result = await handleAction(msg.action, msg.payload || {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err: any) {
          castPlayer.logError(err.message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: err.message,
              state: buildFullStateSnapshot(),
            })
          );
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      process.exit(0);
    }
  });

  server.listen(CONTROL_PORT, "127.0.0.1", async () => {
    resolveBinaries("", config);
    await streamServer.ensureServer(config, castPlayer.activeCast, subtitleManager);
    discovery.startDiscovery();
  });

  return server;
}

startControlServer();
