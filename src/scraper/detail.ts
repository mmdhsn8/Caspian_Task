import type { Browser, BrowserContext, Page } from "playwright";
import { createBrowserSession } from "./browser.js";
import { env } from "../config/env.js";
import { detailSelectors } from "./selectors.js";
import { parseListingDetail } from "../parser/detail.js";
import type { ListingSummary } from "../parser/listing.js";
import type { ListingDetail } from "../models/listing.js";
import { sleep } from "../utils/helpers.js";
import { executeWithRetry, isRetryableNetworkError } from "../resilience/retry-policy.js";
import { AsyncRateLimiter } from "../resilience/rate-limiter.js";
import { DetailCache } from "../cache/detail-cache.js";

async function waitForStableDetail(page: Page): Promise<boolean> {
  for (const selector of detailSelectors.listingId) {
    try {
      await page.waitForSelector(selector, {
        timeout: env.scraperTimeoutMs,
        state: "attached",
      });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function scrollForFinancialSection(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const hasSection: boolean = await page.evaluate((sel: string) => {
      return document.querySelector(sel) !== null;
    }, detailSelectors.financialSection[0]);
    if (hasSection) return;
    await page.evaluate(() => {
      window.scrollBy(0, 600);
    });
    await page.waitForTimeout(300);
  }
}

// ── Worker item type ────────────────────────────────────────────────────────

interface WorkerItem {
  index: number;
  summary: ListingSummary;
}

interface WorkerResult {
  index: number;
  detail: ListingDetail | null;
  error: string | null;
}

export interface DetailScrapeStats {
  attempted: number;
  succeeded: number;
  failed: number;
  cacheHits: number;
  cacheMisses: number;
  liveRequests: number;
  retries: number;
  retryDelayMs: number;
  rateLimitWaitMs: number;
  rateLimitWaitCount: number;
  rateLimitMaxWaitMs: number;
  cacheWrites: number;
  cacheEvictions: number;
  cacheExpired: number;
  cacheEntries: number;
  cacheWriteFailed: boolean;
}

export interface DetailScrapeResult {
  details: ListingDetail[];
  stats: DetailScrapeStats;
  failures: { listingId: string; url: string; error: string }[];
}

export interface DetailScrapeOptions {
  cache?: DetailCache;
  rateLimiter?: AsyncRateLimiter;
  onRetry?: (delayMs: number) => void;
}

// ── Worker function ─────────────────────────────────────────────────────────

async function detailWorker(
  items: WorkerItem[],
  browser: Browser,
  context: BrowserContext,
  options: DetailScrapeOptions,
  stats: DetailScrapeStats,
): Promise<WorkerResult[]> {
  const results: WorkerResult[] = [];
  const page = await context.newPage();
  page.setDefaultTimeout(env.scraperTimeoutMs);
  page.setDefaultNavigationTimeout(env.scraperTimeoutMs);

  try {
    for (const item of items) {
      try {
        const result = await executeWithRetry(
          async () => {
            stats.liveRequests++;
            if (options.rateLimiter) {
              const waitResult = await options.rateLimiter.acquire();
              stats.rateLimitWaitMs += waitResult.waitedMs;
              if (waitResult.waitedMs > 0) stats.rateLimitWaitCount++;
              stats.rateLimitMaxWaitMs = Math.max(
                stats.rateLimitMaxWaitMs,
                waitResult.waitedMs,
              );
            }
            await page.goto(item.summary.url, {
              waitUntil: "domcontentloaded",
              timeout: env.scraperTimeoutMs,
            });

            const stable = await waitForStableDetail(page);
            if (!stable) throw new Error("Timed out waiting for detail page selectors");
            await page.waitForTimeout(800);
            await scrollForFinancialSection(page);
            await page.waitForTimeout(500);
            const html = await page.content();
            return parseListingDetail(html, item.summary.url, item.summary);
          },
          {
            maxAttempts: env.detailRetryMaxAttempts,
            baseDelayMs: env.retryBaseDelayMs,
            maxDelayMs: env.retryMaxDelayMs,
            jitterRatio: env.retryJitterRatio,
          },
          {
            operation: "detail navigation",
            shouldRetry: (error) => isRetryableNetworkError(error),
            onRetry: ({ delayMs }) => {
              stats.retries++;
              stats.retryDelayMs += delayMs;
              options.onRetry?.(delayMs);
            },
          },
        );
        const detail = result.value;
        results.push({ index: item.index, detail, error: null });

        if (env.requestDelayMs > 0) {
          await sleep(env.requestDelayMs);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ index: item.index, detail: null, error: msg });

        if (env.requestDelayMs > 0) {
          await sleep(env.requestDelayMs);
        }
      }
    }
  } finally {
    await page.close();
  }

  return results;
}

// ── Main detail scrape function ─────────────────────────────────────────────

export async function scrapeDetailPages(
  listings: readonly ListingSummary[],
): Promise<ListingDetail[]> {
  return (await scrapeDetailPagesWithStats(listings)).details;
}

export async function scrapeDetailPagesWithStats(
  listings: readonly ListingSummary[],
  options: DetailScrapeOptions = {},
): Promise<DetailScrapeResult> {
  if (listings.length === 0) {
    return {
      details: [],
      stats: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        cacheHits: 0,
        cacheMisses: 0,
        liveRequests: 0,
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
  }

  const cache =
    options.cache ??
    new DetailCache({
      enabled: env.detailCacheEnabled,
      path: env.detailCachePath,
      ttlMs: env.detailCacheTtlHours * 60 * 60 * 1000,
      maxEntries: env.detailCacheMaxEntries,
      schemaVersion: env.detailCacheSchemaVersion,
    });
  await cache.load();
  const stats: DetailScrapeStats = {
    attempted: listings.length,
    succeeded: 0,
    failed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    liveRequests: 0,
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
  };
  const flatResults = new Array<WorkerResult | null>(listings.length).fill(null);
  const liveItems: WorkerItem[] = [];
  for (let index = 0; index < listings.length; index++) {
    const summary = listings[index];
    const cached = await cache.get(summary);
    if (cached) {
      flatResults[index] = { index, detail: cached, error: null };
      stats.cacheHits++;
    } else {
      stats.cacheMisses++;
      liveItems.push({ index, summary });
    }
  }

  if (liveItems.length === 0) {
    stats.succeeded = listings.length;
    const cacheStats = cache.getStats();
    stats.cacheWrites = cacheStats.writes;
    stats.cacheEvictions = cacheStats.evictions;
    stats.cacheExpired = cacheStats.expired;
    stats.cacheEntries = cacheStats.entries;
    stats.cacheWriteFailed = cacheStats.writeFailed === true;
    return {
      details: flatResults
        .map((result) => result?.detail)
        .filter(
          (detail): detail is ListingDetail => detail !== null && detail !== undefined,
        ),
      stats,
      failures: [],
    };
  }

  const session = await createBrowserSession();
  const { browser, context } = session;

  const concurrency = Math.min(env.detailConcurrency, liveItems.length);
  const items = liveItems;

  const chunks: WorkerItem[][] = [];
  for (let i = 0; i < concurrency; i++) {
    chunks.push([]);
  }
  for (let i = 0; i < items.length; i++) {
    chunks[i % concurrency].push(items[i]);
  }

  const totalCount = items.length;
  let filledCount = 0;

  try {
    const rateLimiter =
      options.rateLimiter ??
      new AsyncRateLimiter({
        enabled: env.rateLimitEnabled,
        requestsPerMinute: env.detailRequestsPerMinute,
        burst: env.rateLimitBurst,
      });
    const workerPromises = chunks.map((chunk) =>
      detailWorker(chunk, browser, context, { ...options, rateLimiter }, stats),
    );

    const chunkResults = await Promise.all(workerPromises);

    for (const chunkResult of chunkResults) {
      for (const wr of chunkResult) {
        flatResults[wr.index] = wr;
        filledCount++;
        if (wr.detail !== null) {
          console.log(
            "Detail complete: " +
              wr.detail.listingId +
              " (" +
              String(filledCount) +
              "/" +
              String(totalCount) +
              ")",
          );
        } else {
          console.warn(
            "Detail failed: " +
              listings[wr.index].listingId +
              " — " +
              (wr.error ?? "unknown"),
          );
        }
      }
    }
  } finally {
    await session.close();
  }

  const successfulDetails: ListingDetail[] = [];
  const failures: { listingId: string; url: string; error: string }[] = [];
  for (let index = 0; index < flatResults.length; index++) {
    const r = flatResults[index];
    if (!r) continue;
    const d = r.detail;
    if (d !== null) {
      successfulDetails.push(d);
      if (!listings[index] || !liveItems.some((item) => item.index === index)) continue;
      cache.set(listings[index], d);
    } else {
      failures.push({
        listingId: listings[index].listingId,
        url: listings[index].url,
        error: r.error ?? "unknown",
      });
    }
  }

  await cache.flush();
  const cacheStats = cache.getStats();
  stats.cacheWrites = cacheStats.writes;
  stats.cacheEvictions = cacheStats.evictions;
  stats.cacheExpired = cacheStats.expired;
  stats.cacheEntries = cacheStats.entries;
  stats.cacheWriteFailed = cacheStats.writeFailed === true;
  stats.succeeded = successfulDetails.length;
  stats.failed = failures.length;
  const failureCount = failures.length;

  if (successfulDetails.length === 0 && totalCount > 0) {
    const messages = failures.map(
      (failure) => "  " + failure.listingId + ": " + failure.error,
    );
    throw new Error(
      "All " + String(totalCount) + " detail pages failed:\n" + messages.join("\n"),
    );
  }

  if (failureCount > 0) {
    console.warn(
      "Details: " +
        String(successfulDetails.length) +
        " success, " +
        String(failureCount) +
        " failed",
    );
  }

  return { details: successfulDetails, stats, failures };
}
