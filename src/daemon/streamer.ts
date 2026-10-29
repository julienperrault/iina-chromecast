import http, { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import type { DaemonConfig } from "../types/rpc.js";
import type { SubtitleManager } from "./subtitles.js";

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

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

        if (
          isNaN(start) ||
          isNaN(end) ||
          start >= total ||
          end >= total ||
          start > end
        ) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }

        const chunksize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": contentType,
        });

        if (req.method === "HEAD") {
          res.end();
          return;
        }

        const fileStream = fs.createReadStream(filePath, { start, end });
        req.on("close", () => fileStream.destroy());
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": total,
          "Accept-Ranges": "bytes",
          "Content-Type": contentType,
        });

        if (req.method === "HEAD") {
          res.end();
          return;
        }

        const fileStream = fs.createReadStream(filePath);
        req.on("close", () => fileStream.destroy());
        fileStream.pipe(res);
      }
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

    const startSec = Number(
      parsedUrl.searchParams.get("start") || activeCast.seekOffset || 0
    );
    const compat = activeCast.compatibility;

    this.killActiveFfmpeg();

    const isVideoCopy = Boolean(compat && compat.videoCopy);
    const ffmpegArgs = ["-hide_banner", "-loglevel", "warning"];

    if (!isVideoCopy) {
      ffmpegArgs.push("-hwaccel", "videotoolbox");
    }
    if (startSec > 0) {
      if (isVideoCopy) {
        ffmpegArgs.push("-noaccurate_seek");
      }
      ffmpegArgs.push("-ss", String(startSec));
    }
    ffmpegArgs.push("-i", filePath, "-map", "0:v:0");

    if (
      activeCast.audioStreamIndex !== null &&
      activeCast.audioStreamIndex !== undefined
    ) {
      ffmpegArgs.push("-map", `0:${activeCast.audioStreamIndex}?`);
    } else {
      ffmpegArgs.push("-map", "0:a:0?");
    }

    if (isVideoCopy) {
      ffmpegArgs.push("-c:v", "copy");
      if (compat && compat.isHevcStream) {
        ffmpegArgs.push("-tag:v", "hvc1");
      }
    } else {
      const maxW =
        Number(config.maxResolution) === 720
          ? 1280
          : Number(config.maxResolution) === 2160
          ? 3840
          : 1920;
      ffmpegArgs.push(
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
      ffmpegArgs.push("-c:a", "copy");
    } else {
      ffmpegArgs.push(
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

    ffmpegArgs.push(
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets",
      "-f",
      "mp4",
      "pipe:1"
    );

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
