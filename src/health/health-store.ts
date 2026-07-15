import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";
import type { RunMetrics } from "../metrics/metrics-types.js";
import type { HealthReport, HealthStatus } from "./health-types.js";

interface LegacyHealthCheck {
  status: string;
  error: string | null;
}

function corruptPath(path: string): string {
  return path.endsWith(".json")
    ? path.slice(0, -".json".length) + ".corrupt." + String(Date.now()) + ".json"
    : path + ".corrupt." + String(Date.now()) + ".json";
}

function sanitizeHealthError(value: unknown): string | null {
  if (value == null) return null;
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "unknown error";
  return raw
    .replace(/authorization:\s+[^\s]+/gi, "authorization:[redacted]")
    .replace(/(token|bearer|password|secret)\s*[:=]\s*[^\s]+/gi, "$1:[redacted]")
    .slice(0, 500);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createHealthStore(
  config: { path: string },
  _dependencies: { now?: () => Date } = {},
) {
  const path = resolve(config.path);
  const read = async (): Promise<{ checks: Record<string, LegacyHealthCheck> }> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { checks?: unknown }).checks !== "object"
      ) {
        throw new Error("invalid health snapshot");
      }
      return parsed as { checks: Record<string, LegacyHealthCheck> };
    } catch {
      try {
        await rename(path, corruptPath(path));
      } catch {
        // Missing files are normal on first use.
      }
      return { checks: {} };
    }
  };
  const write = async (snapshot: { checks: Record<string, LegacyHealthCheck> }) => {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = path + "." + String(process.pid) + ".tmp";
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    return snapshot;
  };
  return {
    read,
    async get(name: string): Promise<LegacyHealthCheck | null> {
      return (await read()).checks[name] ?? null;
    },
    async set(name: string, value: { status: string; error?: unknown }): Promise<void> {
      const snapshot = await read();
      snapshot.checks[name] = {
        status: value.status,
        error: value.status === "healthy" ? null : sanitizeHealthError(value.error),
      };
      await write(snapshot);
    },
  };
}

export interface HealthStoreConfig {
  readonly path: string;
  readonly enabled?: boolean;
  readonly schedulerEnabled?: boolean;
  readonly intervalMinutes?: number;
  readonly lockEnabled?: boolean;
  readonly cacheEnabled?: boolean;
}

function emptyReport(config: HealthStoreConfig): HealthReport {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    status: "starting",
    scheduler: {
      enabled: config.schedulerEnabled ?? env.schedulerEnabled,
      running: false,
      intervalMinutes: config.intervalMinutes ?? env.scheduleIntervalMinutes,
      nextRunAt: null,
    },
    activeRun: {
      active: false,
      runId: null,
      trigger: null,
      startedAt: null,
      stage: null,
    },
    lastRun: {
      runId: null,
      success: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      stage: null,
      errorMessage: null,
    },
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastCounts: {
      pagesVisited: 0,
      listingsFound: 0,
      detailsSucceeded: 0,
      detailsFailed: 0,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      telegramSent: 0,
    },
    lock: {
      enabled: config.lockEnabled ?? env.runLockEnabled,
      held: false,
      ownerPid: null,
      acquiredAt: null,
    },
    cache: {
      enabled: config.cacheEnabled ?? env.detailCacheEnabled,
      entries: 0,
      hitRateLastRun: 0,
    },
  };
}

async function atomicWrite(path: string, report: HealthReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = path + "." + String(process.pid) + ".tmp";
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(JSON.stringify(report, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

export class HealthStore {
  private readonly config: HealthStoreConfig;
  private readonly path: string;
  private report: HealthReport | null = null;

  constructor(config: HealthStoreConfig) {
    this.config = config;
    this.path = resolve(config.path);
  }

  async load(): Promise<HealthReport> {
    if (this.report) return this.report;
    if (this.config.enabled === false) {
      this.report = emptyReport(this.config);
      return this.report;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
      ) {
        throw new Error("invalid health document");
      }
      this.report = parsed as HealthReport;
    } catch (error) {
      if (!isMissing(error)) {
        try {
          await rename(this.path, corruptPath(this.path));
        } catch {
          // Start clean when the old file cannot be moved.
        }
        console.warn(
          "[health] health file recovered: " +
            (error instanceof Error ? error.message.slice(0, 200) : "invalid document"),
        );
      }
      this.report = emptyReport(this.config);
    }
    return this.report;
  }

  async update(mutator: (report: HealthReport) => void): Promise<HealthReport> {
    const report = await this.load();
    mutator(report);
    report.updatedAt = new Date().toISOString();
    try {
      await atomicWrite(this.path, report);
    } catch (error) {
      console.warn(
        "[health] write failed: " +
          (error instanceof Error ? error.message.slice(0, 300) : "unknown error"),
      );
    }
    return report;
  }

  async setStartup(): Promise<void> {
    await this.update((report) => {
      report.status = "starting";
      report.activeRun.active = false;
    });
  }

  async setActive(
    runId: string,
    trigger: "manual" | "scheduler",
    startedAt: string,
    stage: string,
  ): Promise<void> {
    await this.update((report) => {
      report.activeRun = { active: true, runId, trigger, startedAt, stage };
    });
  }

  async setStage(stage: string): Promise<void> {
    await this.update((report) => {
      if (report.activeRun.active) report.activeRun.stage = stage;
    });
  }

  async completeRun(run: RunMetrics, status: HealthStatus): Promise<void> {
    await this.update((report) => {
      report.status = status;
      report.activeRun = {
        active: false,
        runId: null,
        trigger: null,
        startedAt: null,
        stage: null,
      };
      report.lastRun = {
        runId: run.runId,
        success: run.success,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        stage: run.stage,
        errorMessage: sanitizeHealthError(run.errorMessage),
      };
      if (run.success) {
        report.lastSuccessAt = run.finishedAt;
        report.consecutiveFailures = 0;
      } else {
        report.lastFailureAt = run.finishedAt;
        report.consecutiveFailures += 1;
      }
      report.lastCounts = {
        pagesVisited: run.search.pagesVisited,
        listingsFound: run.search.summariesFound,
        detailsSucceeded: run.details.succeeded,
        detailsFailed: run.details.failed,
        newCount: run.sheet.newCount,
        updatedCount: run.sheet.updatedCount,
        unchangedCount: run.sheet.unchangedCount,
        telegramSent: run.telegram.sent,
      };
      report.cache.hitRateLastRun = run.cache.hitRate;
      report.cache.entries = run.cache.entries ?? 0;
    });
  }

  async setScheduler(nextRunAt: string | null, running: boolean): Promise<void> {
    await this.update((report) => {
      report.scheduler.running = running;
      report.scheduler.nextRunAt = nextRunAt;
    });
  }

  async setLock(
    held: boolean,
    ownerPid: number | null,
    acquiredAt: string | null,
  ): Promise<void> {
    await this.update((report) => {
      report.lock.held = held;
      report.lock.ownerPid = ownerPid;
      report.lock.acquiredAt = acquiredAt;
    });
  }

  async stop(): Promise<void> {
    await this.update((report) => {
      report.status = "stopped";
      report.scheduler.running = false;
      report.scheduler.nextRunAt = null;
      report.activeRun.active = false;
      report.activeRun.runId = null;
      report.activeRun.trigger = null;
      report.activeRun.startedAt = null;
      report.activeRun.stage = null;
    });
  }
}

export { emptyReport as createEmptyHealthReport };
