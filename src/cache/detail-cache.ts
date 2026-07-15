import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ListingSummary } from "../models/listing.js";
import type { ListingDetail } from "../models/listing.js";
import type {
  DetailCacheDocument,
  DetailCacheEntry,
  DetailCacheStats,
} from "./cache-types.js";

export interface DetailCacheConfig {
  readonly enabled: boolean;
  readonly path: string;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly schemaVersion: number;
}

function cleanString(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function cleanNumber(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

export function summaryFingerprint(summary: ListingSummary): string {
  const tuple = [
    cleanString(summary.listingId),
    cleanString(summary.url),
    cleanNumber(summary.price),
    cleanString(summary.address),
    cleanString(summary.propertyType),
    cleanNumber(summary.bedrooms),
    cleanNumber(summary.bathrooms),
  ].join("|");
  return createHash("sha256").update(tuple, "utf8").digest("hex");
}

function emptyDocument(schemaVersion: number): DetailCacheDocument {
  return { schemaVersion, updatedAt: new Date().toISOString(), entries: {} };
}

function corruptPath(path: string): string {
  return path.endsWith(".json")
    ? path.slice(0, -".json".length) + ".corrupt." + String(Date.now()) + ".json"
    : path + ".corrupt." + String(Date.now()) + ".json";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function hasUnsafeKeys(value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") return true;
    if (hasUnsafeKeys(child)) return true;
  }
  return false;
}

function isValidDetail(detail: unknown, listingId: string): detail is ListingDetail {
  if (!isObject(detail) || hasUnsafeKeys(detail)) return false;
  const requiredKeys = [
    "url",
    "price",
    "priceRaw",
    "address",
    "propertyType",
    "bedrooms",
    "bathrooms",
    "brokerId",
    "brokerName",
    "brokerPhone",
    "brokerProfileUrl",
    "agencyName",
    "rooms",
    "livingArea",
    "yearBuilt",
    "parking",
    "latitude",
    "longitude",
    "landAssessment",
    "buildingAssessment",
    "totalAssessment",
    "municipalTax",
    "schoolTax",
    "condoFees",
    "scrapedAt",
  ];
  return (
    detail.listingId === listingId &&
    typeof detail.url === "string" &&
    /^https?:\/\//.test(detail.url) &&
    typeof detail.scrapedAt === "string" &&
    detail.scrapedAt.length > 0 &&
    requiredKeys.every((key) => key in detail)
  );
}

function isValidEntry(
  value: unknown,
  key: string,
  config: DetailCacheConfig,
  nowMs: number,
): value is DetailCacheEntry {
  if (!isObject(value)) return false;
  const detail = value.detail;
  return (
    value.schemaVersion === config.schemaVersion &&
    value.listingId === key &&
    typeof value.propertyUrl === "string" &&
    /^https?:\/\//.test(value.propertyUrl) &&
    typeof value.cachedAt === "string" &&
    typeof value.expiresAt === "string" &&
    Date.parse(value.expiresAt) > nowMs &&
    typeof value.summaryFingerprint === "string" &&
    isValidDetail(detail, key)
  );
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + String(process.pid) + ".tmp";
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

export class DetailCache {
  private readonly config: DetailCacheConfig;
  private readonly path: string;
  private document: DetailCacheDocument | null = null;
  private dirty = false;
  private readonly stats: DetailCacheStats = {
    hits: 0,
    misses: 0,
    expired: 0,
    writes: 0,
    evictions: 0,
  };

  constructor(config: DetailCacheConfig) {
    this.config = config;
    this.path = resolve(config.path);
  }

  async load(): Promise<void> {
    if (this.document || !this.config.enabled) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed) || parsed.schemaVersion !== this.config.schemaVersion) {
        throw new Error("cache schema mismatch");
      }
      const entries: Record<string, DetailCacheEntry> = {};
      const rawEntries = isObject(parsed.entries) ? parsed.entries : {};
      const nowMs = Date.now();
      for (const [key, value] of Object.entries(rawEntries)) {
        if (isValidEntry(value, key, this.config, nowMs)) entries[key] = value;
        else if (isObject(value) && typeof value.expiresAt === "string")
          this.stats.expired++;
      }
      this.document = {
        schemaVersion: this.config.schemaVersion,
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date().toISOString(),
        entries,
      };
    } catch (error) {
      if (!isMissing(error)) {
        try {
          await rename(this.path, corruptPath(this.path));
        } catch {
          // Failed recovery does not prevent a run.
        }
        console.warn(
          "[cache] detail cache unavailable; starting clean: " +
            (error instanceof Error ? error.message : "invalid cache"),
        );
      }
      this.document = emptyDocument(this.config.schemaVersion);
    }
  }

  async get(summary: ListingSummary): Promise<ListingDetail | null> {
    if (!this.config.enabled) return null;
    await this.load();
    const entry = this.document?.entries[summary.listingId];
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (
      !isValidEntry(entry, summary.listingId, this.config, Date.now()) ||
      entry.propertyUrl !== summary.url ||
      entry.summaryFingerprint !== summaryFingerprint(summary)
    ) {
      if (Date.parse(entry.expiresAt) <= Date.now()) this.stats.expired++;
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return entry.detail;
  }

  set(summary: ListingSummary, detail: ListingDetail, now = new Date()): void {
    if (!this.config.enabled || !this.document) return;
    const cachedAt = now.toISOString();
    const entry: DetailCacheEntry = {
      schemaVersion: this.config.schemaVersion,
      listingId: summary.listingId,
      propertyUrl: summary.url,
      cachedAt,
      expiresAt: new Date(now.getTime() + this.config.ttlMs).toISOString(),
      summaryFingerprint: summaryFingerprint(summary),
      detail,
    };
    this.document.entries[summary.listingId] = entry;
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || !this.document || !this.dirty) return;
    const entries = Object.entries(this.document.entries);
    const nowMs = Date.now();
    const validEntries = entries.filter(
      ([, entry]) => Date.parse(entry.expiresAt) > nowMs,
    );
    this.stats.evictions += entries.length - validEntries.length;
    const remaining = validEntries
      .map(([, entry]) => entry)
      .sort((left, right) => Date.parse(left.cachedAt) - Date.parse(right.cachedAt));
    const retained = remaining.slice(-this.config.maxEntries);
    const nextEntries: Record<string, DetailCacheEntry> = {};
    for (const entry of retained) nextEntries[entry.listingId] = entry;
    this.stats.evictions += remaining.length - retained.length;
    this.document.entries = nextEntries;
    this.document.updatedAt = new Date().toISOString();
    try {
      await atomicWrite(this.path, JSON.stringify(this.document, null, 2));
      this.stats.writes++;
      this.stats.writeFailed = false;
      this.dirty = false;
    } catch (error) {
      console.warn(
        "[cache] detail cache write failed: " +
          (error instanceof Error ? error.message : "unknown error"),
      );
    }
  }

  getStats(): DetailCacheStats & { hitRate: number; entries: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total === 0 ? 0 : this.stats.hits / total,
      entries: Object.keys(this.document?.entries ?? {}).length,
    };
  }

  getSnapshotSummary(): {
    entries: number;
    valid: number;
    expired: number;
    oldestCachedAt: string | null;
    newestCachedAt: string | null;
  } {
    const entries = Object.values(this.document?.entries ?? {});
    const sorted = [...entries].sort(
      (left, right) => Date.parse(left.cachedAt) - Date.parse(right.cachedAt),
    );
    return {
      entries: entries.length,
      valid: entries.length,
      expired: this.stats.expired,
      oldestCachedAt: sorted[0]?.cachedAt ?? null,
      newestCachedAt: sorted.at(-1)?.cachedAt ?? null,
    };
  }
}
