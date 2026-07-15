import { ConfigDoctorError, runConfigDoctor } from "./config/config-doctor.js";

async function startScheduler(): Promise<void> {
  const [
    appModule,
    envModule,
    alertModule,
    lockModule,
    schedulerModule,
    loggerModule,
    healthModule,
  ] = await Promise.all([
    import("./app/run-once.js"),
    import("./config/env.js"),
    import("./services/failure-alert.js"),
    import("./services/run-lock.js"),
    import("./services/scheduler.js"),
    import("./utils/logger.js"),
    import("./health/health-store.js"),
  ]);

  const { runOnce } = appModule;
  const { env } = envModule;
  const { sendConfiguredFailureAlert } = alertModule;
  const { acquireRunLock, describeRunLockOwner } = lockModule;
  const { start } = schedulerModule;
  const { createLogger } = loggerModule;
  const { HealthStore } = healthModule;

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  type RunSummary = Awaited<ReturnType<typeof runOnce>>;

  class ScheduledRunError extends Error {
    readonly summary: RunSummary;

    constructor(summary: RunSummary) {
      super(summary.error ?? "Run failed without an error message");
      this.name = "ScheduledRunError";
      this.summary = summary;
    }
  }

  function nextRetryAt(): string {
    return new Date(Date.now() + env.scheduleIntervalMinutes * 60_000).toISOString();
  }

  const log = createLogger("centris-scheduler");
  const health = new HealthStore({
    path: env.healthReportPath,
    enabled: env.healthReportEnabled,
    schedulerEnabled: env.schedulerEnabled,
    intervalMinutes: env.scheduleIntervalMinutes,
  });

  async function alertForSummary(summary: RunSummary): Promise<void> {
    if (!summary.error) return;
    const result = await sendConfiguredFailureAlert({
      runId: summary.runId,
      stage: summary.stage,
      error: summary.error,
      occurredAt: summary.timestamp,
      durationMs: summary.durationMs,
      nextRetryAt: nextRetryAt(),
    });
    if (result === "suppressed") {
      createLogger("centris-scheduler", summary.runId).warn(
        "Failure alert suppressed by cooldown.",
      );
    }
  }

  await health.setStartup();
  if (!env.schedulerEnabled) {
    log.warn("Scheduler disabled (set SCHEDULER_ENABLED=true to enable it).");
    return;
  }

  const lockResult = await acquireRunLock({
    enabled: env.runLockEnabled,
    path: env.runLockPath,
    staleAfterMs: env.runLockStaleMinutes * 60_000,
    trigger: "scheduler",
  });
  if (!lockResult.acquired && lockResult.reason === "held") {
    log.warn(
      "Run lock held; scheduler will not start (" +
        describeRunLockOwner(lockResult.owner) +
        ").",
    );
    return;
  }
  if (!lockResult.acquired) {
    log.warn("Run lock disabled.");
  } else if (lockResult.recoveredStaleLock) {
    log.warn("Recovered a stale run lock.");
  } else if (lockResult.recoveredCorruptLock) {
    log.warn("Recovered a corrupt run lock.");
  }
  await health.setLock(
    lockResult.acquired,
    lockResult.acquired ? process.pid : null,
    lockResult.acquired ? new Date().toISOString() : null,
  );

  let scheduler: ReturnType<typeof start> | null = null;
  let shutdownRequested = false;
  const isShutdownRequested = (): boolean => shutdownRequested;
  const shutdown = (signal: string): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.info("Shutdown requested (" + signal + ").");
    if (scheduler?.isRunning()) log.info("Waiting for active run...");
    scheduler?.stop();
  };
  const onSigint = (): void => {
    shutdown("SIGINT");
  };
  const onSigterm = (): void => {
    shutdown("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  log.info(
    "Scheduler started: interval=" +
      String(env.scheduleIntervalMinutes) +
      "m runOnStart=" +
      String(env.scheduleRunOnStart) +
      " lockEnabled=" +
      String(env.runLockEnabled) +
      " failureAlertsEnabled=" +
      String(env.failureAlertsEnabled),
  );

  scheduler = start({
    intervalMs: env.scheduleIntervalMinutes * 60_000,
    runOnStart: env.scheduleRunOnStart,
    run: async () => {
      const summary = await runOnce({ trigger: "scheduler", healthStore: health });
      if (summary.error) throw new ScheduledRunError(summary);
    },
    onRunFailure: async (error) => {
      const message = errorMessage(error);
      if (error instanceof ScheduledRunError) {
        await alertForSummary(error.summary);
        return;
      }
      await sendConfiguredFailureAlert({
        runId: "scheduler",
        stage: "scheduler",
        error: message,
        occurredAt: new Date().toISOString(),
        nextRetryAt: nextRetryAt(),
      });
    },
    log: (message): void => {
      log.info(message);
    },
    onNextRunScheduled: (nextRunAt): void => {
      void health.setScheduler(nextRunAt.toISOString(), true);
    },
  });
  await health.setScheduler(null, true);

  if (isShutdownRequested()) {
    if (scheduler.isRunning()) log.info("Waiting for active run...");
    scheduler.stop();
  }

  try {
    await scheduler.done;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (lockResult.acquired) await lockResult.lock.release();
    await health.setLock(false, null, null);
    await health.stop();
    log.info("Scheduler stopped.");
  }
}

async function main(): Promise<void> {
  try {
    await runConfigDoctor();
  } catch (error) {
    if (error instanceof ConfigDoctorError) {
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  process.stdout.write("Starting scheduler...\n");
  await startScheduler();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Startup failed: " + message);
  process.exitCode = 1;
});
