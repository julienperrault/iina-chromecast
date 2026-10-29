/**
 * mDNS Chromecast Discovery and Capability Detection
 */

import mdns from "multicast-dns";
import dns from "node:dns";
import type { DiscoveredDevice } from "../types/plugin.js";
import type { DaemonConfig } from "../types/rpc.js";

export const KEYWORDS_4K = [
  "ultra", "google tv", "streamer", "shield", "bravia", "philips", "tcl",
  "hisense", "mi box", "mibox", "4k", "sabrina", "kirkwood", "chromecast hd",
  "android tv", "fire tv 4k", "firetv 4k", "oled", "qled", "uhd"
];

export const KEYWORDS_AUDIO_ONLY = [
  "home mini", "google home", "nest audio", "nest mini", "speaker", "soundbar",
  "enceinte", "chromecast audio"
];

const REGEX_4K = new RegExp(KEYWORDS_4K.join("|"), "i");
const REGEX_AUDIO_ONLY = new RegExp(KEYWORDS_AUDIO_ONLY.join("|"), "i");

export function detect4kHevcSupport(
  model = "",
  friendlyName = "",
  allow4kHevc: "auto" | "always" | "never" = "auto"
): boolean {
  if (allow4kHevc === "always") return true;
  if (allow4kHevc === "never") return false;
  return REGEX_4K.test(`${model} ${friendlyName}`);
}

