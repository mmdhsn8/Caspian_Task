import { start } from "../src/services/scheduler.js";

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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const waitResolvers: Array<() => void> = [];
let releaseFirstRun: (() => void) | null = null;
let runs = 0;
const scheduler = start({
  intervalMs: 1_000,
  runOnStart: true,
  run: async () => {
    runs++;
    if (runs === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });
    }
  },
  wait: async () =>
    new Promise<void>((resolve) => {
      waitResolvers.push(resolve);
    }),
  log: () => undefined,
});

await settle();
assert(runs === 1, "scheduler runs immediately when configured");
assert(waitResolvers.length === 0, "scheduler does not wait while a run is active");

releaseFirstRun?.();
await settle();
assert(waitResolvers.length === 1, "fixed delay starts after the first run finishes");

waitResolvers[0]?.();
await settle();
assert(runs === 2, "scheduler starts the next run after the fixed delay");
await settle();
assert(waitResolvers.length === 2, "scheduler waits after every completed run");

scheduler.stop();
waitResolvers[1]?.();
await scheduler.done;
assert(true, "scheduler stops cleanly after a wait");

const failedWaitResolvers: Array<() => void> = [];
let failureRuns = 0;
let failureCallbacks = 0;
const failureScheduler = start({
  intervalMs: 1_000,
  runOnStart: false,
  run: async () => {
    failureRuns++;
    throw new Error("expected failure");
  },
  onRunFailure: async () => {
    failureCallbacks++;
  },
  wait: async () =>
    new Promise<void>((resolve) => {
      failedWaitResolvers.push(resolve);
    }),
  log: () => undefined,
});

await settle();
assert(failedWaitResolvers.length === 1, "scheduler waits before a delayed first run");
failedWaitResolvers[0]?.();
await settle();
assert(failureRuns === 1, "scheduler invokes the run after its delay");
assert(failureCallbacks === 1, "scheduler routes failures to its handler");
await settle();
failureScheduler.stop();
failedWaitResolvers[1]?.();
await failureScheduler.done;

console.log(
  "\nScheduler tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
