declare module "multicast-dns" {
  import { EventEmitter } from "node:events";

  export interface DnsAnswer {
    name: string;
    type: string;
    data: any;
    ttl?: number;
  }

  export interface DnsResponsePacket {
    answers: DnsAnswer[];
    additionals?: DnsAnswer[];
  }

  export interface MulticastDnsInstance extends EventEmitter {
    query(packet: { questions: Array<{ name: string; type: string }> }): void;
    destroy(callback?: () => void): void;
    on(event: "response", listener: (response: DnsResponsePacket) => void): this;
    on(event: "warning" | "error", listener: (err: Error) => void): this;
  }

  export default function createMdns(options?: Record<string, unknown>): MulticastDnsInstance;
}

declare module "castv2-client" {
  import { EventEmitter } from "node:events";

  export interface MediaMetadata {
    metadataType?: number;
    title?: string;
    images?: Array<{ url: string }>;
  }

  export interface MediaInfo {
    contentId: string;
    contentType: string;
    streamType: "BUFFERED" | "LIVE" | "OTHER";
    metadata?: MediaMetadata;
    tracks?: any[];
  }

  export interface MediaStatus {
    playerState: string;
    currentTime?: number;
    media?: {
      duration?: number;
      metadata?: MediaMetadata;
    };
    volume?: {
      level?: number;
      muted?: boolean;
    };
    activeTrackIds?: number[];
  }

  export class DefaultMediaReceiver extends EventEmitter {
    static APP_ID: string;
    load(
      media: MediaInfo,
      options: { autoplay?: boolean; currentTime?: number; activeTrackIds?: number[] },
      callback: (err: Error | null, status?: MediaStatus) => void
    ): void;
    play(callback?: (err: Error | null, status?: MediaStatus) => void): void;
    pause(callback?: (err: Error | null, status?: MediaStatus) => void): void;
    stop(callback?: (err: Error | null, status?: MediaStatus) => void): void;
    seek(currentTime: number, callback?: (err: Error | null, status?: MediaStatus) => void): void;
    getStatus(callback: (err: Error | null, status?: MediaStatus) => void): void;
    on(event: "status", listener: (status: MediaStatus) => void): this;
    on(event: "close", listener: () => void): this;
  }

  export class Client extends EventEmitter {
    connect(options: { host: string; port?: number }, callback: () => void): void;
    launch(
      appReceiver: typeof DefaultMediaReceiver,
      callback: (err: Error | null, player: DefaultMediaReceiver) => void
    ): void;
    join(
      appReceiver: typeof DefaultMediaReceiver,
      callback: (err: Error | null, player: DefaultMediaReceiver) => void
    ): void;
    stop(player: DefaultMediaReceiver, callback: (err: Error | null) => void): void;
    setVolume(volume: { level?: number; muted?: boolean }, callback: (err: Error | null) => void): void;
    getVolume(callback: (err: Error | null, volume: { level: number; muted: boolean }) => void): void;
    close(): void;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "status", listener: (status: any) => void): this;
    on(event: "close", listener: () => void): this;
  }
}
