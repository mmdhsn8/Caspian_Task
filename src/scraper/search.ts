import type { Page } from "playwright";
import { createBrowserSession } from "./browser.js";
import { env } from "../config/env.js";
import { searchSelectors, paginationSelectors } from "./selectors.js";
import { parseSearchResults, type ListingSummary } from "../parser/listing.js";
import { buildSearchPageUrl, sleep } from "../utils/helpers.js";
import { AsyncRateLimiter } from "../resilience/rate-limiter.js";
import { executeWithRetry, isRetryableNetworkError } from "../resilience/retry-policy.js";

export interface SearchFilters {
  readonly priceMin?: number;
  readonly priceMax?: number;
  readonly propertyType?: string;
  readonly city?: string;
}

export interface SearchCrawlResult {
  listings: ListingSummary[];
  pagesVisited: number;
  totalUniqueListings: number;
  duplicatesRemoved?: number;
  stoppedReason:
    | "completed"
    | "no-next-page"
    | "no-new-listings"
    | "max-pages"
    | "max-listings"
    | "no-results";
}

export interface SearchCrawlOptions {
  rateLimiter?: AsyncRateLimiter;
  onRetry?: (delayMs: number) => void;
  onRateLimitWait?: (waitedMs: number) => void;
}

// ── Backward-compatible wrapper ─────────────────────────────────────────────

export async function scrapeSearchPage(
  _filters?: SearchFilters,
): Promise<ListingSummary[]> {
  const result = await crawlSearchResults();
  return result.listings;
}

// ── Full search crawl ───────────────────────────────────────────────────────

export async function crawlSearchResults(
  options: SearchCrawlOptions = {},
): Promise<SearchCrawlResult> {
  const session = await createBrowserSession();
  const { page } = session;

  try {
    const baseUrl = env.centrisSearchUrl;
    const maxPages = env.maxSearchPages;
    const maxListings = env.searchMaxListings;
    const pageSize = env.searchPageSize;
    const navDelay = env.pageNavigationDelayMs;

    const globalMap = new Map<string, ListingSummary>();
    const rateLimiter =
      options.rateLimiter ??
      new AsyncRateLimiter({
        enabled: env.rateLimitEnabled,
        requestsPerMinute: env.searchRequestsPerMinute,
        burst: env.rateLimitBurst,
      });
    let pagesVisited = 0;
    let duplicatesRemoved = 0;
    let stoppedReason: SearchCrawlResult["stoppedReason"] = "completed";

    const firstPageUrl = buildSearchPageUrl(baseUrl, 1, pageSize);

    await navigateSearchPage(page, firstPageUrl, rateLimiter, options);

    let listingFound = false;
    for (const selector of searchSelectors.listingCard) {
      try {
        await page.waitForSelector(selector, {
          timeout: env.scraperTimeoutMs,
        });
        listingFound = true;
        break;
      } catch {
        continue;
      }
    }

    if (!listingFound) {
      throw new Error(
        "No listing elements appeared on the search page. " +
          "The page structure may have changed or the search URL may be invalid.",
      );
    }

    const totalPages = await discoverTotalPages(page);

    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      if (totalPages !== null && currentPage > totalPages) {
        stoppedReason = "completed";
        break;
      }

      if (currentPage > 1) {
        const pageUrl = buildSearchPageUrl(baseUrl, currentPage, pageSize);
        await navigateSearchPage(page, pageUrl, rateLimiter, options);

        let found = false;
        for (const selector of searchSelectors.listingCard) {
          try {
            await page.waitForSelector(selector, {
              timeout: env.scraperTimeoutMs,
            });
            found = true;
            break;
          } catch {
            continue;
          }
        }

        if (!found) {
          if (currentPage === 1) {
            throw new Error("No listing elements on page " + String(currentPage));
          }
          stoppedReason = "no-results";
          break;
        }
      }

      if (navDelay > 0) {
        await sleep(navDelay);
      }

      const html = await page.content();
      const pageListings = parseSearchResults(html);
      const beforeCount = globalMap.size;

      for (const listing of pageListings) {
        const existing2 = globalMap.get(listing.listingId);
        if (existing2 !== undefined) {
          mergeMissing(existing2, listing);
        } else {
          globalMap.set(listing.listingId, listing);
        }
      }

      const newOnPage = globalMap.size - beforeCount;
      duplicatesRemoved += Math.max(0, pageListings.length - newOnPage);
      console.log(
        "Search page " +
          String(currentPage) +
          (totalPages !== null ? "/" + String(totalPages) : "") +
          "\nFound " +
          String(pageListings.length) +
          " cards, " +
          String(newOnPage) +
          " new (" +
          String(globalMap.size) +
          " unique)",
      );

      pagesVisited = currentPage;

      if (globalMap.size >= maxListings) {
        stoppedReason = "max-listings";
        break;
      }

      if (newOnPage === 0 && currentPage > 1) {
        stoppedReason = "no-new-listings";
        break;
      }

      if (currentPage < maxPages) {
        const hasNext = await hasNextPage(page, currentPage, totalPages);
        if (!hasNext) {
          if (totalPages === null || currentPage < totalPages) {
            stoppedReason = "no-next-page";
          }
          break;
        }
      }
    }

    const listings = Array.from(globalMap.values());
    const totalUniqueListings = listings.length;

    console.log(
      "Search crawl complete: " +
        String(totalUniqueListings) +
        " unique listings (" +
        String(pagesVisited) +
        " pages, reason: " +
        stoppedReason +
        ")",
    );

    return {
      listings,
      pagesVisited,
      totalUniqueListings,
      duplicatesRemoved,
      stoppedReason,
    };
  } finally {
    await session.close();
  }
}

