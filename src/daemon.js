/**
 * IINA Chromecast Companion Daemon
 * Can be started once and stays alive in the background (detached) listening on a fixed localhost port (45890)
 * so IINA can communicate with it purely via non-blocking HTTP requests (avoiding IINA's utils.exec waitUntilExit bug).
 *
 * Handles:
 * 1. mDNS / Bonjour Chromecast discovery (_googlecast._tcp.local) + 4K/HEVC capability detection
 * 2. Media compatibility analysis via ffprobe (multi-audio & multi-subtitle track awareness)
 * 3. Local HTTP server for Direct Play (Range requests), On-the-fly Remuxing,
 *    Hardware-accelerated VideoToolbox Transcoding, and WebVTT Subtitles
 * 4. CASTV2 protocol control (Play, Pause, Seek, Stop, Volume, Track switching, Media Status, EOF events)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const mdns = require("multicast-dns");
const { Client, DefaultMediaReceiver } = require("castv2-client");
const { t } = require("./i18n");

const CONTROL_PORT = 45890;
const MAX_PROBE_CACHE_ENTRIES = 50;

// If invoked with `--spawn-daemon`, spawn a detached background process and exit immediately (0)
// so IINA's `utils.exec()` returns in <50ms without blocking IINA's plugin dispatch queue!
if (process.argv.includes("--spawn-daemon")) {
  const child = spawn(process.execPath, [__filename, "--run-server"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

// --- Configuration & State ---
let config = {
  language: "auto", // "auto" | "en" | "fr" | "es"
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  ffprobePath: "/opt/homebrew/bin/ffprobe",
  transcodeMode: "auto", // "auto" | "remux" | "transcode" | "direct"
  videoBitrate: "8M",
  maxResolution: 1080,
  allow4kHevc: "auto", // "auto" | "always" | "never"
};

const devices = new Map(); // id -> { id, name, host, port, model, supports4kHevc }
let mdnsInstance = null;
let httpServer = null;
let httpPort = 0;

let activeCast = {
  device: null,
  client: null,
  player: null,
  filePath: null,
  url: null,
  title: null,
  duration: 0,
  seekOffset: 0,
  mode: "idle", // "idle" | "direct" | "remux" | "transcode" | "remote"
  modeReason: "",
  mediaInfo: null,
  probeData: null,
  compatibility: null,
  audioStreamIndex: null,
  subtitleStreamIndex: null,
  externalSubtitlePath: null,
  vttContent: null,
  vttContentOffset: null,
  activeFfmpegProcesses: new Set(),
  statusTimer: null,
  playerState: "IDLE",
  idleReason: null,
  finishedCounter: 0,
  currentTime: 0,
  volume: 1,
  muted: false,
  error: null,
};

// Bounded cache of probed files (keyed by filePath + mtimeMs)
const probeCache = new Map();
// Cache of raw WebVTT converted from external subtitle files
const externalVttCache = new Map();

function logError(msg) {
  activeCast.error = msg;
}

function setBoundedMap(map, key, value, maxEntries = MAX_PROBE_CACHE_ENTRIES) {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

// --- Network Utilities ---
function getLocalIpAddress(targetHost) {
  const interfaces = os.networkInterfaces();
  let fallbackIp = "127.0.0.1";

  const targetPrefix = targetHost
    ? targetHost.split(".").slice(0, 3).join(".") + "."
    : null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
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

// --- Binary Resolution ---
let lastResolvedCustomFfmpeg = null;
function resolveBinaries(customFfmpegPath) {
  if (customFfmpegPath === lastResolvedCustomFfmpeg && fs.existsSync(config.ffmpegPath)) {
    return;
  }
  lastResolvedCustomFfmpeg = customFfmpegPath;

  const homeDir = os.homedir();
  const candidates = [
    customFfmpegPath,
    "/opt/homebrew/bin/ffmpeg", // Apple Silicon Homebrew
    "/usr/local/bin/ffmpeg",   // Intel Mac Homebrew
    "/opt/local/bin/ffmpeg",    // MacPorts
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

// --- Chromecast 4K / HEVC Capability Detection ---
const KEYWORDS_4K = [
  "ultra",
  "google tv",
  "connect tv",
  "streamer",
  "shield",
  "bravia",
  "philips",
  "tcl",
  "hisense",
  "mi box",
  "mibox",
  "4k",
  "sabrina",
  "kirkwood",
  "chromecast hd",
];

const KEYWORDS_AUDIO_ONLY = [
  "home mini",
  "nest mini",
  "nest audio",
  "speaker",
  "enceinte",
  "chromecast audio",
];

function detect4kHevcSupport(model = "", friendlyName = "") {
  if (config.allow4kHevc === "always") return true;
  if (config.allow4kHevc === "never") return false;

  const str = `${model} ${friendlyName}`.toLowerCase();
  return KEYWORDS_4K.some((kw) => str.includes(kw));
}

function isAudioOnlyDevice(model = "", friendlyName = "") {
  const str = `${model} ${friendlyName}`.toLowerCase();
  return KEYWORDS_AUDIO_ONLY.some((kw) => str.includes(kw));
}

// --- mDNS Chromecast Discovery ---
function startDiscovery() {
  if (mdnsInstance) {
    try {
      mdnsInstance.destroy();
    } catch (e) {}
  }

  mdnsInstance = mdns();
  const dnsRecords = new Map();

  mdnsInstance.on("response", (packet) => {
    const allRecords = [
      ...(packet.answers || []),
      ...(packet.additionals || []),
    ];
    let hasCastRecords = false;

    for (const rec of allRecords) {
      if (rec.type === "PTR" && rec.name === "_googlecast._tcp.local") {
        hasCastRecords = true;
        const instanceName = rec.data;
        if (!dnsRecords.has(instanceName)) {
          setBoundedMap(dnsRecords, instanceName, {}, 200);
        }
      }
    }

    for (const rec of allRecords) {
      if (rec.type === "SRV") {
        // Ignore non-GoogleCast services (like _hap._tcp.local or _googlezone._tcp.local)
        if (!String(rec.name || "").endsWith("._googlecast._tcp.local")) continue;
        hasCastRecords = true;
        const entry = dnsRecords.get(rec.name) || {};
        entry.srv = rec.data;
        setBoundedMap(dnsRecords, rec.name, entry, 200);
      } else if (rec.type === "TXT") {
        if (!String(rec.name || "").endsWith("._googlecast._tcp.local")) continue;
        hasCastRecords = true;
        const entry = dnsRecords.get(rec.name) || {};
        const txtObj = {};
        const buffers = Array.isArray(rec.data) ? rec.data : [rec.data];
        for (const buf of buffers) {
          const str = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
          const idx = str.indexOf("=");
          if (idx > 0) {
            txtObj[str.slice(0, idx)] = str.slice(idx + 1);
          }
        }
        entry.txt = txtObj;
        setBoundedMap(dnsRecords, rec.name, entry, 200);
      } else if (rec.type === "A") {
        for (const [instName, entry] of dnsRecords.entries()) {
          if (entry.srv && entry.srv.target === rec.name) {
            entry.a = rec.data;
            dnsRecords.set(instName, entry);
            hasCastRecords = true;
          }
        }
        setBoundedMap(dnsRecords, `A:${rec.name}`, rec.data, 200);
      }
    }

    if (!hasCastRecords) return;

    for (const [key, entry] of dnsRecords.entries()) {
      if (key.startsWith("A:") || !key.endsWith("._googlecast._tcp.local")) {
        continue;
      }

      if (entry.srv) {
        const hostIp = entry.a || dnsRecords.get(`A:${entry.srv.target}`);
        if (hostIp) {
          const txt = entry.txt || {};
          const id = txt.id || key;
          const friendlyName =
            txt.fn || key.replace("._googlecast._tcp.local", "");
          const model = txt.md || "Chromecast";
          const port = entry.srv.port || 8009;

          // Filter out audio-only speakers (Google Home Mini, Mi Smart Speaker, Nest Audio)
          // or devices where cast capability bitmask (ca) has no video support ((ca & 1) === 0)
          const caNum = parseInt(txt.ca || "0", 10);
          const hasVideoBit = caNum > 0 ? (caNum & 1) === 1 : true;
          const isAudioOnly =
            isAudioOnlyDevice(model, friendlyName) || !hasVideoBit;
          if (isAudioOnly) {
            continue;
          }

          const supports4kHevc = detect4kHevcSupport(model, friendlyName);

          devices.set(id, {
            id,
            name: friendlyName,
            model,
            host: hostIp,
            port,
            supports4kHevc,
          });
        }
      }
    }
  });

  mdnsInstance.on("error", () => {});

  queryMdns();
}

let scanBurstTimer = null;
function queryMdns(withFollowUp = false) {
  if (!mdnsInstance) return;
  const sendQuery = () => {
    try {
      mdnsInstance.query({
        questions: [{ name: "_googlecast._tcp.local", type: "PTR" }],
      });
    } catch (err) {}
  };
  sendQuery();
  if (withFollowUp) {
    if (scanBurstTimer) clearTimeout(scanBurstTimer);
    scanBurstTimer = setTimeout(sendQuery, 500);
  }
}

// --- Media Probing & Compatibility Decision ---
function probeMedia(filePath) {
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
      config.ffprobePath,
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
        } catch (parseErr) {
          reject(new Error(`Failed to parse ffprobe JSON: ${parseErr.message}`));
        }
      }
    );
  });
}

function extractTracksList(probeData) {
  const streams = probeData?.streams || [];
  const audioTracks = [];
  const subtitleTracks = [];

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
          t(config.language, "track.audio", { index: audioTracks.length + 1 }),
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
          t(config.language, "track.subtitle", {
            index: subtitleTracks.length + 1,
          }),
      });
    }
  }

  return { audioTracks, subtitleTracks };
}

function analyzeCompatibility(
  filePath,
  probeData,
  {
    forceMode = "auto",
    deviceSupports4kHevc = false,
    selectedAudioStreamIndex = null,
  } = {}
) {
  const ext = path.extname(filePath).toLowerCase();
  const streams = probeData.streams || [];
  const format = probeData.format || {};
  const { audioTracks, subtitleTracks } = extractTracksList(probeData);

  const videoStream = streams.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1
  );

  let audioStream = null;
  if (
    selectedAudioStreamIndex !== null &&
    selectedAudioStreamIndex !== undefined &&
    selectedAudioStreamIndex !== ""
  ) {
    audioStream = streams.find(
      (s) =>
        s.codec_type === "audio" && s.index === Number(selectedAudioStreamIndex)
    );
  }
  const firstAudioStream = streams.find((s) => s.codec_type === "audio");
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
    config.allow4kHevc === "always" ||
    (config.allow4kHevc === "auto" && deviceSupports4kHevc);

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

  const summary = {
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
      reason: t(config.language, "compat.forced_direct"),
      summary,
    };
  }

  if (forceMode === "transcode") {
    return {
      mode: "transcode",
      videoCopy: false,
      audioCopy: false,
      isHevcStream: false,
      reason: t(config.language, "compat.forced_transcode"),
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
      reason: t(config.language, "compat.native_mp4", {
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
      reason: t(config.language, "compat.native_webm", {
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
        ? t(config.language, "compat.remux_copy", {
            ext: ext.toUpperCase(),
            vCodec: vCodec.toUpperCase(),
            aCodec: aCodec.toUpperCase(),
          })
        : t(config.language, "compat.remux_audio", {
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
    reason: t(config.language, "compat.transcode", {
      vCodec: vCodec.toUpperCase(),
      bit10: is10Bit ? " 10-bit" : "",
    }),
    summary,
  };
}

// --- Subtitle Extraction / Conversion to WebVTT (with live timestamp shift & streaming) ---
let activeSubProc = null;

function killActiveSubProc() {
  if (activeSubProc) {
    try {
      activeSubProc.kill("SIGKILL");
    } catch (e) {}
    activeSubProc = null;
  }
}

const VTT_TIMESTAMP_REGEX =
  /(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/g;

function shiftVttTimestamps(vttText, offsetSeconds) {
  if (!offsetSeconds || offsetSeconds <= 0) return vttText;
  const parseTs = (h, m, s, ms) =>
    Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const formatTs = (totalSec) => {
    const clamped = Math.max(0, totalSec);
    const hrs = Math.floor(clamped / 3600);
    const mins = Math.floor((clamped % 3600) / 60);
    const secs = Math.floor(clamped % 60);
    const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}.${pad3(millis)}`;
  };

  return vttText.replace(
    VTT_TIMESTAMP_REGEX,
    (match, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
      const start = parseTs(h1, m1, s1, ms1) - offsetSeconds;
      const end = parseTs(h2, m2, s2, ms2) - offsetSeconds;
      if (end <= 0) {
        return `00:00:00.000 --> 00:00:00.001`;
      }
      return `${formatTs(start)} --> ${formatTs(end)}`;
    }
  );
}

function hasActiveSubtitles() {
  const idx = activeCast.subtitleStreamIndex;
  if (idx === "none" || idx === -1 || idx === null || idx === undefined) {
    return false;
  }
  if (idx === "external") {
    return Boolean(
      activeCast.externalSubtitlePath &&
        fs.existsSync(activeCast.externalSubtitlePath)
    );
  }
  return !isNaN(Number(idx));
}

// --- Local HTTP Server (Direct Range + Live FFmpeg Remux/Transcode + VTT Subtitles) ---
function ensureHttpServer() {
  if (httpServer) return Promise.resolve(httpPort);

  return new Promise((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
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
        req.url,
        `http://${req.headers.host || "localhost"}`
      );
      const pathname = parsedUrl.pathname;

      if (pathname === "/subtitles.vtt") {
        handleSubtitleRequest(req, res, parsedUrl);
        return;
      }

      if (pathname === "/video") {
        handleVideoRequest(req, res, parsedUrl);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(0, "0.0.0.0", () => {
      httpPort = httpServer.address().port;
      resolve(httpPort);
    });

    httpServer.on("error", (err) => {
      reject(err);
    });
  });
}

function sendVttResponse(res, vttString) {
  const buf = Buffer.from(vttString, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/vtt; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-cache",
  });
  res.end(buf);
}

function handleSubtitleRequest(req, res, parsedUrl) {
  if (!hasActiveSubtitles()) {
    res.writeHead(404);
    res.end("No subtitles");
    return;
  }

  const startSec = Number(
    parsedUrl.searchParams.get("start") || activeCast.seekOffset || 0
  );
  const idx = activeCast.subtitleStreamIndex;

  // 1. External .srt/.ass file (cached in memory by mtime so seeks are instant)
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

    if (externalVttCache.has(cacheKey)) {
      const rawVtt = externalVttCache.get(cacheKey);
      sendVttResponse(res, shiftVttTimestamps(rawVtt, startSec));
      return;
    }

    execFile(
      config.ffmpegPath,
      ["-y", "-i", extPath, "-f", "webvtt", "pipe:1"],
      { maxBuffer: 15 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          sendVttResponse(res, "WEBVTT\n\n");
          return;
        }
        setBoundedMap(externalVttCache, cacheKey, stdout, 20);
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

  killActiveSubProc();

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
  const subProc = spawn(config.ffmpegPath, args);
  activeSubProc = subProc;

  subProc.stdout.on("data", (chunk) => {
    collected += chunk.toString("utf8");
    res.write(chunk);
  });

  subProc.on("close", (code) => {
    if (activeSubProc === subProc) {
      activeSubProc = null;
    }
    if (code === 0 && collected.startsWith("WEBVTT")) {
      activeCast.vttContent = collected;
      activeCast.vttContentOffset = startSec;
    }
    res.end();
  });

  req.on("close", () => {
    if (activeSubProc === subProc) {
      activeSubProc = null;
      try {
        subProc.kill("SIGKILL");
      } catch (e) {}
    }
  });
}

function killActiveFfmpeg() {
  for (const proc of activeCast.activeFfmpegProcesses) {
    try {
      proc.kill("SIGKILL");
    } catch (e) {}
  }
  activeCast.activeFfmpegProcesses.clear();
}

function getStreamContentType() {
  if (activeCast.mode === "direct" && activeCast.filePath) {
    const ext = path.extname(activeCast.filePath).toLowerCase();
    if (ext === ".webm") return "video/webm";
  }
  return "video/mp4";
}

function handleVideoRequest(req, res, parsedUrl) {
  const filePath = activeCast.filePath;
  let stat;
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
    const contentType = getStreamContentType();

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      if (isNaN(start) || isNaN(end) || start >= total || end >= total || start > end) {
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

  killActiveFfmpeg();

  const isVideoCopy = Boolean(compat && compat.videoCopy);
  const ffmpegArgs = ["-hide_banner", "-loglevel", "warning"];

  if (!isVideoCopy) {
    ffmpegArgs.push("-hwaccel", "videotoolbox");
  }
  if (startSec > 0) {
    if (isVideoCopy) {
      // Critical for A/V sync in Remux mode: when video is copied (-c:v copy), FFmpeg must seek
      // to the preceding keyframe. Without -noaccurate_seek, FFmpeg drops decoded audio between
      // that keyframe and startSec while keeping the video frames, causing a 1-5s audio desync!
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
    if (compat.isHevcStream) {
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
  activeCast.activeFfmpegProcesses.add(ffmpegProc);

  ffmpegProc.stdout.pipe(res);
  ffmpegProc.stderr.resume();

  const cleanup = () => {
    if (activeCast.activeFfmpegProcesses.has(ffmpegProc)) {
      activeCast.activeFfmpegProcesses.delete(ffmpegProc);
      try {
        ffmpegProc.kill("SIGKILL");
      } catch (e) {}
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  ffmpegProc.on("exit", cleanup);
}

// --- Chromecast Connection & Media Control ---
let currentCastSessionId = 0;

async function startCasting({
  deviceId,
  filePath,
  url,
  title,
  startTime = 0,
  subtitlePath = null,
  audioStreamIndex = null,
  subtitleStreamIndex = null,
  transcodeMode = "auto",
}) {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error(t(config.language, "error.device_not_found", { id: deviceId }));
  }

  const sessionId = ++currentCastSessionId;
  const canReusePlayer = Boolean(
    activeCast.client &&
      activeCast.player &&
      activeCast.device &&
      activeCast.device.id === device.id
  );

  // Immediately set transition state so /state polls never see IDLE or old file's currentTime
  activeCast.isLoadingMedia = true;
  activeCast.device = device;
  activeCast.playerState = "CONNECTING";
  activeCast.currentTime = Math.floor(startTime || 0);
  activeCast.seekOffset = 0;
  activeCast.error = null;
  killActiveFfmpeg();
  killActiveSubProc();

  if (!canReusePlayer && (activeCast.client || activeCast.player)) {
    await stopCasting(false, true);
    if (sessionId !== currentCastSessionId) return;
  }

  config.transcodeMode = transcodeMode || config.transcodeMode;
  await ensureHttpServer();
  if (sessionId !== currentCastSessionId) return;

  const localIp = getLocalIpAddress(device.host);
  let streamUrl = "";
  let contentType = "video/mp4";
  const streamType = "BUFFERED";
  let duration = 0;

  let actualFilePath = filePath;
  if (!actualFilePath && url && url.startsWith("file://")) {
    actualFilePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
  }

  if (actualFilePath && fs.existsSync(actualFilePath)) {
    activeCast.filePath = actualFilePath;
    activeCast.url = url;
    activeCast.externalSubtitlePath = subtitlePath;

    const probeData = await probeMedia(actualFilePath);
    if (sessionId !== currentCastSessionId) return;
    activeCast.probeData = probeData;

    const compat = analyzeCompatibility(actualFilePath, probeData, {
      forceMode: config.transcodeMode,
      deviceSupports4kHevc: device.supports4kHevc,
      selectedAudioStreamIndex: audioStreamIndex,
    });

    activeCast.compatibility = compat;
    activeCast.mode = compat.mode;
    activeCast.modeReason = compat.reason;
    activeCast.mediaInfo = compat.summary;
    activeCast.duration = compat.summary.duration || 0;
    activeCast.audioStreamIndex = compat.summary.selectedAudioStreamIndex;

    const chosenSubIndex =
      subtitleStreamIndex !== null && subtitleStreamIndex !== undefined
        ? subtitleStreamIndex
        : subtitlePath
        ? "external"
        : compat.summary.embeddedSubIndex;

    activeCast.subtitleStreamIndex = chosenSubIndex;
    activeCast.seekOffset =
      compat.mode === "direct" ? 0 : Math.floor(startTime || 0);
    activeCast.currentTime = Math.floor(startTime || 0);
    duration = activeCast.duration;

    activeCast.vttContent = null;
    activeCast.vttContentOffset = null;

    contentType = getStreamContentType();
    streamUrl = `http://${localIp}:${httpPort}/video?start=${activeCast.seekOffset}&t=${Date.now()}`;
  } else if (url && /^https?:\/\//i.test(url)) {
    activeCast.filePath = null;
    activeCast.url = url;
    activeCast.mode = "remote";
    activeCast.modeReason = t(config.language, "compat.remote");
    activeCast.seekOffset = 0;
    streamUrl = url;
    contentType = "video/mp4";
  } else {
    activeCast.isLoadingMedia = false;
    activeCast.playerState = "IDLE";
    activeCast.device = null;
    throw new Error(t(config.language, "error.no_valid_video"));
  }

  activeCast.title =
    title || (actualFilePath ? path.basename(actualFilePath) : "IINA Stream");

  const loadParams = {
    device,
    streamUrl,
    contentType,
    streamType,
    title: activeCast.title,
    duration,
    autoplay: true,
    initialCurrentTime:
      activeCast.mode === "direct" ? Math.floor(startTime || 0) : 0,
    localIp,
  };

  if (canReusePlayer && activeCast.player) {
    try {
      await loadCurrentStreamOnPlayer({
        player: activeCast.player,
        ...loadParams,
      });
      return;
    } catch (reuseErr) {
      if (sessionId !== currentCastSessionId) return;
      await stopCasting(false, true);
      if (sessionId !== currentCastSessionId) return;
    }
  }

  await connectAndLoadMedia(loadParams);
}

function connectAndLoadMedia({
  device,
  streamUrl,
  contentType,
  streamType,
  title,
  duration,
  autoplay,
  initialCurrentTime,
  localIp,
}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    activeCast.client = client;

    client.on("error", (err) => {
      logError(`Chromecast error: ${err.message}`);
    });

    client.connect({ host: device.host, port: device.port }, (err) => {
      if (err) {
        activeCast.isLoadingMedia = false;
        activeCast.playerState = "IDLE";
        activeCast.device = null;
        return reject(
          new Error(
            t(config.language, "error.connect_failed", {
              name: device.name,
              err: err.message,
            })
          )
        );
      }

      client.launch(DefaultMediaReceiver, (launchErr, player) => {
        if (launchErr) {
          activeCast.isLoadingMedia = false;
          activeCast.playerState = "IDLE";
          activeCast.device = null;
          return reject(
            new Error(
              t(config.language, "error.launch_failed", {
                err: launchErr.message,
              })
            )
          );
        }

        activeCast.player = player;

        player.on("status", (status) => {
          handlePlayerStatus(status);
        });

        loadCurrentStreamOnPlayer({
          player,
          streamUrl,
          contentType,
          streamType,
          title,
          duration,
          autoplay,
          initialCurrentTime,
          localIp,
        })
          .then(resolve)
          .catch(reject);
      });
    });
  });
}

function loadCurrentStreamOnPlayer({
  player,
  streamUrl,
  contentType,
  streamType,
  title,
  duration,
  autoplay,
  initialCurrentTime,
  localIp,
}) {
  return new Promise((resolve, reject) => {
    activeCast.isLoadingMedia = true;
    const media = {
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

    const loadOptions = {
      autoplay: autoplay !== false,
      currentTime: initialCurrentTime || 0,
    };

    if (hasActiveSubtitles()) {
      const subOffset = activeCast.mode === "direct" ? 0 : activeCast.seekOffset;
      const subTracks = activeCast.mediaInfo?.subtitleTracks || [];
      const activeSubMeta = subTracks.find(
        (t) => t.streamIndex === Number(activeCast.subtitleStreamIndex)
      );
      media.tracks = [
        {
          trackId: 1,
          type: "TEXT",
          trackContentId: `http://${localIp}:${httpPort}/subtitles.vtt?start=${subOffset}&t=${Date.now()}`,
          trackContentType: "text/vtt",
          name: activeSubMeta?.label || t(config.language, "track.subtitle_default"),
          language:
            activeSubMeta?.lang && activeSubMeta.lang !== "und"
              ? activeSubMeta.lang
              : "fr-FR",
          subtype: "SUBTITLES",
        },
      ];
      loadOptions.activeTrackIds = [1];
    }

    player.load(media, loadOptions, (loadErr, status) => {
      activeCast.isLoadingMedia = false;
      if (loadErr) {
        return reject(
          new Error(
            t(config.language, "error.load_failed", { err: loadErr.message })
          )
        );
      }

      activeCast.playerState = "PLAYING";
      handlePlayerStatus(status);
      startStatusPolling();
      resolve(status);
    });
  });
}

function handlePlayerStatus(status) {
  if (!status) return;
  if (activeCast.isLoadingMedia) {
    // Ignore transient IDLE/INTERRUPTED or old stream timestamps while a new LOAD is in flight
    return;
  }
  const previousState = activeCast.playerState;
  activeCast.playerState = status.playerState || activeCast.playerState;
  activeCast.idleReason = status.idleReason || null;

  if (typeof status.currentTime === "number") {
    activeCast.currentTime = activeCast.seekOffset + status.currentTime;
  }
  // Only overwrite duration from Chromecast if we don't already have the true full duration from ffprobe
  if (
    !activeCast.duration &&
    status.media &&
    typeof status.media.duration === "number" &&
    status.media.duration > 0
  ) {
    activeCast.duration = status.media.duration;
  }
  if (status.volume) {
    if (typeof status.volume.level === "number") {
      activeCast.volume = status.volume.level;
    }
    if (typeof status.volume.muted === "boolean") {
      activeCast.muted = status.volume.muted;
    }
  }

  if (
    activeCast.playerState === "IDLE" &&
    status.idleReason === "FINISHED" &&
    previousState !== "IDLE"
  ) {
    activeCast.finishedCounter += 1;
  }
}

function startStatusPolling() {
  if (activeCast.statusTimer) {
    clearInterval(activeCast.statusTimer);
  }
  activeCast.statusTimer = setInterval(() => {
    if (!activeCast.player || !activeCast.client || activeCast.isLoadingMedia) return;
    // castv2 pushes state changes automatically; only poll getStatus() while actively playing to track currentTime
    if (activeCast.playerState !== "PLAYING" && activeCast.playerState !== "BUFFERING") {
      return;
    }
    try {
      activeCast.player.getStatus((err, status) => {
        if (!err && status) {
          handlePlayerStatus(status);
        }
      });
    } catch (e) {}
  }, 1000);
}

// --- Live Track Switching ---
async function selectTracks({
  audioStreamIndex,
  subtitleStreamIndex,
  externalSubtitlePath,
}) {
  if (!activeCast.player || !activeCast.device || !activeCast.filePath) return;

  const resumePosition = Math.floor(activeCast.currentTime || 0);
  if (audioStreamIndex !== undefined) {
    activeCast.audioStreamIndex =
      audioStreamIndex === null || audioStreamIndex === ""
        ? null
        : Number(audioStreamIndex);
  }
  if (subtitleStreamIndex !== undefined) {
    activeCast.subtitleStreamIndex = subtitleStreamIndex;
  }
  if (externalSubtitlePath !== undefined) {
    activeCast.externalSubtitlePath = externalSubtitlePath;
  }

  if (activeCast.probeData) {
    const compat = analyzeCompatibility(
      activeCast.filePath,
      activeCast.probeData,
      {
        forceMode: config.transcodeMode,
        deviceSupports4kHevc: activeCast.device.supports4kHevc,
        selectedAudioStreamIndex: activeCast.audioStreamIndex,
      }
    );
    activeCast.compatibility = compat;
    activeCast.mode = compat.mode;
    activeCast.modeReason = compat.reason;
    activeCast.mediaInfo = compat.summary;
  }

  activeCast.vttContent = null;
  activeCast.vttContentOffset = null;

  activeCast.seekOffset = activeCast.mode === "direct" ? 0 : resumePosition;
  const localIp = getLocalIpAddress(activeCast.device.host);
  const streamUrl = `http://${localIp}:${httpPort}/video?start=${activeCast.seekOffset}&t=${Date.now()}`;

  await loadCurrentStreamOnPlayer({
    player: activeCast.player,
    streamUrl,
    contentType: getStreamContentType(),
    streamType: "BUFFERED",
    title: activeCast.title,
    duration: activeCast.duration,
    autoplay: true,
    initialCurrentTime: activeCast.mode === "direct" ? resumePosition : 0,
    localIp,
  });
}

// --- Playback Controls ---
function playCast() {
  if (!activeCast.player) return;
  activeCast.player.play((err, status) => {
    if (!err) handlePlayerStatus(status);
  });
}

function pauseCast() {
  if (!activeCast.player) return;
  activeCast.player.pause((err, status) => {
    if (!err) handlePlayerStatus(status);
  });
}

async function seekCast(targetSeconds) {
  if (!activeCast.player || !activeCast.device) return;
  const clamped = Math.max(0, Number(targetSeconds) || 0);

  if (activeCast.mode === "direct" || activeCast.mode === "remote") {
    activeCast.player.seek(clamped, (err, status) => {
      if (!err) handlePlayerStatus(status);
    });
  } else {
    activeCast.seekOffset = Math.floor(clamped);
    activeCast.currentTime = activeCast.seekOffset;
    const localIp = getLocalIpAddress(activeCast.device.host);
    const streamUrl = `http://${localIp}:${httpPort}/video?start=${activeCast.seekOffset}&t=${Date.now()}`;

    try {
      await loadCurrentStreamOnPlayer({
        player: activeCast.player,
        streamUrl,
        contentType: getStreamContentType(),
        streamType: "BUFFERED",
        title: activeCast.title,
        duration: activeCast.duration,
        autoplay: true,
        initialCurrentTime: 0,
        localIp,
      });
    } catch (err) {
      logError(`Seek reload error: ${err.message}`);
    }
  }
}

function setCastVolume(level, muted) {
  if (!activeCast.client) return;
  const volObj = {};
  if (typeof level === "number") {
    volObj.level = Math.max(0, Math.min(1, level));
  }
  if (typeof muted === "boolean") {
    volObj.muted = muted;
  }
  activeCast.client.setVolume(volObj, (err, vol) => {
    if (!err && vol) {
      activeCast.volume =
        typeof vol.level === "number" ? vol.level : activeCast.volume;
      activeCast.muted =
        typeof vol.muted === "boolean" ? vol.muted : activeCast.muted;
    }
  });
}

async function stopCasting(closeApp = true, preserveConnectingState = false) {
  if (!preserveConnectingState) {
    currentCastSessionId += 1;
  }
  if (activeCast.statusTimer) {
    clearInterval(activeCast.statusTimer);
    activeCast.statusTimer = null;
  }

  const player = activeCast.player;
  const client = activeCast.client;

  activeCast.client = null;
  activeCast.player = null;
  if (!preserveConnectingState) {
    activeCast.isLoadingMedia = false;
    activeCast.device = null;
    activeCast.mode = "idle";
    activeCast.playerState = "IDLE";
    activeCast.currentTime = 0;
    activeCast.seekOffset = 0;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 400);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (closeApp && client && player) {
      try {
        client.stop(player, () => done());
      } catch (e) {
        done();
      }
    } else if (player) {
      try {
        player.stop(() => done());
      } catch (e) {
        done();
      }
    } else {
      done();
    }
  });

  killActiveFfmpeg();
  killActiveSubProc();

  if (client) {
    try {
      client.close();
    } catch (e) {}
  }
}

function getSortedDevices() {
  return Array.from(devices.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// --- Control API Server on fixed localhost port 45890 ---
function buildFullStateSnapshot() {
  return {
    devices: getSortedDevices(),
    castState: activeCast.playerState,
    activeDevice: activeCast.device,
    mode: activeCast.mode,
    modeReason: activeCast.modeReason,
    mediaInfo: activeCast.mediaInfo,
    compatibility: activeCast.compatibility,
    audioStreamIndex: activeCast.audioStreamIndex,
    subtitleStreamIndex: activeCast.subtitleStreamIndex,
    currentTime: activeCast.currentTime,
    duration: activeCast.duration,
    volume: activeCast.volume,
    muted: activeCast.muted,
    finishedCounter: activeCast.finishedCounter,
    error: activeCast.error,
  };
}

async function handleAction(action, payload = {}) {
  if (payload.language) {
    config.language = payload.language;
  }
  switch (action) {
    case "init":
      if (payload.ffmpegPath !== undefined) resolveBinaries(payload.ffmpegPath);
      if (payload.transcodeMode) config.transcodeMode = payload.transcodeMode;
      if (payload.videoBitrate) config.videoBitrate = payload.videoBitrate;
      if (payload.maxResolution)
        config.maxResolution = Number(payload.maxResolution) || 1080;
      if (payload.allow4kHevc) config.allow4kHevc = payload.allow4kHevc;
      for (const [id, dev] of devices.entries()) {
        dev.supports4kHevc = detect4kHevcSupport(dev.model, dev.name);
        devices.set(id, dev);
      }
      queryMdns(true);
      return buildFullStateSnapshot();

    case "scan":
      queryMdns(true);
      return buildFullStateSnapshot();

    case "cast":
      // Run startCasting asynchronously so HTTP RPC returns promptly
      startCasting(payload).catch((err) => {
        logError(err.message);
      });
      return buildFullStateSnapshot();

    case "select_tracks":
      selectTracks(payload).catch((err) => {
        logError(err.message);
      });
      return buildFullStateSnapshot();

    case "play":
      playCast();
      return buildFullStateSnapshot();

    case "pause":
      pauseCast();
      return buildFullStateSnapshot();

    case "seek":
      seekCast(payload.time).catch((err) => {
        logError(err.message);
      });
      return buildFullStateSnapshot();

    case "volume":
      setCastVolume(payload.level, payload.muted);
      return buildFullStateSnapshot();

    case "stop":
      await stopCasting();
      return buildFullStateSnapshot();

    case "probe":
      if (payload.filePath && fs.existsSync(payload.filePath)) {
        const probeData = await probeMedia(payload.filePath);
        const targetDev = payload.deviceId
          ? devices.get(payload.deviceId)
          : Array.from(devices.values())[0];
        const compat = analyzeCompatibility(payload.filePath, probeData, {
          forceMode: payload.transcodeMode || config.transcodeMode,
          deviceSupports4kHevc: targetDev ? targetDev.supports4kHevc : false,
          selectedAudioStreamIndex: payload.audioStreamIndex,
        });
        return { compatibility: compat, state: buildFullStateSnapshot() };
      }
      return { compatibility: null, state: buildFullStateSnapshot() };

    default:
      return buildFullStateSnapshot();
  }
}

function startControlServer() {
  const server = http.createServer((req, res) => {
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
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body || "{}");
          const result = await handleAction(msg.action, msg.payload || {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          logError(err.message);
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

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Another daemon instance is already running on 45890, exit cleanly
      process.exit(0);
    }
  });

  server.listen(CONTROL_PORT, "127.0.0.1", async () => {
    resolveBinaries("");
    await ensureHttpServer();
    startDiscovery();
  });
}

startControlServer();
