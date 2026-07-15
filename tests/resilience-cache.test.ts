import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetailCache, summaryFingerprint } from "../src/cache/detail-cache.js";
import { AsyncRateLimiter } from "../src/resilience/rate-limiter.js";
import { executeWithRetry } from "../src/resilience/retry-policy.js";
import type { ListingDetail } from "../src/models/listing.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

function listing(id: string, price = 100): ListingDetail {
  return {
    listingId: id,
    url: "https://www.centris.ca/en/property/" + id,
    price,
    priceRaw: "$100",
    address: "1 Test Street",
    propertyType: "House",
    bedrooms: 2,
    bathrooms: 1,
    brokerId: null,
    brokerName: null,
    brokerPhone: null,
    brokerProfileUrl: null,
    agencyName: null,
    rooms: null,
    livingArea: null,
    yearBuilt: null,
    parking: null,
    latitude: null,
    longitude: null,
    landAssessment: null,
    buildingAssessment: null,
    totalAssessment: null,
    municipalTax: null,
    schoolTax: null,
    condoFees: null,
    scrapedAt: "2026-07-15T12:00:00.000Z",
  };
}

const directory = await mkdtemp(join(tmpdir(), "centris-resilience-"));
try {
  let attempts = 0;
  const delays: number[] = [];
  const retried = await executeWithRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("temporary network timeout");
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 },
    { sleep: async (ms) => delays.push(ms), random: () => 0.5 },
  );
  assert(retried.value === "ok" && retried.retries === 2, "retry succeeds after transient failures");
  assert(delays[0] === 100 && delays[1] === 200, "retry delay doubles exponentially");

  let now = 0;
  const limiter = new AsyncRateLimiter(
    { requestsPerMinute: 60, burst: 2 },
    { now: () => now, sleep: async (ms) => { now += ms; } },
  );
  const rateResults = await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert(rateResults[0]?.waitedMs === 0 && rateResults[1]?.waitedMs === 0, "rate limiter allows burst");
  assert((rateResults[2]?.waitedMs ?? 0) >= 1000, "rate limiter waits after burst");

  const path = join(directory, "detail-cache.json");
  const cacheConfig = {
    enabled: true,
    path,
    ttlMs: 60_000,
    maxEntries: 2,
    schemaVersion: 1,
  };
  const summary = listing("100");
  const cache = new DetailCache(cacheConfig);
  await cache.load();
  cache.set(summary, summary);
  await cache.flush();
  const warmCache = new DetailCache(cacheConfig);
  assert((await warmCache.get(summary))?.scrapedAt === summary.scrapedAt, "valid cache hit preserves scrapedAt");
  assert(summaryFingerprint(summary) !== summaryFingerprint({ ...summary, price: 101 }), "summary change changes fingerprint");
  assert((await warmCache.get({ ...summary, price: 101 })) === null, "changed summary invalidates cache");
  cache.set(listing("101"), listing("101"));
  cache.set(listing("102"), listing("102"));
  await cache.flush();
  const limitedCache = new DetailCache(cacheConfig);
  await limitedCache.load();
  assert(limitedCache.getStats().entries === 2, "cache enforces maximum entries");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(
  "\nResilience/cache tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
