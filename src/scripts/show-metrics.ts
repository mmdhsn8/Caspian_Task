import { access } from "node:fs/promises";
import { env } from "../config/env.js";
import { loadMetrics } from "../metrics/metrics-store.js";

try {
  await access(env.metricsPath);
} catch {
  throw new Error("Metrics file does not exist: " + env.metricsPath);
}
const metrics = await loadMetrics();
const latest = metrics.recentRuns.at(-1);

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const lifetime = metrics.recentRuns.reduce(
  (acc, run) => {
    acc.runs++;
    if (run.success) acc.successes++;
    acc.totalRetries += run.retries.totalRetries;
    acc.searchRetries += run.retries.searchRetries;
    acc.detailRetries += run.retries.detailRetries;
    acc.sheetRetries += run.retries.sheetRetries;
    acc.telegramRetries += run.retries.telegramRetries;
    acc.totalDelayMs += numberOrZero(run.retries.totalDelayMs);
    acc.searchWaitMs += numberOrZero(run.rateLimit.searchWaitMs);
    acc.detailWaitMs += numberOrZero(run.rateLimit.detailWaitMs);
    acc.durationMs += run.durationMs;
    acc.cacheHitRate += run.cache.hitRate;
    return acc;
  },
  {
    runs: 0,
    successes: 0,
    totalRetries: 0,
    searchRetries: 0,
    detailRetries: 0,
    sheetRetries: 0,
    telegramRetries: 0,
    totalDelayMs: 0,
    searchWaitMs: 0,
    detailWaitMs: 0,
    durationMs: 0,
    cacheHitRate: 0,
  },
);
const failures = lifetime.runs - lifetime.successes;
const successRate = lifetime.runs === 0 ? 0 : (lifetime.successes / lifetime.runs) * 100;
const averageDuration = lifetime.runs === 0 ? 0 : lifetime.durationMs / lifetime.runs;
const averageCacheHitRate =
  lifetime.runs === 0 ? 0 : lifetime.cacheHitRate / lifetime.runs;

function latestHealth(): string {
  if (!latest) return "none";
  if (!latest.success || latest.errorMessage !== null) return "unhealthy";
  if (
    latest.details.failed > 0 ||
    latest.telegram.failed > 0 ||
    latest.cache.writeFailed
  ) {
    return "degraded";
  }
  return "healthy";
}

console.log("----------------------------------------");
console.log("Lifetime");
console.log("----------------------------------------");
console.log("Runs: " + String(lifetime.runs));
console.log("Successes: " + String(lifetime.successes));
console.log("Failures: " + String(failures));
console.log("Success rate: " + successRate.toFixed(1) + "%");
console.log("Total retries: " + String(lifetime.totalRetries));
console.log("Search retries: " + String(lifetime.searchRetries));
console.log("Detail retries: " + String(lifetime.detailRetries));
console.log("Sheet retries: " + String(lifetime.sheetRetries));
console.log("Telegram retries: " + String(lifetime.telegramRetries));
console.log("Total retry delay: " + String(lifetime.totalDelayMs) + "ms");
console.log("Search wait: " + String(lifetime.searchWaitMs) + "ms");
console.log("Detail wait: " + String(lifetime.detailWaitMs) + "ms");
console.log("Telegram ACK retries: not tracked");
console.log("----------------------------------------");
console.log("Latest Run");
console.log("----------------------------------------");
console.log("Search retries: " + String(numberOrZero(latest?.retries.searchRetries)));
console.log("Detail retries: " + String(numberOrZero(latest?.retries.detailRetries)));
console.log("Sheet retries: " + String(numberOrZero(latest?.retries.sheetRetries)));
console.log("Telegram retries: " + String(numberOrZero(latest?.retries.telegramRetries)));
console.log(
  "Search wait: " + String(numberOrZero(latest?.rateLimit.searchWaitMs)) + "ms",
);
console.log(
  "Detail wait: " + String(numberOrZero(latest?.rateLimit.detailWaitMs)) + "ms",
);
console.log("Average duration: " + (averageDuration / 1000).toFixed(1) + "s");
console.log("Average cache hit rate: " + (averageCacheHitRate * 100).toFixed(1) + "%");
console.log("Last run: " + latestHealth());
