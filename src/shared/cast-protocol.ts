/**
 * Wire-format Protocol Buffers encoder/decoder for Google Cast CASTV2 CastMessage
 * Replaces protobufjs + long (saving 90+ KB of dependencies).
 * The bundler (build.js) aliases `castv2/lib/proto.js` to this module.
 */

export interface CastMessagePayload {
  protocolVersion?: number;
  sourceId: string;
  destinationId: string;
  namespace: string;
  payloadType: 0 | 1; // 0 = STRING (JSON), 1 = BINARY
  payloadUtf8?: string;
  payloadBinary?: Buffer;
}

// Field tags: (fieldNumber << 3) | wireType
const TAG_PROTOCOL_VERSION = 0x08;
const TAG_SOURCE_ID = 0x12;
const TAG_DESTINATION_ID = 0x1a;
const TAG_NAMESPACE = 0x22;
const TAG_PAYLOAD_TYPE = 0x28;
const TAG_PAYLOAD_UTF8 = 0x32;
const TAG_PAYLOAD_BINARY = 0x3a;

/** Shared read cursor (parsing is synchronous, so a module-level cursor is safe). */
let pos = 0;

function nextVarint(buf: Buffer): number {
  let val = 0;
  let shift = 0;
  let b: number;
  do {
    b = buf[pos++];
    val |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80 && shift < 35);
  return val >>> 0;
}

function skipValue(buf: Buffer, wireType: number): void {
  if (wireType === 0) nextVarint(buf);
  else if (wireType === 1) pos += 8;
  else if (wireType === 2) pos += nextVarint(buf);
  else if (wireType === 5) pos += 4;
  else pos = buf.length;
}

function varintSize(val: number): number {
  val >>>= 0;
  let n = 1;
  while (val > 0x7f) {
    val >>>= 7;
    n++;
  }
  return n;
}

function putVarint(out: Buffer, offset: number, val: number): number {
  val >>>= 0;
  while (val > 0x7f) {
    out[offset++] = (val & 0x7f) | 0x80;
    val >>>= 7;
  }
  out[offset++] = val;
  return offset;
}

export function writeVarint(arr: number[], val: number): void {
  val >>>= 0;
  while (val > 0x7f) {
    arr.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  arr.push(val);
}

export function readVarint(buf: Buffer, offset: number): [number, number] {
  pos = offset;
  const val = nextVarint(buf);
  return [val, pos];
}

export const CastMessage = {
  /** Encodes into a single pre-sized buffer (no intermediate chunks / concat). */
  serialize(msg: CastMessagePayload): Buffer {
    const pv = msg.protocolVersion || 0;
    const pt = msg.payloadType || 0;
    const strings: [number, string | undefined][] = [
      [TAG_SOURCE_ID, msg.sourceId],
      [TAG_DESTINATION_ID, msg.destinationId],
      [TAG_NAMESPACE, msg.namespace],
    ];
    const lengths = strings.map(([, s]) => (s === undefined ? -1 : Buffer.byteLength(s)));
    const utf8 = msg.payloadUtf8;
    const utf8Len = utf8 === undefined ? -1 : Buffer.byteLength(utf8);
    const bin = msg.payloadBinary;
    const binLen = bin === undefined ? -1 : bin.length;

    const fieldSize = (len: number) => (len < 0 ? 0 : 1 + varintSize(len) + len);
    const out = Buffer.allocUnsafe(
      2 + varintSize(pv) + varintSize(pt) +
      fieldSize(lengths[0]) + fieldSize(lengths[1]) + fieldSize(lengths[2]) +
      fieldSize(utf8Len) + fieldSize(binLen)
    );

    let o = 0;
    const putString = (tag: number, str: string, len: number) => {
      out[o++] = tag;
      o = putVarint(out, o, len);
      o += out.write(str, o, len, "utf8");
    };

    out[o++] = TAG_PROTOCOL_VERSION;
    o = putVarint(out, o, pv);
    for (let i = 0; i < 3; i++) {
      if (lengths[i] >= 0) putString(strings[i][0], strings[i][1]!, lengths[i]);
    }
    out[o++] = TAG_PAYLOAD_TYPE;
    o = putVarint(out, o, pt);
    if (utf8 !== undefined) putString(TAG_PAYLOAD_UTF8, utf8, utf8Len);
    if (bin !== undefined) {
      out[o++] = TAG_PAYLOAD_BINARY;
      o = putVarint(out, o, binLen);
      bin.copy(out, o);
    }
    return out;
  },

  parse(buf: Buffer): CastMessagePayload {
    const msg: CastMessagePayload = {
      protocolVersion: 0,
      sourceId: "",
      destinationId: "",
      namespace: "",
      payloadType: 0,
      payloadUtf8: undefined,
      payloadBinary: undefined,
    };
    pos = 0;
    while (pos < buf.length) {
      const tag = nextVarint(buf);
      switch (tag) {
        case TAG_PROTOCOL_VERSION:
          msg.protocolVersion = nextVarint(buf);
          break;
        case TAG_PAYLOAD_TYPE:
          msg.payloadType = nextVarint(buf) === 1 ? 1 : 0;
          break;
        case TAG_SOURCE_ID:
        case TAG_DESTINATION_ID:
        case TAG_NAMESPACE:
        case TAG_PAYLOAD_UTF8:
        case TAG_PAYLOAD_BINARY: {
          const len = nextVarint(buf);
          const start = pos;
          pos += len;
          if (tag === TAG_PAYLOAD_BINARY) {
            msg.payloadBinary = buf.subarray(start, pos);
          } else {
            const str = buf.toString("utf8", start, pos);
            if (tag === TAG_SOURCE_ID) msg.sourceId = str;
            else if (tag === TAG_DESTINATION_ID) msg.destinationId = str;
            else if (tag === TAG_NAMESPACE) msg.namespace = str;
            else msg.payloadUtf8 = str;
          }
          break;
        }
        default:
          skipValue(buf, tag & 0x07);
      }
    }
    return msg;
  },
};
