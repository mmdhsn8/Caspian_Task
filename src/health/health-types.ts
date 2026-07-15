export type HealthStatus = "starting" | "healthy" | "degraded" | "unhealthy" | "stopped";

export interface HealthReport {
  schemaVersion: number;
  updatedAt: string;
  status: HealthStatus;
  scheduler: {
    enabled: boolean;
    running: boolean;
    intervalMinutes: number | null;
    nextRunAt: string | null;
  };
  activeRun: {
    active: boolean;
    runId: string | null;
    trigger: "manual" | "scheduler" | null;
    startedAt: string | null;
    stage: string | null;
  };
  lastRun: {
    runId: string | null;
    success: boolean | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    stage: string | null;
    errorMessage: string | null;
  };
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastCounts: {
    pagesVisited: number;
    listingsFound: number;
    detailsSucceeded: number;
    detailsFailed: number;
    newCount: number;
    updatedCount: number;
    unchangedCount: number;
    telegramSent: number;
  };
  lock: {
    enabled: boolean;
    held: boolean;
    ownerPid: number | null;
    acquiredAt: string | null;
  };
  cache: {
    enabled: boolean;
    entries: number;
    hitRateLastRun: number;
  };
}