async function navigateSearchPage(
  page: Page,
  url: string,
  rateLimiter: AsyncRateLimiter,
  options: SearchCrawlOptions,
): Promise<void> {
  await executeWithRetry(
    async () => {
      const waitResult = await rateLimiter.acquire();
      options.onRateLimitWait?.(waitResult.waitedMs);
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },
    {
      maxAttempts: env.searchRetryMaxAttempts,
      baseDelayMs: env.retryBaseDelayMs,
      maxDelayMs: env.retryMaxDelayMs,
      jitterRatio: env.retryJitterRatio,
    },
    {
      operation: "search navigation",
      shouldRetry: (error) => isRetryableNetworkError(error),
      onRetry: ({ delayMs }) => options.onRetry?.(delayMs),
    },
  );
}

// ── Pagination discovery ────────────────────────────────────────────────────

async function discoverTotalPages(page: Page): Promise<number | null> {
  const strategies = [
    async (): Promise<number | null> => {
      for (const sel of paginationSelectors.totalPages) {
        try {
          const element = await page.$(sel);
          const text = element ? await element.textContent() : null;
          if (text) {
            const n = parseInt(text.trim(), 10);
            if (!Number.isNaN(n) && n > 0) return n;
          }
        } catch {
          continue;
        }
      }
      return null;
    },
    async (): Promise<number | null> => {
      try {
        const html = await page.content();
        const re = /"totalPages":\s*(\d+)/;
        const match = re.exec(html);
        if (match) {
          const n = parseInt(match[1], 10);
          if (!Number.isNaN(n) && n > 0) return n;
        }
      } catch {
        return null;
      }
      return null;
    },
    async (): Promise<number | null> => {
      try {
        const html = await page.content();
        const re2 = /"totalCount":\s*(\d+)/;
        const match = re2.exec(html);
        if (match) {
          const total = parseInt(match[1], 10);
          if (!Number.isNaN(total) && total > 0) {
            return Math.ceil(total / env.searchPageSize);
          }
        }
      } catch {
        return null;
      }
      return null;
    },
    async (): Promise<number | null> => {
      try {
        const pageNumbers: number[] = [];
        for (const sel of paginationSelectors.pageNumber) {
          const elements = await page.$$(sel);
          for (const el of elements) {
            const text = await el.textContent();
            if (text) {
              const n = parseInt(text.trim(), 10);
              if (!Number.isNaN(n)) pageNumbers.push(n);
            }
          }
          if (pageNumbers.length > 0) break;
        }
        if (pageNumbers.length > 0) {
          return Math.max(...pageNumbers);
        }
      } catch {
        return null;
      }
      return null;
    },
  ];

  for (const strategy of strategies) {
    const result = await strategy();
    if (result !== null) return result;
  }

  return null;
}

async function hasNextPage(
  page: Page,
  currentPage: number,
  totalPages: number | null,
): Promise<boolean> {
  if (totalPages !== null) {
    return currentPage < totalPages;
  }

  for (const sel of paginationSelectors.disabledNext) {
    try {
      const el = await page.$(sel);
      if (el) return false;
    } catch {
      continue;
    }
  }

  for (const sel of paginationSelectors.nextPage) {
    try {
      const el = await page.$(sel);
      if (el) return true;
    } catch {
      continue;
    }
  }

  return false;
}

// ── Merge helper ────────────────────────────────────────────────────────────

function mergeMissing(target: ListingSummary, source: ListingSummary): void {
  if (target.url === "" && source.url !== "") target.url = source.url;
  if (target.price == null && source.price != null) {
    target.price = source.price;
    target.priceRaw = source.priceRaw;
  }
  if (target.address == null && source.address != null) target.address = source.address;
  if (target.propertyType == null && source.propertyType != null)
    target.propertyType = source.propertyType;
  if (target.bedrooms == null && source.bedrooms != null)
    target.bedrooms = source.bedrooms;
  if (target.bathrooms == null && source.bathrooms != null)
    target.bathrooms = source.bathrooms;
}
