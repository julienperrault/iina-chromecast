/**
 * mDNS Chromecast Discovery and Capability Detection
 */

import mdns from "multicast-dns";
import type { DiscoveredDevice } from "../types/plugin.js";
import type { DaemonConfig } from "../types/rpc.js";

export const KEYWORDS_4K = [
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
  "android tv",
  "fire tv 4k",
  "firetv 4k",
  "oled",
  "qled",
  "uhd",
];

export const KEYWORDS_AUDIO_ONLY = [
  "home mini",
  "google home",
  "nest audio",
  "nest mini",
  "speaker",
  "soundbar",
  "enceinte",
  "chromecast audio",
];

export function detect4kHevcSupport(
  model = "",
  friendlyName = "",
  allow4kHevc: "auto" | "always" | "never" = "auto"
): boolean {
  if (allow4kHevc === "always") return true;
  if (allow4kHevc === "never") return false;

  const str = `${model} ${friendlyName}`.toLowerCase();
  return KEYWORDS_4K.some((kw) => str.includes(kw));
}

export function isAudioOnlyDevice(model = "", friendlyName = ""): boolean {
  const str = `${model} ${friendlyName}`.toLowerCase();
  return KEYWORDS_AUDIO_ONLY.some((kw) => str.includes(kw));
}

export function setBoundedMap<K, V>(map: Map<K, V>, key: K, val: V, max = 200): void {
  if (map.size >= max && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, val);
}

interface DnsEntry {
  srv?: { port: number; target: string };
  txt?: Record<string, string>;
  a?: string;
}

export class DiscoveryService {
  private getConfig: () => DaemonConfig;
  private devices: Map<string, DiscoveredDevice>;
  private mdnsInstance: ReturnType<typeof mdns> | null = null;
  private scanBurstTimer: NodeJS.Timeout | null = null;

  constructor(
    getConfig: () => DaemonConfig,
    devices: Map<string, DiscoveredDevice> = new Map()
  ) {
    this.getConfig = getConfig;
    this.devices = devices;
  }

  public getDevices(): DiscoveredDevice[] {
    return Array.from(this.devices.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  public getDevice(id: string): DiscoveredDevice | undefined {
    return this.devices.get(id);
  }

  public updateDeviceCapabilities(): void {
    const config = this.getConfig();
    for (const [id, dev] of this.devices.entries()) {
      dev.supports4kHevc = detect4kHevcSupport(
        dev.model,
        dev.name,
        config.allow4kHevc
      );
      this.devices.set(id, dev);
    }
  }

  public startDiscovery(): void {
    if (this.mdnsInstance) {
      try {
        this.mdnsInstance.destroy();
      } catch (e) {}
    }

    this.mdnsInstance = mdns();
    const dnsRecords = new Map<string, DnsEntry>();

    this.mdnsInstance.on("response", (packet: { answers?: any[]; additionals?: any[] }) => {
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
          if (!String(rec.name || "").endsWith("._googlecast._tcp.local")) continue;
          hasCastRecords = true;
          const entry = dnsRecords.get(rec.name) || {};
          entry.srv = rec.data;
          setBoundedMap(dnsRecords, rec.name, entry, 200);
        } else if (rec.type === "TXT") {
          if (!String(rec.name || "").endsWith("._googlecast._tcp.local")) continue;
          hasCastRecords = true;
          const entry = dnsRecords.get(rec.name) || {};
          const txtObj: Record<string, string> = {};
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
          setBoundedMap(dnsRecords, `A:${rec.name}`, { a: rec.data }, 200);
        }
      }

      if (!hasCastRecords) return;

      for (const [key, entry] of dnsRecords.entries()) {
        if (key.startsWith("A:") || !key.endsWith("._googlecast._tcp.local")) {
          continue;
        }

        if (entry.srv) {
          const hostIp = entry.a || dnsRecords.get(`A:${entry.srv.target}`)?.a;
          if (hostIp) {
            const txt = entry.txt || {};
            const id = txt.id || key;
            const friendlyName = txt.fn || key.replace("._googlecast._tcp.local", "");
            const model = txt.md || "Chromecast";
            const port = entry.srv.port || 8009;

            const caNum = parseInt(txt.ca || "0", 10);
            const hasVideoBit = caNum > 0 ? (caNum & 1) === 1 : true;
            const isAudioOnly =
              isAudioOnlyDevice(model, friendlyName) || !hasVideoBit;
            if (isAudioOnly) {
              continue;
            }

            const supports4kHevc = detect4kHevcSupport(
              model,
              friendlyName,
              this.getConfig().allow4kHevc
            );

            this.devices.set(id, {
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

    this.mdnsInstance.on("error", () => {});
    this.queryMdns();
  }

  public queryMdns(withFollowUp = false): void {
    if (!this.mdnsInstance) return;
    const sendQuery = () => {
      try {
        this.mdnsInstance?.query({
          questions: [{ name: "_googlecast._tcp.local", type: "PTR" }],
        });
      } catch (err) {}
    };
    sendQuery();
    if (withFollowUp) {
      if (this.scanBurstTimer) clearTimeout(this.scanBurstTimer);
      this.scanBurstTimer = setTimeout(sendQuery, 500);
    }
  }

  public destroy(): void {
    if (this.scanBurstTimer) clearTimeout(this.scanBurstTimer);
    if (this.mdnsInstance) {
      try {
        this.mdnsInstance.destroy();
      } catch (e) {}
      this.mdnsInstance = null;
    }
  }
}
