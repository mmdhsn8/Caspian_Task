import { env } from "../config/env.js";
import type { ListingDetail } from "../models/listing.js";
import { crawlSearchResults } from "../scraper/search.js";
import {
  scrapeDetailPages,
  scrapeDetailPagesWithStats,
  type DetailScrapeResult,
} from "../scraper/detail.js";
import { AsyncRateLimiter } from "../resilience/rate-limiter.js";
import { DetailCache } from "../cache/detail-cache.js";
import { acknowledgeTelegramResults, syncDetailsToSheet } from "../services/sheets.js";
import { notifyNewListings } from "../services/telegram.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { appendRunMetrics } from "../metrics/metrics-store.js";
import type { RunMetrics, StageTiming } from "../metrics/metrics-types.js";
import { HealthStore } from "../health/health-store.js";

export type RunStage = "startup" | "search" | "details" | "sheet-sync" | "telegram";

export interface RunSummary {
  readonly runId: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly listingsFound: number;
  readonly pagesVisited: number;
  readonly stoppedReason: string;
  readonly detailsAttempted: number;
  readonly detailsSucceeded: number;
  readonly detailsFailed: number;
  readonly newListings: number;
  readonly updatedListings: number;
  readonly unchangedListings: number;
  readonly totalStored: number;
  readonly telegramRequested: number;
  readonly telegramSent: number;
  readonly telegramFailed: number;
  readonly telegramSkipped: number;
  readonly stage: RunStage;
  readonly error: string | null;
  readonly detailsCacheHits: number;
  readonly detailsCacheMisses: number;
  readonly detailsLiveRequests: number;
  readonly retries: number;
  readonly rateLimitWaitMs: number;
  readonly rateLimitWaitCount: number;
  readonly newListingsData?: NewListingData[];
}

export interface NewListingData {
  readonly listingId: string;
  readonly price: number | null;
  readonly type: string | null;
  readonly address: string | null;
  readonly parking: string | null;
  readonly yearBuilt: number | null;
  readonly bedrooms: number | null;
  readonly bathrooms: number | null;
  readonly totalAssessment: number | null;
  readonly municipalTax: number | null;
  readonly schoolTax: number | null;
  readonly totalTaxes: number | null;
  readonly brokerName: string | null;
  readonly brokerPhone: string | null;
  readonly agencyName: string | null;
  readonly propertyUrl: string;
}

type RunConfig = Pick<
  typeof env,
  | "runIdPrefix"
  | "headless"
  | "scraperTimeoutMs"
  | "telegramEnabled"
  | "telegramChatId"
  | "telegramBotToken"
  | "googleAppsScriptUrl"
  | "telegramParseMode"
  | "telegramMaxRetries"
  | "failureInjectionEnabled"
  | "failureTestStage"
>;

type RuntimeConfig = Partial<
  Pick<
    typeof env,
    | "metricsEnabled"
    | "metricsPath"
    | "metricsHistoryLimit"
    | "healthReportEnabled"
    | "healthReportPath"
    | "detailCacheEnabled"
    | "detailCachePath"
    | "detailCacheTtlHours"
    | "detailCacheMaxEntries"
    | "detailCacheSchemaVersion"
    | "rateLimitEnabled"
    | "searchRequestsPerMinute"
    | "detailRequestsPerMinute"
    | "rateLimitBurst"
  >
>;

export interface RunOnceDependencies {
  readonly config?: RunConfig;
  readonly notificationMode?: "direct" | "external";
  readonly trigger?: "manual" | "scheduler";
  readonly healthStore?: Pick<HealthStore, "setActive" | "setStage" | "completeRun">;
  readonly appendRunMetrics?: (run: RunMetrics) => Promise<boolean>;
  readonly performanceNow?: () => number;
  readonly now?: () => Date;
  readonly crawlSearchResults?: typeof crawlSearchResults;
  readonly scrapeDetailPages?: typeof scrapeDetailPages;
  readonly scrapeDetailPagesWithStats?: typeof scrapeDetailPagesWithStats;
  readonly syncDetailsToSheet?: typeof syncDetailsToSheet;
  readonly acknowledgeTelegramResults?: typeof acknowledgeTelegramResults;
  readonly notifyNewListings?: typeof notifyNewListings;
  readonly createLogger?: (name: string, runId: string) => Logger;
}

