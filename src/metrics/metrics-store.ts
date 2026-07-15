import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";
import type { MetricsDocument, RunMetrics, StageTiming } from "./metrics-types.js";

const SCHEMA_VERSION = 1;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function corruptPath(path: string): string {
  return path.endsWith(".json")
    ? path.slice(0, -".json".length) + ".corrupt." + String(Date.now()) + ".json"
    : path + ".corrupt." + String(Date.now()) + ".json";
}

interface LegacyMetricsSnapshot {
  counters: Record<string, number>;
  events: Record<string, unknown>[];
}

function sanitizeLegacy(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(token|bearer|password|secret)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
      .slice(0, 500);
  }
  return value;
}

function sanitizeText(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/authorization:\s+[^\s]+/gi, "authorization:[redacted]")
    .replace(/(token|bearer|password|secret)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)([^\s:/@]+):([^\s/@]+)@/gi, "$1[redacted]:[redacted]@")
    .slice(0, 500);
}

function sanitizeRunMetrics(run: RunMetrics): RunMetrics {
  return {
    ...run,
    errorMessage: sanitizeText(run.errorMessage),
  };
}

function emptyLegacySnapshot(): LegacyMetricsSnapshot {
  return { counters: {}, events: [] };
}

async function legacyWrite(path: string, value: LegacyMetricsSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + String(process.pid) + ".tmp";
  await open(tempPath, "w").then(async (handle) => {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  await rename(tempPath, path);
}

export function createMetricsStore(
  config: { path: string; maxEvents?: number },
  dependencies: { now?: () => Date } = {},
) {
  const path = resolve(config.path);
  const now = dependencies.now ?? (() => new Date());
  const read = async (): Promise<LegacyMetricsSnapshot> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { counters?: unknown }).counters !== "object" ||
        !Array.isArray((parsed as { events?: unknown }).events)
      ) {
        throw new Error("invalid metrics snapshot");
      }
      return parsed as LegacyMetricsSnapshot;
    } catch {
      try {
        await rename(path, corruptPath(path));
      } catch {
        // Missing files are normal on first use.
      }
      return emptyLegacySnapshot();
    }
  };
  const persist = async (
    snapshot: LegacyMetricsSnapshot,
  ): Promise<LegacyMetricsSnapshot> => {
    await legacyWrite(path, snapshot);
    return snapshot;
  };
  return {
    read,
    async increment(name: string): Promise<LegacyMetricsSnapshot> {
      const snapshot = await read();
      snapshot.counters[name] = (snapshot.counters[name] ?? 0) + 1;
      return persist(snapshot);
    },
    async record(event: Record<string, unknown>): Promise<LegacyMetricsSnapshot> {
      const snapshot = await read();
      const name = typeof event.name === "string" ? event.name : "events";
      snapshot.counters[name] = (snapshot.counters[name] ?? 0) + 1;
      snapshot.events.push(
        Object.fromEntries(
          Object.entries(event).map(([key, value]) => [key, sanitizeLegacy(value)]),
        ),
      );
      const limit = config.maxEvents ?? 100;
      snapshot.events = snapshot.events.slice(-limit);
      void now;
      return persist(snapshot);
    },
  };
}

export interface MetricsStoreConfig {
  readonly path: string;
  readonly historyLimit: number;
  readonly enabled?: boolean;
}

function configValue(config?: Partial<MetricsStoreConfig>): MetricsStoreConfig {
  return {
    path: config?.path ?? env.metricsPath,
    historyLimit: config?.historyLimit ?? env.metricsHistoryLimit,
    enabled: config?.enabled ?? env.metricsEnabled,
  };
}

function emptyDocument(): MetricsDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    totals: {
      runs: 0,
      successes: 0,
      failures: 0,
      successRate: 0,
      totalListingsDiscovered: 0,
      totalDetailsScraped: 0,
      totalTelegramSent: 0,
      totalRetries: 0,
    },
    averages: {
      runDurationMs: 0,
      searchDurationMs: 0,
      detailDurationMs: 0,
      sheetDurationMs: 0,
      telegramDurationMs: 0,
      cacheHitRate: 0,
    },
    recentRuns: [],
  };
}

function timingDuration(timing: StageTiming | null): number {
  return timing?.durationMs ?? 0;
}

function calculateDocument(runs: RunMetrics[]): MetricsDocument {
  const document = emptyDocument();
  document.updatedAt = new Date().toISOString();
  document.recentRuns = runs;
  document.totals.runs = runs.length;
  document.totals.successes = runs.filter((run) => run.success).length;
  document.totals.failures = runs.length - document.totals.successes;
  document.totals.successRate =
    runs.length === 0 ? 0 : document.totals.successes / runs.length;
  document.totals.totalListingsDiscovered = runs.reduce(
    (sum, run) => sum + run.search.summariesFound,
    0,
  );
  document.totals.totalDetailsScraped = runs.reduce(
    (sum, run) => sum + run.details.succeeded,
    0,
  );
  document.totals.totalTelegramSent = runs.reduce(
    (sum, run) => sum + run.telegram.sent,
    0,
  );
  document.totals.totalRetries = runs.reduce(
    (sum, run) => sum + run.retries.totalRetries,
    0,
  );
  const count = runs.length || 1;
  document.averages.runDurationMs =
    runs.reduce((sum, run) => sum + run.durationMs, 0) / count;
  document.averages.searchDurationMs =
    runs.reduce((sum, run) => sum + timingDuration(run.search.timing), 0) / count;
  document.averages.detailDurationMs =
    runs.reduce((sum, run) => sum + timingDuration(run.details.timing), 0) / count;
  document.averages.sheetDurationMs =
    runs.reduce((sum, run) => sum + timingDuration(run.sheet.timing), 0) / count;
  document.averages.telegramDurationMs =
    runs.reduce((sum, run) => sum + timingDuration(run.telegram.timing), 0) / count;
  document.averages.cacheHitRate =
    runs.reduce((sum, run) => sum + run.cache.hitRate, 0) / count;
  return document;
}

async function atomicWrite(path: string, value: MetricsDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + String(process.pid) + ".tmp";
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

export async function loadMetrics(
  config?: Partial<MetricsStoreConfig>,
): Promise<MetricsDocument> {
  const resolved = configValue(config);
  if (resolved.enabled === false) return emptyDocument();
  const path = resolve(resolved.path);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray((parsed as { recentRuns?: unknown }).recentRuns)
    ) {
      throw new Error("invalid metrics document");
    }
    return parsed as MetricsDocument;
  } catch (error) {
    if (!isMissing(error)) {
      try {
        await rename(path, corruptPath(path));
      } catch {
        // Inaccessible old files are handled by a clean document.
      }
      if (error instanceof Error) {
        console.warn(
          "[metrics] corrupted metrics file recovered: " + error.message.slice(0, 200),
        );
      }
    }
    return emptyDocument();
  }
}

export async function appendRunMetrics(
  run: RunMetrics,
  config?: Partial<MetricsStoreConfig>,
): Promise<boolean> {
  const resolved = configValue(config);
  if (resolved.enabled === false) return true;
  try {
    const current = await loadMetrics(resolved);
    const runs = [...current.recentRuns, sanitizeRunMetrics(run)].slice(
      -resolved.historyLimit,
    );
    await atomicWrite(resolve(resolved.path), calculateDocument(runs));
    return true;
  } catch (error) {
    console.warn(
      "[metrics] write failed: " +
        (error instanceof Error ? error.message.slice(0, 300) : "unknown error"),
    );
    return false;
  }
}

export { emptyDocument as createEmptyMetricsDocument };
