import { access } from "node:fs/promises";
import { DetailCache } from "../cache/detail-cache.js";
import { env } from "../config/env.js";

try {
  await access(env.detailCachePath);
} catch {
  throw new Error("Detail cache does not exist: " + env.detailCachePath);
}
const cache = new DetailCache({
  enabled: env.detailCacheEnabled,
  path: env.detailCachePath,
  ttlMs: env.detailCacheTtlHours * 60 * 60 * 1000,
  maxEntries: env.detailCacheMaxEntries,
  schemaVersion: env.detailCacheSchemaVersion,
});
await cache.load();
const summary = cache.getSnapshotSummary();
console.log("Entries: " + String(summary.entries));
console.log("Valid: " + String(summary.valid));
console.log("Expired: " + String(summary.expired));
console.log("Max entries: " + String(env.detailCacheMaxEntries));
console.log("Schema version: " + String(env.detailCacheSchemaVersion));
console.log("Oldest entry: " + (summary.oldestCachedAt ?? "none"));
console.log("Newest entry: " + (summary.newestCachedAt ?? "none"));
