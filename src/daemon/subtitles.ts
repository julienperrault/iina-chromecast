import fs from "node:fs";
import { spawn, execFile, ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setBoundedMap } from "./discovery.js";

export const VTT_TIMESTAMP_REGEX =
  /(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/g;

export function shiftVttTimestamps(
  vttText: string,
  offsetSeconds: number
): string {
  if (!offsetSeconds || offsetSeconds <= 0) return vttText;
  const parseTs = (h: string, m: string, s: string, ms: string) =>
    Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const formatTs = (totalSec: number) => {
    const clamped = Math.max(0, totalSec);
    const hrs = Math.floor(clamped / 3600);
    const mins = Math.floor((clamped % 3600) / 60);
    const secs = Math.floor(clamped % 60);
    const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const pad3 = (n: number) => String(n).padStart(3, "0");
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}.${pad3(millis)}`;
  };

  return vttText.replace(
    VTT_TIMESTAMP_REGEX,
    (_match, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
      const start = parseTs(h1, m1, s1, ms1) - offsetSeconds;
      const end = parseTs(h2, m2, s2, ms2) - offsetSeconds;
      if (end <= 0) {
        return `00:00:00.000 --> 00:00:00.001`;
      }
      return `${formatTs(start)} --> ${formatTs(end)}`;
    }
  );
}

export function sendVttResponse(res: ServerResponse, vttString: string): void {
  const buf = Buffer.from(vttString, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/vtt; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-cache",
  });
  res.end(buf);
}

export class SubtitleManager {
  private activeSubProc: ChildProcess | null = null;
  private externalVttCache = new Map<string, string>();

  public killActiveSubProc(): void {
    if (this.activeSubProc) {
      try {
        this.activeSubProc.kill("SIGKILL");
      } catch (e) {}
      this.activeSubProc = null;
    }
  }

  public handleSubtitleRequest({
    req,
    res,
    parsedUrl,
    ffmpegPath,
    activeCast,
  }: {
    req: IncomingMessage;
    res: ServerResponse;
    parsedUrl: URL;
    ffmpegPath: string;
    activeCast: any;
  }): void {
    const idx = activeCast.subtitleStreamIndex;
    const hasActive =
      idx !== "none" &&
      idx !== -1 &&
      idx !== null &&
      idx !== undefined &&
      (idx === "external"
        ? Boolean(
            activeCast.externalSubtitlePath &&
              fs.existsSync(activeCast.externalSubtitlePath)
          )
        : !isNaN(Number(idx)));

    if (!hasActive) {
      res.writeHead(404);
      res.end("No subtitles");
      return;
    }

    const startSec = Number(
      parsedUrl.searchParams.get("start") || activeCast.seekOffset || 0
    );

    // 1. External .srt/.ass file
    if (
      idx === "external" &&
      activeCast.externalSubtitlePath &&
      fs.existsSync(activeCast.externalSubtitlePath)
    ) {
      const extPath = activeCast.externalSubtitlePath;
      let cacheKey = extPath;
      try {
        const st = fs.statSync(extPath);
        cacheKey = `${extPath}:${st.mtimeMs}`;
      } catch (e) {}

      if (this.externalVttCache.has(cacheKey)) {
        const rawVtt = this.externalVttCache.get(cacheKey)!;
        sendVttResponse(res, shiftVttTimestamps(rawVtt, startSec));
        return;
      }

      execFile(
        ffmpegPath,
        ["-y", "-i", extPath, "-f", "webvtt", "pipe:1"],
        { maxBuffer: 15 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            sendVttResponse(res, "WEBVTT\n\n");
            return;
          }
          setBoundedMap(this.externalVttCache, cacheKey, stdout, 20);
          sendVttResponse(res, shiftVttTimestamps(stdout, startSec));
        }
      );
      return;
    }

    // 2. Embedded subtitle stream inside MKV/MP4
    if (activeCast.vttContent && activeCast.vttContentOffset === startSec) {
      sendVttResponse(res, activeCast.vttContent);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-cache",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    this.killActiveSubProc();

    const args = ["-hide_banner", "-loglevel", "error"];
    if (startSec > 0) {
      args.push("-ss", String(startSec));
    }
    args.push(
      "-i",
      activeCast.filePath,
      "-vn",
      "-an",
      "-map",
      `0:${Number(idx)}`,
      "-f",
      "webvtt",
      "pipe:1"
    );

    let collected = "";
    const subProc = spawn(ffmpegPath, args);
    this.activeSubProc = subProc;

    subProc.stdout.on("data", (chunk: Buffer) => {
      collected += chunk.toString("utf8");
      res.write(chunk);
    });

    subProc.on("close", (code: number | null) => {
      if (this.activeSubProc === subProc) {
        this.activeSubProc = null;
      }
      if (code === 0 && collected.startsWith("WEBVTT")) {
        activeCast.vttContent = collected;
        activeCast.vttContentOffset = startSec;
      }
      res.end();
    });

    req.on("close", () => {
      if (this.activeSubProc === subProc) {
        this.activeSubProc = null;
        try {
          subProc.kill("SIGKILL");
        } catch (e) {}
      }
    });
  }
}