function generateRunId(config: RunConfig, now: Date): string {
  const pad4 = (n: number): string => String(n).padStart(4, "0");
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const timestamp =
    pad4(now.getFullYear()) +
    pad2(now.getMonth() + 1) +
    pad2(now.getDate()) +
    "T" +
    pad2(now.getHours()) +
    pad2(now.getMinutes()) +
    pad2(now.getSeconds());
  return config.runIdPrefix + "-" + timestamp;
}

export async function runOnce(
  dependencies: RunOnceDependencies = {},
): Promise<RunSummary> {
  const config = dependencies.config ?? env;
  const runtimeConfig = config as RunConfig & RuntimeConfig;
  const now = dependencies.now ?? (() => new Date());
  const monotonicNow = dependencies.performanceNow ?? (() => performance.now());
  const crawl = dependencies.crawlSearchResults ?? crawlSearchResults;
  const scrape = dependencies.scrapeDetailPages ?? scrapeDetailPages;
  const sync = dependencies.syncDetailsToSheet ?? syncDetailsToSheet;
  const acknowledge =
    dependencies.acknowledgeTelegramResults ?? acknowledgeTelegramResults;
  const notify = dependencies.notifyNewListings ?? notifyNewListings;
  const trigger = dependencies.trigger ?? "manual";
  const notificationMode = dependencies.notificationMode ?? "direct";
  const runId = generateRunId(config, now());
  const log = (dependencies.createLogger ?? createLogger)("centris-scraper", runId);
  const startPerf = monotonicNow();
  const health =
    dependencies.healthStore ??
    new HealthStore({
      path: runtimeConfig.healthReportPath ?? env.healthReportPath,
      enabled: runtimeConfig.healthReportEnabled ?? env.healthReportEnabled,
    });
  const persistRunMetrics = dependencies.appendRunMetrics ?? appendRunMetrics;
  const startedAt = now().toISOString();
  await health.setActive(runId, trigger, startedAt, "startup");
  const stageTimings: Partial<Record<RunStage, StageTiming>> = {};
  const stageStart = new Map<RunStage, { iso: string; perf: number }>();
  const beginStage = async (name: RunStage): Promise<void> => {
    stageStart.set(name, { iso: now().toISOString(), perf: monotonicNow() });
    await health.setStage(name);
  };
  const endStage = (name: RunStage): void => {
    const started = stageStart.get(name);
    if (!started) return;
    const finishedAt = now().toISOString();
    stageTimings[name] = {
      startedAt: started.iso,
      finishedAt,
      durationMs: monotonicNow() - started.perf,
    };
  };

  log.info(
    "headless=" +
      String(config.headless) +
      " timeout=" +
      String(config.scraperTimeoutMs) +
      " proxy=" +
      (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "none"),
  );

  let details: ListingDetail[] = [];
  let listingsFound = 0;
  let pagesVisited = 0;
  let duplicatesRemoved = 0;
  let stoppedReason = "unknown";
  let detailsAttempted = 0;
  let newListings = 0;
  let updatedListings = 0;
  let unchangedListings = 0;
  let totalStored = 0;
  let telegramRequested = 0;
  let telegramSent = 0;
  let telegramFailed = 0;
  let telegramSkipped = 0;
  let detailsCacheHits = 0;
  let detailsCacheMisses = 0;
  let detailsLiveRequests = 0;
  let searchRetries = 0;
  let detailRetries = 0;
  let sheetRetries = 0;
  let telegramRetries = 0;
  let searchDelayMs = 0;
  let detailDelayMs = 0;
  let sheetDelayMs = 0;
  let telegramDelayMs = 0;
  let sheetAttempts = 0;
  let telegramRetriedListings = 0;
  let telegramMaxAttempts = 0;
  let searchWaitMs = 0;
  let detailWaitMs = 0;
  let searchWaitCount = 0;
  let detailWaitCount = 0;
  let searchMaxWaitMs = 0;
  let detailMaxWaitMs = 0;
  let detailCacheWrites = 0;
  let detailCacheEvictions = 0;
  let detailCacheExpired = 0;
  let detailCacheEntries = 0;
  let detailCacheWriteFailed = false;
  let newListingsData: NewListingData[] | undefined;
  let detailFailures: { listingId: string; url: string; error: string }[] = [];
  const cache = new DetailCache({
    enabled: runtimeConfig.detailCacheEnabled ?? env.detailCacheEnabled,
    path: runtimeConfig.detailCachePath ?? env.detailCachePath,
    ttlMs:
      (runtimeConfig.detailCacheTtlHours ?? env.detailCacheTtlHours) * 60 * 60 * 1000,
    maxEntries: runtimeConfig.detailCacheMaxEntries ?? env.detailCacheMaxEntries,
    schemaVersion: runtimeConfig.detailCacheSchemaVersion ?? env.detailCacheSchemaVersion,
  });
  const searchRateLimiter = new AsyncRateLimiter({
    enabled: runtimeConfig.rateLimitEnabled ?? env.rateLimitEnabled,
    requestsPerMinute:
      runtimeConfig.searchRequestsPerMinute ?? env.searchRequestsPerMinute,
    burst: runtimeConfig.rateLimitBurst ?? env.rateLimitBurst,
  });
  const detailRateLimiter = new AsyncRateLimiter({
    enabled: runtimeConfig.rateLimitEnabled ?? env.rateLimitEnabled,
    requestsPerMinute:
      runtimeConfig.detailRequestsPerMinute ?? env.detailRequestsPerMinute,
    burst: runtimeConfig.rateLimitBurst ?? env.rateLimitBurst,
  });
  let stage: RunStage = "startup";
  let error: string | null = null;

  try {
    stage = "search";
    await beginStage("search");
    if (config.failureInjectionEnabled && config.failureTestStage === "search") {
      throw new Error("Diagnostic failure injection at search stage");
    }
    const searchResult = await crawl({
      rateLimiter: searchRateLimiter,
      onRetry: (delayMs) => {
        searchRetries++;
        searchDelayMs += delayMs;
        log.info("Retrying search navigation in " + String(delayMs) + "ms");
      },
      onRateLimitWait: (waitedMs) => {
        searchWaitMs += waitedMs;
        if (waitedMs > 0) searchWaitCount++;
        searchMaxWaitMs = Math.max(searchMaxWaitMs, waitedMs);
      },
    });
    endStage("search");
    listingsFound = searchResult.totalUniqueListings;
    pagesVisited = searchResult.pagesVisited;
    duplicatesRemoved = searchResult.duplicatesRemoved ?? 0;
    stoppedReason = searchResult.stoppedReason;
    log.info(
      "Search complete: " +
        String(searchResult.totalUniqueListings) +
        " unique, " +
        String(searchResult.pagesVisited) +
        " pages, reason=" +
        searchResult.stoppedReason,
    );

    if (searchResult.listings.length > 0) {
      stage = "details";
      await beginStage("details");
      detailsAttempted = searchResult.listings.length;
      let detailResult: DetailScrapeResult;
      if (dependencies.scrapeDetailPagesWithStats) {
        detailResult = await dependencies.scrapeDetailPagesWithStats(
          searchResult.listings,
        );
      } else if (dependencies.scrapeDetailPages) {
        details = await scrape(searchResult.listings);
        detailResult = {
          details,
          stats: {
            attempted: searchResult.listings.length,
            succeeded: details.length,
            failed: searchResult.listings.length - details.length,
            cacheHits: 0,
            cacheMisses: searchResult.listings.length,
            liveRequests: searchResult.listings.length,
            retries: 0,
            retryDelayMs: 0,
            rateLimitWaitMs: 0,
            rateLimitWaitCount: 0,
            rateLimitMaxWaitMs: 0,
            cacheWrites: 0,
            cacheEvictions: 0,
            cacheExpired: 0,
            cacheEntries: 0,
            cacheWriteFailed: false,
          },
          failures: [],
        };
      } else {
        detailResult = await scrapeDetailPagesWithStats(searchResult.listings, {
          cache,
          rateLimiter: detailRateLimiter,
          onRetry: (delayMs) => {
            log.info("Retrying detail navigation in " + String(delayMs) + "ms");
          },
        });
      }
      details = detailResult.details;
      detailsCacheHits = detailResult.stats.cacheHits;
      detailsCacheMisses = detailResult.stats.cacheMisses;
      detailsLiveRequests = detailResult.stats.liveRequests;
      detailRetries = detailResult.stats.retries;
      detailDelayMs = detailResult.stats.retryDelayMs;
      detailCacheWrites = detailResult.stats.cacheWrites;
      detailCacheEvictions = detailResult.stats.cacheEvictions;
      detailCacheExpired = detailResult.stats.cacheExpired;
      detailCacheEntries = detailResult.stats.cacheEntries;
      detailCacheWriteFailed = detailResult.stats.cacheWriteFailed;
      detailWaitMs = detailResult.stats.rateLimitWaitMs;
      detailWaitCount = detailResult.stats.rateLimitWaitCount;
      detailMaxWaitMs = detailResult.stats.rateLimitMaxWaitMs;
      detailFailures = detailResult.failures;
      endStage("details");
      log.info(
        "Cache: " +
          String(detailsCacheHits) +
          " hits, " +
          String(detailsCacheMisses) +
          " misses",
      );
      log.info(
        "Details complete: " +
          String(details.length) +
          "/" +
          String(searchResult.listings.length) +
          " succeeded",
      );

      if (details.length > 0) {
        const sample = details[0];
        const sampleParts: string[] = ["Sample: id=" + sample.listingId];
        if (sample.propertyType) sampleParts.push(sample.propertyType);
        if (sample.bedrooms != null) sampleParts.push(String(sample.bedrooms) + "bd");
        if (sample.bathrooms != null) sampleParts.push(String(sample.bathrooms) + "ba");
        if (sample.livingArea != null)
          sampleParts.push(String(sample.livingArea) + "sqft");
        if (sample.yearBuilt != null)
          sampleParts.push("year=" + String(sample.yearBuilt));
        if (sample.parking) sampleParts.push('park="' + sample.parking + '"');
        if (sample.brokerName) sampleParts.push('broker="' + sample.brokerName + '"');
        log.info(sampleParts.join(" "));

        if (config.googleAppsScriptUrl) {
          stage = "sheet-sync";
          await beginStage("sheet-sync");
          if (
            config.failureInjectionEnabled &&
            config.failureTestStage === "sheet-sync"
          ) {
            throw new Error("Diagnostic failure injection at sheet-sync stage");
          }
          const syncResult = await sync(details, {
            onRetry: ({ delayMs }) => {
              sheetRetries++;
              sheetDelayMs += delayMs;
              log.info(
                "Retrying Google Apps Script request in " + String(delayMs) + "ms",
              );
            },
            onComplete: ({ attempts }) => {
              sheetAttempts = attempts;
            },
          });
          endStage("sheet-sync");
          newListings = syncResult.newCount;
          updatedListings = syncResult.updatedCount;
          unchangedListings = syncResult.unchangedCount;
          totalStored = syncResult.totalStored;

          const newCountOk = syncResult.newCount === syncResult.newListingIds.length;
          const updatedCountOk =
            syncResult.updatedCount === syncResult.updatedListingIds.length;
          const totalOk =
            syncResult.newCount + syncResult.updatedCount + syncResult.unchangedCount ===
            syncResult.received;
          if (!newCountOk) {
            log.warn(
              "Sheet consistency: newCount(" +
                String(syncResult.newCount) +
                ") !== newListingIds.length(" +
                String(syncResult.newListingIds.length) +
                ")",
            );
          }
          if (!updatedCountOk) {
            log.warn(
              "Sheet consistency: updatedCount(" +
                String(syncResult.updatedCount) +
                ") !== updatedListingIds.length(" +
                String(syncResult.updatedListingIds.length) +
                ")",
            );
          }
          if (!totalOk) {
            log.warn(
              "Sheet consistency: new(" +
                String(syncResult.newCount) +
                ") + updated(" +
                String(syncResult.updatedCount) +
                ") + unchanged(" +
                String(syncResult.unchangedCount) +
                ") !== received(" +
                String(syncResult.received) +
                ")",
            );
          }

          log.info(
            "Sync: " +
              String(syncResult.newCount) +
              " new, " +
              String(syncResult.updatedCount) +
              " updated, " +
              String(syncResult.unchangedCount) +
              " unchanged (" +
              String(syncResult.totalStored) +
              " total)",
          );

          if (notificationMode === "external") {
            log.info("External notification mode: Telegram delegated to n8n");
            if (syncResult.newListingIds.length > 0) {
              const newIds = new Set(syncResult.newListingIds);
              newListingsData = details
                .filter((d) => newIds.has(d.listingId))
                .map((d) => ({
                  listingId: d.listingId,
                  price: d.price,
                  type: d.propertyType,
                  address: d.address,
                  parking: d.parking,
                  yearBuilt: d.yearBuilt,
                  bedrooms: d.bedrooms,
                  bathrooms: d.bathrooms,
                  totalAssessment: d.totalAssessment,
                  municipalTax: d.municipalTax,
                  schoolTax: d.schoolTax,
                  totalTaxes:
                    d.municipalTax != null || d.schoolTax != null
                      ? (d.municipalTax ?? 0) + (d.schoolTax ?? 0)
                      : null,
                  brokerName: d.brokerName,
                  brokerPhone: d.brokerPhone,
                  agencyName: d.agencyName,
                  propertyUrl: d.url,
                }));
            }
          } else {
            stage = "telegram";
            await beginStage("telegram");
            if (!config.telegramEnabled) {
              log.info("Telegram listing notifications disabled.");
            }
            const notificationResult = await notify(
              details,
              syncResult.pendingTelegramListingIds,
              {
                onRetry: ({ listingId, delayMs }) => {
                  log.info(
                    "Retrying Telegram send for listing " +
                      listingId +
                      " in " +
                      String(delayMs) +
                      "ms",
                  );
                },
              },
            );
            telegramRequested = notificationResult.requested;
            telegramSent = notificationResult.sent;
            telegramFailed = notificationResult.failed;
            telegramSkipped = notificationResult.skipped;
            telegramRetries = notificationResult.retries;
            telegramDelayMs = notificationResult.retryDelayMs;
            telegramRetriedListings = notificationResult.retriedListings;
            telegramMaxAttempts = notificationResult.maxAttemptsUsed;
            endStage("telegram");

            if (
              notificationResult.requested > 0 ||
              notificationResult.failed > 0 ||
              notificationResult.skipped > 0
            ) {
              log.info(
                "Telegram: " +
                  String(notificationResult.requested) +
                  " requested, " +
                  String(notificationResult.sent) +
                  " sent, " +
                  String(notificationResult.failed) +
                  " failed, " +
                  String(notificationResult.skipped) +
                  " skipped",
              );
            }

            if (notificationResult.results.length > 0) {
              const sentAt = now().toISOString();
              await acknowledge(
                notificationResult.results.map((result) => ({
                  listingId: result.listingId,
                  success: result.success,
                  messageId: result.messageId,
                  attempts: result.attempts,
                  error: result.error,
                  sentAt: result.success ? sentAt : null,
                })),
              );
            }
          }
        } else {
          log.info("Skipping Google Sheets (GOOGLE_APPS_SCRIPT_URL not set).");
        }
      }
    } else {
      log.info("No listings found in search crawl.");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    log.error("Fatal error: " + error);
    log.debug("Stack", caught instanceof Error ? caught.stack : null);
  }

  const durationMs = monotonicNow() - startPerf;
  const totalRetries = searchRetries + detailRetries + sheetRetries + telegramRetries;
  const totalRetryDelayMs =
    searchDelayMs + detailDelayMs + sheetDelayMs + telegramDelayMs;
  if (sheetAttempts === 0 && stage === "sheet-sync") {
    sheetAttempts = sheetRetries + 1;
  }
  const summary: RunSummary = {
    runId,
    timestamp: now().toISOString(),
    durationMs,
    listingsFound,
    pagesVisited,
    stoppedReason,
    detailsAttempted,
    detailsSucceeded: details.length,
    detailsFailed: Math.max(0, detailsAttempted - details.length),
    newListings,
    updatedListings,
    unchangedListings,
    totalStored,
    telegramRequested,
    telegramSent,
    telegramFailed,
    telegramSkipped,
    stage,
    error,
    detailsCacheHits,
    detailsCacheMisses,
    detailsLiveRequests,
    retries: totalRetries,
    rateLimitWaitMs: searchWaitMs + detailWaitMs,
    rateLimitWaitCount: searchWaitCount + detailWaitCount,
    newListingsData,
  };

  log.info(
    "Retries: " +
      String(totalRetries) +
      " Rate limit wait: " +
      String(searchWaitMs + detailWaitMs) +
      "ms",
  );

  log.info(
    "Run complete: " +
      String(summary.durationMs) +
      "ms, " +
      String(summary.pagesVisited) +
      " pages, reason=" +
      stoppedReason,
  );

  const finishedAt = now().toISOString();
  const runMetrics: RunMetrics = {
    runId,
    trigger,
    success: error === null,
    startedAt,
    finishedAt,
    durationMs: monotonicNow() - startPerf,
    stage: error ? stage : null,
    errorMessage: error,
    search: {
      pagesVisited,
      summariesFound: listingsFound,
      duplicatesRemoved,
      stoppedReason,
      timing: stageTimings.search ?? null,
    },
    details: {
      attempted: detailsAttempted,
      succeeded: details.length,
      failed: detailFailures.length || Math.max(0, detailsAttempted - details.length),
      cacheHits: detailsCacheHits,
      liveRequests: detailsLiveRequests,
      timing: stageTimings.details ?? null,
    },
    sheet: {
      newCount: newListings,
      updatedCount: updatedListings,
      unchangedCount: unchangedListings,
      totalStored,
      timing: stageTimings["sheet-sync"] ?? null,
    },
    telegram: {
      requested: telegramRequested,
      sent: telegramSent,
      failed: telegramFailed,
      skipped: telegramSkipped,
      timing: stageTimings.telegram ?? null,
    },
    retries: {
      totalRetries,
      searchRetries,
      detailRetries,
      sheetRetries,
      telegramRetries,
      totalDelayMs: totalRetryDelayMs,
      searchDelayMs,
      detailDelayMs,
      sheetDelayMs,
      telegramDelayMs,
      sheetAttempts,
      telegramRetriedListings,
      telegramMaxAttempts,
    },
    rateLimit: {
      searchWaitMs,
      detailWaitMs,
      searchWaitCount,
      detailWaitCount,
      searchMaxWaitMs,
      detailMaxWaitMs,
    },
    cache: {
      hits: detailsCacheHits,
      misses: detailsCacheMisses,
      expired: detailCacheExpired,
      writes: detailCacheWrites,
      evictions: detailCacheEvictions,
      hitRate:
        detailsCacheHits + detailsCacheMisses === 0
          ? 0
          : detailsCacheHits / (detailsCacheHits + detailsCacheMisses),
      entries: detailCacheEntries,
      writeFailed: detailCacheWriteFailed,
    },
    process: {
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapTotalBytes: process.memoryUsage().heapTotal,
      externalBytes: process.memoryUsage().external,
    },
  };
  const metricsSaved = await persistRunMetrics(runMetrics);
  const healthStatus =
    error !== null
      ? "unhealthy"
      : details.length < detailsAttempted ||
          telegramFailed > 0 ||
          detailCacheWriteFailed ||
          !metricsSaved
        ? "degraded"
        : "healthy";
  await health.completeRun(runMetrics, healthStatus);
  log.info("Health: " + healthStatus);
  if (metricsSaved) {
    log.info("Metrics saved.");
  } else {
    log.warn("Metrics not saved.");
  }

  return summary;
}
