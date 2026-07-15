export interface StageTiming {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface RetryMetrics {
  totalRetries: number;
  searchRetries: number;
  detailRetries: number;
  sheetRetries: number;
  // Telegram message send retries only. Apps Script acknowledgements are excluded.
  telegramRetries: number;
  totalDelayMs: number;
  searchDelayMs: number;
  detailDelayMs: number;
  sheetDelayMs: number;
  telegramDelayMs: number;
  sheetAttempts?: number;
  telegramRetriedListings?: number;
  telegramMaxAttempts?: number;
}

export interface RateLimitMetrics {
  searchWaitMs: number;
  detailWaitMs: number;
  searchWaitCount: number;
  detailWaitCount: number;
  searchMaxWaitMs: number;
  detailMaxWaitMs: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  expired: number;
  writes: number;
  evictions: number;
  hitRate: number;
  entries?: number;
  writeFailed?: boolean;
}

export interface RunMetrics {
  runId: string;
  trigger: "manual" | "scheduler";
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stage: string | null;
  errorMessage: string | null;
  search: {
    pagesVisited: number;
    summariesFound: number;
    duplicatesRemoved: number;
    stoppedReason: string;
    timing: StageTiming | null;
  };
  details: {
    attempted: number;
    succeeded: number;
    failed: number;
    cacheHits: number;
    liveRequests: number;
    timing: StageTiming | null;
  };
  sheet: {
    newCount: number;
    updatedCount: number;
    unchangedCount: number;
    totalStored: number;
    timing: StageTiming | null;
  };
  telegram: {
    requested: number;
    sent: number;
    failed: number;
    skipped: number;
    timing: StageTiming | null;
  };
  retries: RetryMetrics;
  rateLimit: RateLimitMetrics;
  cache: CacheMetrics;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
}

export interface MetricsDocument {
  schemaVersion: number;
  updatedAt: string;
  totals: {
    runs: number;
    successes: number;
    failures: number;
    successRate: number;
    totalListingsDiscovered: number;
    totalDetailsScraped: number;
    totalTelegramSent: number;
    totalRetries: number;
  };
  averages: {
    runDurationMs: number;
    searchDurationMs: number;
    detailDurationMs: number;
    sheetDurationMs: number;
    telegramDurationMs: number;
    cacheHitRate: number;
  };
  recentRuns: RunMetrics[];
}
