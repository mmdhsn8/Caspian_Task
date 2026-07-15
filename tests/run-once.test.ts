import {
  runOnce,
  type RunOnceDependencies,
} from "../src/app/run-once.js";
import type { Logger } from "../src/utils/logger.js";

const noOpHealthStore = {
  setActive: async () => undefined,
  setStage: async () => undefined,
  completeRun: async () => undefined,
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

const config: NonNullable<RunOnceDependencies["config"]> = {
  runIdPrefix: "test",
  headless: true,
  scraperTimeoutMs: 30_000,
  telegramEnabled: false,
  telegramChatId: undefined,
  telegramBotToken: undefined,
  googleAppsScriptUrl: undefined,
  telegramParseMode: "HTML",
  telegramMaxRetries: 0,
  failureInjectionEnabled: false,
  failureTestStage: "none",
};

const silentLogger: Logger = {
  name: "test",
  runId: "test",
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const fixedNow = (): Date => new Date("2026-07-14T12:34:56.000Z");

const noResults = await runOnce({
  config,
  now: fixedNow,
  createLogger: () => silentLogger,
  healthStore: noOpHealthStore,
  appendRunMetrics: async () => true,
  crawlSearchResults: async () => ({
    listings: [],
    pagesVisited: 1,
    totalUniqueListings: 0,
    duplicatesRemoved: 0,
    stoppedReason: "no-results",
  }),
});
assert(noResults.error === null, "successful no-results run has no error");
assert(noResults.stage === "search", "successful no-results run ends at search stage");
assert(
  /^test-\d{8}T\d{6}$/.test(noResults.runId),
  "run ID uses configured prefix and timestamp format",
);
assert(noResults.pagesVisited === 1, "search summary is preserved");

const failedSearch = await runOnce({
  config,
  now: fixedNow,
  createLogger: () => silentLogger,
  healthStore: noOpHealthStore,
  appendRunMetrics: async () => true,
  crawlSearchResults: async () => {
    throw new Error("search unavailable");
  },
});
assert(failedSearch.stage === "search", "search failures are classified");
assert(failedSearch.error === "search unavailable", "search failures retain the error message");

const injectedSearchFailure = await runOnce({
  config: {
    ...config,
    failureInjectionEnabled: true,
    failureTestStage: "search",
  },
  now: fixedNow,
  createLogger: () => silentLogger,
  healthStore: noOpHealthStore,
  appendRunMetrics: async () => true,
  crawlSearchResults: async () => {
    throw new Error("crawl should not run when diagnostic failure injection is enabled");
  },
});
assert(injectedSearchFailure.stage === "search", "diagnostic search failure retains stage");
assert(
  injectedSearchFailure.error === "Diagnostic failure injection at search stage",
  "diagnostic failure injection is explicit and deterministic",
);

console.log(
  "\nRun-once tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
