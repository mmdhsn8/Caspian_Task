import { createLogger, getConfiguredLevel } from "../src/utils/logger.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL: " + msg);
  }
}

// ── Logger basic ────────────────────────────────────────────────────────────
{
  const log = createLogger("test", "run-123");
  assert(log.name === "test", "Logger name is 'test'. Got: " + log.name);
  assert(log.runId === "run-123", "Logger runId is 'run-123'. Got: " + (log.runId ?? "null"));
}

{
  const log2 = createLogger("test-no-runid");
  assert(log2.name === "test-no-runid", "Logger name without runId");
  assert(log2.runId === null, "Logger runId is null when not provided");
}

// ── getConfiguredLevel ──────────────────────────────────────────────────────
{
  const level = getConfiguredLevel();
  assert(level === "info" || level === "error" || level === "warn" || level === "debug",
    "getConfiguredLevel returns a valid level. Got: " + level);
}

// ── Logger methods don't throw ──────────────────────────────────────────────
{
  const log3 = createLogger("no-throw", "r1");
  try {
    log3.info("test info message");
    log3.warn("test warn message");
    log3.error("test error message");
    log3.debug("test debug message");
    assert(true, "Logger methods complete without throwing");
  } catch (e) {
    assert(false, "Logger methods threw: " + String(e));
  }
}

// ── Logger with meta ────────────────────────────────────────────────────────
{
  const log4 = createLogger("meta", "r2");
  try {
    log4.info("test", { key: "value" });
    log4.warn("test", 1, 2, 3);
    log4.info("test", "a", "b", "c");
    assert(true, "Logger meta methods complete without throwing");
  } catch (e) {
    assert(false, "Logger meta methods threw: " + String(e));
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\nLogger test results: " + String(passed) + " passed, " + String(failed) + " failed");
if (failed > 0) process.exit(1);
