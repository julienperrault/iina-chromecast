import http, { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import type { DaemonConfig } from "../types/rpc.js";
import type { SubtitleManager } from "./subtitles.js";
import type { CompatibilityResult } from "../types/plugin.js";

export interface RangeResult {
  start: number;
  end: number;
  chunkSize: number;
}

/**
 * Parses an HTTP Range header according to RFC 7233.
 * Returns null if the header is missing, or { start, end, chunkSize },
 * or throws/returns false if the range is invalid (416).
 */
export function parseRange(
  rangeHeader: string | undefined,
  totalSize: number
): RangeResult | null | false {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const range = rangeHeader.slice(6).trim();
  const dashPos = range.indexOf("-");
  if (dashPos === -1) return false;

  const rawStart = range.slice(0, dashPos).trim();
  const rawEnd = range.slice(dashPos + 1).trim();

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: bytes=-500
    const suffix = parseInt(rawEnd, 10);
    if (isNaN(suffix) || suffix <= 0) return false;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = parseInt(rawStart, 10);
    if (isNaN(start) || start < 0 || start >= totalSize) return false;
    if (rawEnd === "") {
      end = totalSize - 1;
    } else {
      end = parseInt(rawEnd, 10);
      if (isNaN(end) || end < start) return false;
      if (end >= totalSize) end = totalSize - 1;
    }
  }

  return {
    start,
    end,
    chunkSize: end - start + 1,
  };
}

export interface FfmpegStreamOptions {
  filePath: string;
  startSec: number;
  compat: CompatibilityResult | null;
  config: DaemonConfig;
  audioStreamIndex: number | null;
}

export function buildFfmpegStreamArgs({
  filePath,
  startSec,
  compat,
  config,
  audioStreamIndex,
}: FfmpegStreamOptions): string[] {
  const isVideoCopy = Boolean(compat && compat.videoCopy);
  const args = ["-hide_banner", "-loglevel", "warning"];

  if (!isVideoCopy) {
    args.push("-hwaccel", "videotoolbox");
  }
  if (startSec > 0) {
    if (isVideoCopy) {
      args.push("-noaccurate_seek");
    }
    args.push("-ss", String(startSec));
  }
  args.push("-i", filePath, "-map", "0:v:0");

  if (audioStreamIndex !== null && audioStreamIndex !== undefined) {
    args.push("-map", `0:${audioStreamIndex}?`);
  } else {
    args.push("-map", "0:a:0?");
  }

  if (isVideoCopy) {
    args.push("-c:v", "copy");
    if (compat && compat.isHevcStream) {
      args.push("-tag:v", "hvc1");
    }
  } else {
    const maxW =
      Number(config.maxResolution) === 720
        ? 1280
        : Number(config.maxResolution) === 2160
        ? 3840
        : 1920;
    args.push(
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      config.videoBitrate || "8M",
      "-allow_sw",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      `scale='min(${maxW},iw)':-2`
    );
  }

  if (compat && compat.audioCopy) {
    args.push("-c:a", "copy");
  } else {
    args.push(
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "192k",
      "-af",
      "aresample=async=1"
    );
  }

  args.push(
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets",
    "-f",
    "mp4",
    "pipe:1"
  );

  return args;
}

export class StreamServer {
  private server: http.Server | null = null;
  private port = 0;
  private activeFfmpegProcesses = new Set<ChildProcess>();

  public getPort(): number {
    return this.port;
  }

  public killActiveFfmpeg(): void {
    for (const proc of this.activeFfmpegProcesses) {
      try {
        proc.kill("SIGKILL");
      } catch (e) {}
    }
    this.activeFfmpegProcesses.clear();
  }

  public getStreamContentType(activeCast: any): string {
    if (activeCast.mode === "direct" && activeCast.filePath) {
      const ext = path.extname(activeCast.filePath).toLowerCase();
      if (ext === ".webm") return "video/webm";
    }
    return "video/mp4";
  }

  public ensureServer(
    config: DaemonConfig,
    activeCast: any,
    subtitles: SubtitleManager
  ): Promise<number> {
    if (this.server) return Promise.resolve(this.port);

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Range, Content-Type, Origin, Accept"
        );
        res.setHeader(
          "Access-Control-Expose-Headers",
          "Content-Range, Content-Length, Accept-Ranges"
        );

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const parsedUrl = new URL(
          req.url || "/",
          `http://${req.headers.host || "localhost"}`
        );
        const pathname = parsedUrl.pathname;

        if (pathname === "/subtitles.vtt") {
          subtitles.handleSubtitleRequest({
            req,
            res,
            parsedUrl,
            ffmpegPath: config.ffmpegPath,
            activeCast,
          });
          return;
        }

        if (pathname === "/video") {
          this.handleVideoRequest(req, res, parsedUrl, config, activeCast);
          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });

      this.server.listen(0, "0.0.0.0", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error("Unable to obtain stream server port"));
        }
      });

      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public handleVideoRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: URL,
    config: DaemonConfig,
    activeCast: any
  ): void {
    const filePath = activeCast.filePath;
    let stat: fs.Stats | null = null;
    try {
      stat = filePath ? fs.statSync(filePath) : null;
    } catch (e) {
      stat = null;
    }
    if (!stat) {
      res.writeHead(404);
      res.end("File not found");
      return;
    }

    if (activeCast.mode === "direct") {
      const total = stat.size;
      const contentType = this.getStreamContentType(activeCast);
      const parsedRange = parseRange(req.headers.range, total);

      if (parsedRange === false) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }

      const isPartial = parsedRange !== null;
      const headers: Record<string, string | number> = {
        "Accept-Ranges": "bytes",
        "Content-Type": contentType,
      };

      let streamOptions: { start?: number; end?: number } = {};
      if (isPartial) {
        headers["Content-Range"] = `bytes ${parsedRange.start}-${parsedRange.end}/${total}`;
        headers["Content-Length"] = parsedRange.chunkSize;
        streamOptions = { start: parsedRange.start, end: parsedRange.end };
      } else {
        headers["Content-Length"] = total;
      }

      res.writeHead(isPartial ? 206 : 200, headers);

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const fileStream = fs.createReadStream(filePath, streamOptions);
      req.on("close", () => fileStream.destroy());
      fileStream.on("error", () => {
        try {
          res.end();
        } catch (e) {}
      });
      fileStream.pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    if (req.socket) {
      req.socket.setNoDelay(true);
    }

    const startSec = Number(
      parsedUrl.searchParams.get("start") || activeCast.seekOffset || 0
    );

    this.killActiveFfmpeg();

    const ffmpegArgs = buildFfmpegStreamArgs({
      filePath,
      startSec,
      compat: activeCast.compatibility,
      config,
      audioStreamIndex: activeCast.audioStreamIndex,
    });

    const ffmpegProc = spawn(config.ffmpegPath, ffmpegArgs);
    this.activeFfmpegProcesses.add(ffmpegProc);

    ffmpegProc.stdout.pipe(res);
    ffmpegProc.stderr.resume();

    const cleanup = () => {
      if (this.activeFfmpegProcesses.has(ffmpegProc)) {
        this.activeFfmpegProcesses.delete(ffmpegProc);
        try {
          ffmpegProc.kill("SIGKILL");
        } catch (e) {}
      }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    ffmpegProc.on("exit", cleanup);
  }
}