export function isAudioOnlyDevice(model = "", friendlyName = ""): boolean {
  return REGEX_AUDIO_ONLY.test(`${model} ${friendlyName}`);
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
  private scanTimers: Array<ReturnType<typeof setTimeout>> = [];
  private periodicScanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(getConfig: () => DaemonConfig, devices: Map<string, DiscoveredDevice> = new Map()) {
    this.getConfig = getConfig;
    this.devices = devices;
  }

  public getDevices(): DiscoveredDevice[] {
    return Array.from(this.devices.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  public getDevice(id: string): DiscoveredDevice | undefined {
    return this.devices.get(id);
  }

  public updateDeviceCapabilities(): void {
    const config = this.getConfig();
    for (const [id, dev] of this.devices.entries()) {
      dev.supports4kHevc = detect4kHevcSupport(dev.model, dev.name, config.allow4kHevc);
      this.devices.set(id, dev);
    }
  }

  public startDiscovery(): void {
    if (this.mdnsInstance) {
      try { this.mdnsInstance.destroy(); } catch {}
    }

    this.mdnsInstance = mdns();
    const dnsRecords = new Map<string, DnsEntry>();

    this.mdnsInstance.on("response", (packet: { answers?: any[]; additionals?: any[] }) => {
      const allRecords = [...(packet.answers || []), ...(packet.additionals || [])];
      let hasCast = false;

      for (const rec of allRecords) {
        const isCast = String(rec.name || "").endsWith("._googlecast._tcp.local");
        if (rec.type === "PTR" && rec.name === "_googlecast._tcp.local") {
          hasCast = true;
          if (!dnsRecords.has(rec.data)) setBoundedMap(dnsRecords, rec.data, {});
          const entry = dnsRecords.get(rec.data);
          if (!entry?.srv || !entry?.txt) {
            try {
              this.mdnsInstance?.query({
                questions: [
                  { name: rec.data, type: "SRV" },
                  { name: rec.data, type: "TXT" },
                ],
              });
            } catch {}
          }
        } else if (rec.type === "SRV" && isCast) {
          hasCast = true;
          const entry = dnsRecords.get(rec.name) || {};
          entry.srv = rec.data;
          setBoundedMap(dnsRecords, rec.name, entry);
          if (rec.data?.target) {
            try {
              this.mdnsInstance?.query({
                questions: [{ name: rec.data.target, type: "A" }],
              });
            } catch {}
            dns.lookup(rec.data.target, { family: 4 }, (err, address) => {
              if (!err && address) {
                entry.a = address;
                setBoundedMap(dnsRecords, `A:${rec.data.target}`, { a: address });
                this.rebuildDevices(dnsRecords);
              }
            });
          }
        } else if (rec.type === "TXT" && isCast) {
          hasCast = true;
          const entry = dnsRecords.get(rec.name) || {};
          const txtObj: Record<string, string> = {};
          const buffers = Array.isArray(rec.data) ? rec.data : [rec.data];
          for (const buf of buffers) {
            const str = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
            const idx = str.indexOf("=");
            if (idx > 0) txtObj[str.slice(0, idx)] = str.slice(idx + 1);
          }
          entry.txt = txtObj;
          setBoundedMap(dnsRecords, rec.name, entry);
        } else if (rec.type === "A") {
          for (const [instName, entry] of dnsRecords.entries()) {
            if (entry.srv && entry.srv.target === rec.name) {
              entry.a = rec.data;
              dnsRecords.set(instName, entry);
              hasCast = true;
            }
          }
          setBoundedMap(dnsRecords, `A:${rec.name}`, { a: rec.data });
        }
      }

      if (hasCast) {
        this.rebuildDevices(dnsRecords);
      }
    });

    this.mdnsInstance.on("error", () => {});
    this.queryMdns(true);

    if (this.periodicScanTimer) clearInterval(this.periodicScanTimer);
    this.periodicScanTimer = setInterval(() => {
      this.queryMdns(false);
    }, 15000);
  }

  private rebuildDevices(dnsRecords: Map<string, DnsEntry>): void {
    for (const [key, entry] of dnsRecords.entries()) {
      if (key.startsWith("A:") || !key.endsWith("._googlecast._tcp.local") || !entry.srv) continue;
      const hostIp = entry.a || dnsRecords.get(`A:${entry.srv.target}`)?.a;
      if (!hostIp) {
        if (entry.srv.target) {
          dns.lookup(entry.srv.target, { family: 4 }, (err, address) => {
            if (!err && address) {
              entry.a = address;
              setBoundedMap(dnsRecords, `A:${entry.srv?.target}`, { a: address });
              this.rebuildDevices(dnsRecords);
            }
          });
        }
        continue;
      }

      const txt = entry.txt || {};
      const id = txt.id || key;
      const friendlyName = txt.fn || key.replace("._googlecast._tcp.local", "");
      const model = txt.md || "Chromecast";
      const caNum = parseInt(txt.ca || "0", 10);
      const hasVideo = caNum > 0 ? (caNum & 1) === 1 : true;

      if (isAudioOnlyDevice(model, friendlyName) || !hasVideo) continue;

      const dev: DiscoveredDevice = {
        id,
        name: friendlyName,
        model,
        host: hostIp,
        port: entry.srv.port || 8009,
        supports4kHevc: detect4kHevcSupport(model, friendlyName, this.getConfig().allow4kHevc),
      };

      const existing = this.devices.get(id);
      if (!existing || existing.host !== hostIp || existing.name !== friendlyName) {
        this.devices.set(id, dev);
        console.log(`[discovery] Discovered device: "${friendlyName}" (${model}) at ${hostIp}:${entry.srv.port || 8009}`);
      }
    }
  }

  public queryMdns(withFollowUp = false): void {
    if (!this.mdnsInstance) return;
    const send = () => {
      try { this.mdnsInstance?.query({ questions: [{ name: "_googlecast._tcp.local", type: "PTR" }] }); } catch {}
    };
    send();

    if (withFollowUp) {
      this.clearScanTimers();
      const delays = [350, 1000, 2200];
      for (const delay of delays) {
        this.scanTimers.push(setTimeout(send, delay));
      }
    }
  }

  private clearScanTimers(): void {
    for (const timer of this.scanTimers) {
      clearTimeout(timer);
    }
    this.scanTimers = [];
  }

  public destroy(): void {
    this.clearScanTimers();
    if (this.periodicScanTimer) {
      clearInterval(this.periodicScanTimer);
      this.periodicScanTimer = null;
    }
    if (this.mdnsInstance) {
      try { this.mdnsInstance.destroy(); } catch {}
      this.mdnsInstance = null;
    }
  }
}
