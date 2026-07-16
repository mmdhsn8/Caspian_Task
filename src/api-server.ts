import type http from "node:http";

export interface ApiServerConfig {
  readonly port: number;
  readonly workflowApiKey: string;
  readonly acquireRunLock: (
    config: import("./services/run-lock.js").RunLockConfig,
  ) => Promise<import("./services/run-lock.js").RunLockAcquireResult>;
  readonly describeRunLockOwner: (
    owner: import("./services/run-lock.js").RunLockOwner | null,
  ) => string;
  readonly runOnce: (
    deps?: import("./app/run-once.js").RunOnceDependencies,
  ) => Promise<import("./app/run-once.js").RunSummary>;
  readonly sendConfiguredFailureAlert: (
    params: import("./services/failure-alert.js").FailureAlertInput,
  ) => Promise<import("./services/failure-alert.js").FailureAlertResult>;
  readonly acknowledgeTelegramResults: (
    results: readonly import("./services/sheets.js").TelegramAckItem[],
    options?: import("./services/sheets.js").TelegramAckOptions,
  ) => Promise<import("./services/sheets.js").TelegramAckResult>;
  readonly createLogger: (
    name: string,
    runId?: string,
  ) => import("./utils/logger.js").Logger;
  readonly HealthStore: new (
    config: import("./health/health-store.js").HealthStoreConfig,
  ) => import("./health/health-store.js").HealthStore;
  readonly env: {
    readonly healthReportPath: string;
    readonly healthReportEnabled: boolean;
    readonly telegramEnabled: boolean;
    readonly runLockEnabled: boolean;
    readonly runLockPath: string;
    readonly runLockStaleMinutes: number;
  };
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}

function isAuthorized(req: http.IncomingMessage, workflowApiKey: string): boolean {
  const workflowKey = req.headers["x-workflow-key"];
  return typeof workflowKey === "string" && workflowKey === workflowApiKey;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  req.setEncoding("utf8");
  let raw = "";
  for await (const chunk of req) {
    if (typeof chunk !== "string") {
      throw new Error("Request body must be UTF-8 JSON");
    }
    raw += chunk;
  }
  raw = raw.trim();
  if (raw.length === 0) {
    throw new Error("Request body must be a JSON object");
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseListingId(body: Record<string, unknown>): string {
  const listingId = body.listingId;
  if (typeof listingId !== "string" || listingId.trim().length === 0) {
    throw new Error("listingId must be a non-empty string");
  }
  return listingId.trim();
}

function parseTelegramMessageId(body: Record<string, unknown>): string | number | null {
  const messageId = body.telegramMessageId;
  if (messageId == null) return null;
  if (typeof messageId === "string") {
    return messageId.trim().length === 0 ? null : messageId.trim();
  }
  if (typeof messageId === "number" && Number.isFinite(messageId)) {
    return messageId;
  }
  throw new Error("telegramMessageId must be a string, number, or omitted");
}

export async function startApiServer(config: ApiServerConfig): Promise<http.Server> {
  const log = config.createLogger("centris-api");
  const { createServer } = await import("node:http");

  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "POST" && parsedUrl.pathname === "/api/v1/runs/sentris") {
      void handleRunRequest(req, res, config, log);
      return;
    }

    if (
      method === "POST" &&
      parsedUrl.pathname === "/api/v1/notifications/telegram-sent"
    ) {
      void handleTelegramSentRequest(req, res, config, log);
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      log.info("API server listening on http://127.0.0.1:" + String(config.port));
      resolve(server);
    });
  });
}

async function handleRunRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ApiServerConfig,
  log: ReturnType<typeof import("./utils/logger.js").createLogger>,
): Promise<void> {
  if (!isAuthorized(req, config.workflowApiKey)) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  const health = new config.HealthStore({
    path: config.env.healthReportPath,
    enabled: config.env.healthReportEnabled,
  });

  let lock: Awaited<ReturnType<typeof config.acquireRunLock>> | null = null;

  try {
    await health.setStartup();
    lock = await config.acquireRunLock({
      enabled: config.env.runLockEnabled,
      path: config.env.runLockPath,
      staleAfterMs: config.env.runLockStaleMinutes * 60_000,
      trigger: "api",
    });

    if (!lock.acquired && lock.reason === "held") {
      jsonResponse(res, 409, {
        error: "Another run is currently active",
        owner: config.describeRunLockOwner(lock.owner),
      });
      return;
    }

    if (!lock.acquired) {
      jsonResponse(res, 503, { error: "Run lock disabled" });
      return;
    }

    await health.setLock(true, process.pid, new Date().toISOString());

    const summary = await config.runOnce({
      trigger: "manual",
      notificationMode: "external",
      healthStore: health,
    });

    if (summary.error) {
      await config.sendConfiguredFailureAlert({
        runId: summary.runId,
        stage: summary.stage,
        error: summary.error,
        occurredAt: summary.timestamp,
        durationMs: summary.durationMs,
      });

      jsonResponse(res, 500, {
        error: summary.error,
        runId: summary.runId,
        stage: summary.stage,
        durationMs: summary.durationMs,
      });
      return;
    }

    jsonResponse(res, 200, {
      runId: summary.runId,
      status: "completed",
      durationMs: summary.durationMs,
      totalFound: summary.listingsFound,
      newCount: summary.newListings,
      updatedCount: summary.updatedListings,
      unchangedCount: summary.unchangedListings,
      newListings: summary.newListingsData ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Fatal API run error: " + message);

    await config.sendConfiguredFailureAlert({
      runId: "api",
      stage: "startup",
      error: message,
      occurredAt: new Date().toISOString(),
    });

    jsonResponse(res, 500, { error: message });
  } finally {
    if (lock?.acquired) {
      try {
        await lock.lock.release();
      } catch (releaseError) {
        const msg =
          releaseError instanceof Error ? releaseError.message : String(releaseError);
        log.warn("Run lock release warning: " + msg);
      }
    }
    await health.setLock(false, null, null);
  }
}

async function handleTelegramSentRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ApiServerConfig,
  log: ReturnType<typeof import("./utils/logger.js").createLogger>,
): Promise<void> {
  if (!isAuthorized(req, config.workflowApiKey)) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  let listingId: string;
  let telegramMessageId: string | number | null;
  try {
    const body = await readJsonBody(req);
    listingId = parseListingId(body);
    telegramMessageId = parseTelegramMessageId(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    jsonResponse(res, 400, { error: message });
    return;
  }

  try {
    const ackResult = await config.acknowledgeTelegramResults(
      [
        {
          listingId,
          success: true,
          messageId: telegramMessageId,
          attempts: 1,
          error: null,
          sentAt: new Date().toISOString(),
        },
      ],
      { throwOnError: true },
    );

    if (ackResult.updatedCount === 0 && ackResult.notFoundCount > 0) {
      jsonResponse(res, 404, {
        error: "Listing not found",
        listingId,
      });
      return;
    }

    jsonResponse(res, 200, {
      ok: true,
      listingId,
      telegramStatus: "SENT",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Telegram-sent API failed for listing " + listingId + ": " + message);
    jsonResponse(res, 503, {
      error: "Acknowledgement failed: " + message,
      listingId,
    });
  }
}
