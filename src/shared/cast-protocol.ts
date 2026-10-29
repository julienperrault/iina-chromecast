/**
 * Wire-format Protocol Buffers encoder/decoder for Google Cast CASTV2 CastMessage
 * Replaces protobufjs + long (saving 90+ KB of dependencies)
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

export function writeVarint(arr: number[], val: number): void {
  val = val >>> 0;
  while (val > 0x7f) {
    arr.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  arr.push(val);
}

export function writeBytes(chunks: Buffer[], tag: number, buf: Buffer): void {
  const head: number[] = [tag];
  writeVarint(head, buf.length);
  chunks.push(Buffer.from(head), buf);
}

export function readVarint(buf: Buffer, offset: number): [number, number] {
  let val = 0;
  let shift = 0;
  let b: number;
  do {
    b = buf[offset++];
    val |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [val >>> 0, offset];
}

export function skipField(buf: Buffer, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(buf, offset)[1];
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const [len, next] = readVarint(buf, offset);
    return next + len;
  }
  if (wireType === 5) return offset + 4;
  return buf.length;
}

export const CastMessage = {
  serialize(msg: CastMessagePayload): Buffer {
    const chunks: Buffer[] = [];
    const pv = [0x08];
    writeVarint(pv, msg.protocolVersion || 0);
    chunks.push(Buffer.from(pv));

    if (msg.sourceId !== undefined) {
      writeBytes(chunks, 0x12, Buffer.from(msg.sourceId, "utf8"));
    }
    if (msg.destinationId !== undefined) {
      writeBytes(chunks, 0x1a, Buffer.from(msg.destinationId, "utf8"));
    }
    if (msg.namespace !== undefined) {
      writeBytes(chunks, 0x22, Buffer.from(msg.namespace, "utf8"));
    }

    const pt = [0x28];
    writeVarint(pt, msg.payloadType || 0);
    chunks.push(Buffer.from(pt));

    if (msg.payloadUtf8 !== undefined) {
      writeBytes(chunks, 0x32, Buffer.from(msg.payloadUtf8, "utf8"));
    }
    if (msg.payloadBinary !== undefined) {
      writeBytes(chunks, 0x3a, msg.payloadBinary);
    }

    return Buffer.concat(chunks);
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
    let offset = 0;
    while (offset < buf.length) {
      let tag: number;
      [tag, offset] = readVarint(buf, offset);
      const field = tag >>> 3;
      const wire = tag & 0x07;
      if (field === 1 && wire === 0) {
        [msg.protocolVersion, offset] = readVarint(buf, offset);
      } else if (field === 5 && wire === 0) {
        let pType: number;
        [pType, offset] = readVarint(buf, offset);
        msg.payloadType = pType === 1 ? 1 : 0;
      } else if (
        (field === 2 || field === 3 || field === 4 || field === 6 || field === 7) &&
        wire === 2
      ) {
        let len: number;
        [len, offset] = readVarint(buf, offset);
        const slice = buf.subarray(offset, offset + len);
        offset += len;
        if (field === 2) msg.sourceId = slice.toString("utf8");
        else if (field === 3) msg.destinationId = slice.toString("utf8");
        else if (field === 4) msg.namespace = slice.toString("utf8");
        else if (field === 6) msg.payloadUtf8 = slice.toString("utf8");
        else if (field === 7) msg.payloadBinary = slice;
      } else {
        offset = skipField(buf, offset, wire);
      }
    }
    return msg;
  },
};
