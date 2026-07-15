import type { AddressInfo } from "node:net";
import { startApiServer, type ApiServerConfig } from "../src/api-server.js";
import type { TelegramAckItem, TelegramAckOptions } from "../src/services/sheets.js";
import type { Logger } from "../src/utils/logger.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

const silentLogger: Logger = {
  name: "test",
  runId: "test",
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

class TestHealthStore {
  constructor(_config: { path: string; enabled: boolean }) {}
  async setStartup(): Promise<void> {}
  async setLock(_locked: boolean, _pid: number | null, _at: string | null): Promise<void> {}
  async setActive(
    _runId: string,
    _trigger: string,
    _startedAt: string,
    _stage: string,
  ): Promise<void> {}
  async setStage(_stage: string): Promise<void> {}
  async completeRun(_run: unknown, _status: string): Promise<void> {}
}

function baseConfig(
  overrides: Partial<ApiServerConfig> = {},
): ApiServerConfig {
  return {
    port: 0,
    workflowApiKey: "secret-key",
    acquireRunLock: async () => ({
      acquired: true,
      lock: { release: async () => undefined },
      recoveredStaleLock: false,
      recoveredCorruptLock: false,
    }),
    describeRunLockOwner: () => "owner",
    runOnce: async () => ({
      runId: "centris-20260716T000000",
      timestamp: "2026-07-16T00:00:00.000Z",
      durationMs: 1,
      listingsFound: 0,
      pagesVisited: 0,
      stoppedReason: "completed",
      detailsAttempted: 0,
      detailsSucceeded: 0,
      detailsFailed: 0,
      newListings: 0,
      updatedListings: 0,
      unchangedListings: 0,
      totalStored: 0,
      telegramRequested: 0,
      telegramSent: 0,
      telegramFailed: 0,
      telegramSkipped: 0,
      stage: "search",
      error: null,
      detailsCacheHits: 0,
      detailsCacheMisses: 0,
      detailsLiveRequests: 0,
      retries: 0,
      rateLimitWaitMs: 0,
      rateLimitWaitCount: 0,
      newListingsData: [],
    }),
    sendConfiguredFailureAlert: async () => "sent",
    acknowledgeTelegramResults: async () => undefined,
    createLogger: () => silentLogger,
    HealthStore: TestHealthStore,
    env: {
      healthReportPath: ".runtime/health.json",
      healthReportEnabled: false,
      telegramEnabled: true,
      runLockEnabled: true,
      runLockPath: ".runtime/lock",
      runLockStaleMinutes: 180,
    },
    ...overrides,
  };
}

async function withServer(
  config: ApiServerConfig,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await startApiServer(config);
  const address = server.address() as AddressInfo;
  try {
    await fn("http://127.0.0.1:" + String(address.port));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

try {
  await withServer(baseConfig(), async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/notifications/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingId: "12345678" }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    assert(response.status === 401, "ack auth: missing key returns 401");
    assert(body.error === "Unauthorized", "ack auth: body is unauthorized");
  });

  let invalidAckCalls = 0;
  await withServer(
    baseConfig({
      acknowledgeTelegramResults: async () => {
        invalidAckCalls++;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/notifications/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workflow-key": "secret-key",
        },
        body: JSON.stringify({ listingId: "   " }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      assert(response.status === 400, "ack validation: blank listingId returns 400");
      assert(
        body.error === "listingId must be a non-empty string",
        "ack validation: error message is safe",
      );
      assert(invalidAckCalls === 0, "ack validation: service is not called on invalid body");
    },
  );

  let ackItems: readonly TelegramAckItem[] | null = null;
  let ackOptions: TelegramAckOptions | undefined;
  await withServer(
    baseConfig({
      acknowledgeTelegramResults: async (results, options) => {
        ackItems = results;
        ackOptions = options;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/notifications/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workflow-key": "secret-key",
        },
        body: JSON.stringify({ listingId: "12345678" }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      assert(response.status === 200, "ack success: returns 200");
      assert(body.success === true, "ack success: response success is true");
      assert(body.listingId === "12345678", "ack success: response listingId matches");
      assert(body.status === "acknowledged", "ack success: response status matches");
      assert(ackItems?.length === 1, "ack success: existing ack service is called once");
      assert(ackItems?.[0]?.listingId === "12345678", "ack success: listingId reused");
      assert(ackItems?.[0]?.success === true, "ack success: ack marks notification success");
      assert(ackItems?.[0]?.messageId === null, "ack success: messageId stays null");
      assert(ackItems?.[0]?.attempts === 1, "ack success: attempts is 1");
      assert(ackItems?.[0]?.error === null, "ack success: error stays null");
      assert(typeof ackItems?.[0]?.sentAt === "string", "ack success: sentAt is populated");
      assert(ackOptions?.throwOnError === true, "ack success: API opts into throwOnError");
    },
  );

  await withServer(
    baseConfig({
      acknowledgeTelegramResults: async () => {
        throw new Error("network down");
      },
    }),
    async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/notifications/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workflow-key": "secret-key",
        },
        body: JSON.stringify({ listingId: "99999999" }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      assert(response.status === 500, "ack failure: returns non-2xx");
      assert(body.error === "Acknowledgement failed", "ack failure: error is safe");
      assert(body.listingId === "99999999", "ack failure: listingId is echoed");
    },
  );
} catch (error) {
  failed++;
  console.error("  FAIL: api-server test crashed: " + String(error));
}

console.log(
  "\nAPI server tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
