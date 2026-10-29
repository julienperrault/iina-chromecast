/**
 * Shared fixtures for benchmarks and tests.
 */

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function formatTs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** Realistic WebVTT file: one 2.5 s cue every ~4.3 s over `durationSec`. */
function makeVtt(durationSec) {
  const lines = ["WEBVTT", ""];
  for (let i = 1, t0 = 1234; t0 < durationSec * 1000; i++, t0 += 4321) {
    lines.push(String(i), `${formatTs(t0)} --> ${formatTs(t0 + 2500)}`, `Ligne de sous-titre numéro ${i} : 12h30, 3.14`, "");
  }
  return lines.join("\n");
}

const STATUS_MSG = {
  protocolVersion: 0,
  sourceId: "receiver-0",
  destinationId: "client-17",
  namespace: "urn:x-cast:com.google.cast.media",
  payloadType: 0,
  payloadUtf8: JSON.stringify({
    type: "MEDIA_STATUS",
    requestId: 0,
    status: [
      {
        mediaSessionId: 1,
        playbackRate: 1,
        playerState: "PLAYING",
        currentTime: 1234.567,
        supportedMediaCommands: 274447,
        volume: { level: 1, muted: false },
        media: {
          contentId: "http://192.168.1.20:51234/video?start=0&t=1730000000000",
          contentType: "video/mp4",
          streamType: "BUFFERED",
          duration: 7200.5,
          metadata: { type: 0, metadataType: 0, title: "Un film assez long — épisode 1.mkv" },
        },
        activeTrackIds: [1],
      },
    ],
  }),
};

const PROBE_4K_MKV = {
  format: { duration: "7200.5" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le", width: 3840, height: 2160 },
    { index: 1, codec_type: "audio", codec_name: "eac3", channels: 6, tags: { language: "fre", title: "VF" } },
    { index: 2, codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" } },
    { index: 3, codec_type: "subtitle", codec_name: "subrip", tags: { language: "fre" } },
    { index: 4, codec_type: "subtitle", codec_name: "ass", tags: { language: "eng", title: "Full" } },
    { index: 5, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" },
    { index: 6, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
  ],
};

module.exports = { makeVtt, formatTs, STATUS_MSG, PROBE_4K_MKV };
