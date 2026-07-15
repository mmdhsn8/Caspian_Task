import type { ListingDetail } from "../models/listing.js";

export interface DetailCacheEntry {
  schemaVersion: number;
  listingId: string;
  propertyUrl: string;
  cachedAt: string;
  expiresAt: string;
  summaryFingerprint: string;
  detail: ListingDetail;
}

export interface DetailCacheDocument {
  schemaVersion: number;
  updatedAt: string;
  entries: Record<string, DetailCacheEntry>;
}

export interface DetailCacheStats {
  hits: number;
  misses: number;
  expired: number;
  writes: number;
  evictions: number;
  entries?: number;
  writeFailed?: boolean;
}
