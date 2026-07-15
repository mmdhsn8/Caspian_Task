import { runOnce, type RunOnceDependencies } from "../src/app/run-once.js";
import type { ListingDetail, ListingSummary } from "../src/models/listing.js";
import type { Logger } from "../src/utils/logger.js";
import type { RunMetrics } from "../src/metrics/metrics-types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

const summary: ListingSummary = {
  listingId: "100",
  url: "https://www.centris.ca/en/property/100",
  price: 100,
  priceRaw: "$100",
  address: "1 Test Street",
  propertyType: "House",
  bedrooms: 2,
  bathrooms: 1,
};

const detail: ListingDetail = {
  ...summary,
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
  scrapedAt: "2026-07-15T00:00:00.000Z",
};

const config: NonNullable<RunOnceDependencies["config"]> = {
  runIdPrefix: "test",
  headless: true,
  scraperTimeoutMs: 30_000,
  telegramEnabled: true,
  telegramChatId: "-100123456789",
  telegramBotToken: "123456:TEST_TOKEN",
  googleAppsScriptUrl: "https://script.google.com/mock/exec",
  telegramParseMode: "HTML",
  telegramMaxRetries: 2,
  failureInjectionEnabled: false,
  failureTestStage: "none",
};

const silentLogger: Logger = {
  name: "test",
  runId: "test",
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function createHealthCapture() {
  const statuses: string[] = [];
  return {
    statuses,
    store: {
      setActive: async () => undefined,
      setStage: async () => undefined,
      completeRun: async (_run: RunMetrics, status: string) => {
        statuses.push(status);
      },
    },
  };
}

let capturedRun: RunMetrics | null = null;
const health1 = createHealthCapture();
await runOnce({
  config,
  createLogger: () => silentLogger,
  healthStore: health1.store,
  appendRunMetrics: async (run) => {
    capturedRun = run;
    return true;
  },
  crawlSearchResults: async () => ({
    listings: [summary],
    pagesVisited: 1,
    totalUniqueListings: 1,
    duplicatesRemoved: 0,
    stoppedReason: "completed",
  }),
  scrapeDetailPagesWithStats: async () => ({
    details: [detail],
    stats: {
      attempted: 1,
      succeeded: 1,
      failed: 0,
      cacheHits: 0,
      cacheMisses: 1,
      liveRequests: 1,
      retries: 1,
      retryDelayMs: 100,
      rateLimitWaitMs: 250,
      rateLimitWaitCount: 1,
      rateLimitMaxWaitMs: 250,
      cacheWrites: 1,
      cacheEvictions: 0,
      cacheExpired: 0,
      cacheEntries: 1,
      cacheWriteFailed: false,
    },
    failures: [],
  }),
  syncDetailsToSheet: async (_details, options) => {
    await options?.onRetry?.({ attempt: 2, maxAttempts: 3, delayMs: 100, error: new Error("timeout") });
    await options?.onRetry?.({ attempt: 3, maxAttempts: 3, delayMs: 200, error: new Error("timeout") });
    await options?.onComplete?.({ attempts: 3, retries: 2, totalDelayMs: 300 });
    return {
      success: true,
      received: 1,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 1,
      totalStored: 1,
      newListingIds: [],
      updatedListingIds: [],
      pendingTelegramListingIds: ["100"],
      checkedAt: "2026-07-15T00:00:00.000Z",
    };
  },
  notifyNewListings: async () => ({
    requested: 1,
    sent: 1,
    failed: 0,
    skipped: 0,
    retries: 1,
    retryDelayMs: 100,
    retriedListings: 1,
    maxAttemptsUsed: 2,
    results: [
      { listingId: "100", success: true, messageId: 1, attempts: 2, error: null },
    ],
  }),
});
assert(capturedRun?.retries.searchRetries === 0, "run metrics preserve zero search retries");
assert(capturedRun?.retries.detailRetries === 1, "run metrics capture detail retries");
assert(capturedRun?.retries.sheetRetries === 2, "run metrics capture sheet retries");
assert(capturedRun?.retries.telegramRetries === 1, "run metrics capture telegram retries");
assert(capturedRun?.retries.totalRetries === 4, "run metrics total retries are aggregated");
assert(capturedRun?.retries.totalDelayMs === 500, "run metrics total delay is aggregated");
assert(capturedRun?.rateLimit.detailWaitMs === 250, "run metrics capture detail wait time");
assert(capturedRun?.rateLimit.detailMaxWaitMs === 250, "run metrics capture detail max wait");
assert(health1.statuses[0] === "healthy", "successful retried run remains healthy");

const health2 = createHealthCapture();
await runOnce({
  config,
  createLogger: () => silentLogger,
  healthStore: health2.store,
  appendRunMetrics: async () => false,
  crawlSearchResults: async () => ({
    listings: [],
    pagesVisited: 1,
    totalUniqueListings: 0,
    duplicatesRemoved: 0,
    stoppedReason: "no-results",
  }),
});
assert(health2.statuses[0] === "degraded", "metrics persistence failure degrades health");

console.log(
  "\nRun observability tests: " +
    String(passed) +
    " passed, " +
    String(failed) +
    " failed",
);
if (failed > 0) process.exit(1);
