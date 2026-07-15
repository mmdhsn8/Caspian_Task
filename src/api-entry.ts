import { ConfigDoctorError, runConfigDoctor } from "./config/config-doctor.js";

async function startApi(): Promise<void> {
  const [
    appModule,
    envModule,
    alertModule,
    lockModule,
    sheetsModule,
    loggerModule,
    healthModule,
    apiModule,
  ] = await Promise.all([
    import("./app/run-once.js"),
    import("./config/env.js"),
    import("./services/failure-alert.js"),
    import("./services/run-lock.js"),
    import("./services/sheets.js"),
    import("./utils/logger.js"),
    import("./health/health-store.js"),
    import("./api-server.js"),
  ]);

  const { runOnce } = appModule;
  const { env } = envModule;
  const { sendConfiguredFailureAlert } = alertModule;
  const { acquireRunLock, describeRunLockOwner } = lockModule;
  const { acknowledgeTelegramResults } = sheetsModule;
  const { createLogger } = loggerModule;
  const { HealthStore } = healthModule;
  const { startApiServer } = apiModule;

  const log = createLogger("centris-api");
  const port = env.apiPort;
  const apiKey = env.workflowApiKey;

  if (!apiKey) {
    log.error("WORKFLOW_API_KEY is not set. API server will not start.");
    process.exitCode = 1;
    return;
  }

  const server = await startApiServer({
    port,
    workflowApiKey: apiKey,
    acquireRunLock,
    describeRunLockOwner,
    runOnce,
    sendConfiguredFailureAlert,
    acknowledgeTelegramResults,
    createLogger,
    HealthStore,
    env: {
      healthReportPath: env.healthReportPath,
      healthReportEnabled: env.healthReportEnabled,
      telegramEnabled: env.telegramEnabled,
      runLockEnabled: env.runLockEnabled,
      runLockPath: env.runLockPath,
      runLockStaleMinutes: env.runLockStaleMinutes,
    },
  });

  const shutdown = (signal: string) => {
    log.info("Shutdown requested (" + signal + ")");
    server.close(() => {
      log.info("API server stopped");
    });
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await new Promise<void>((resolve) => {
    server.on("close", resolve);
  });
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

  process.stdout.write("Starting API server...\n");
  await startApi();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Startup failed: " + message);
  process.exitCode = 1;
});
