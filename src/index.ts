import { ConfigDoctorError, runConfigDoctor } from "./config/config-doctor.js";

async function startScraper(): Promise<void> {
  const [appModule, envModule, alertModule, lockModule, loggerModule, healthModule] =
    await Promise.all([
      import("./app/run-once.js"),
      import("./config/env.js"),
      import("./services/failure-alert.js"),
      import("./services/run-lock.js"),
      import("./utils/logger.js"),
      import("./health/health-store.js"),
    ]);

  const { runOnce } = appModule;
  const { env } = envModule;
  const { sendConfiguredFailureAlert } = alertModule;
  const { acquireRunLock, describeRunLockOwner } = lockModule;
  const { createLogger } = loggerModule;
  const { HealthStore } = healthModule;

  const log = createLogger("centris-scraper");
  const health = new HealthStore({
    path: env.healthReportPath,
    enabled: env.healthReportEnabled,
  });
  let lock: Awaited<ReturnType<typeof acquireRunLock>> | null = null;

  try {
    await health.setStartup();
    lock = await acquireRunLock({
      enabled: env.runLockEnabled,
      path: env.runLockPath,
      staleAfterMs: env.runLockStaleMinutes * 60_000,
      trigger: "single-run",
    });
    if (!lock.acquired && lock.reason === "held") {
      log.warn(
        "Run lock held; skipping this run (" + describeRunLockOwner(lock.owner) + ").",
      );
      return;
    }
    if (!lock.acquired) log.warn("Run lock disabled.");
    if (lock.acquired && lock.recoveredStaleLock) log.warn("Recovered a stale run lock.");
    if (lock.acquired && lock.recoveredCorruptLock)
      log.warn("Recovered a corrupt run lock.");
    await health.setLock(
      lock.acquired,
      lock.acquired ? process.pid : null,
      lock.acquired ? new Date().toISOString() : null,
    );

    const summary = await runOnce({ trigger: "manual", healthStore: health });
    if (summary.error) {
      process.exitCode = 1;
      const result = await sendConfiguredFailureAlert({
        runId: summary.runId,
        stage: summary.stage,
        error: summary.error,
        occurredAt: summary.timestamp,
        durationMs: summary.durationMs,
      });
      if (result === "suppressed") log.warn("Failure alert suppressed by cooldown.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Fatal startup error: " + message);
    process.exitCode = 1;
    await sendConfiguredFailureAlert({
      runId: "single-run",
      stage: "startup",
      error: message,
      occurredAt: new Date().toISOString(),
    });
  } finally {
    if (lock?.acquired) {
      try {
        await lock.lock.release();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to release run lock: " + message);
        process.exitCode = 1;
      }
    }
    await health.setLock(false, null, null);
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

  process.stdout.write("Starting scraper...\n");
  await startScraper();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Startup failed: " + message);
  process.exitCode = 1;
});
