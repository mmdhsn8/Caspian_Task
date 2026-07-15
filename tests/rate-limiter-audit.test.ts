import { AsyncRateLimiter } from "../src/resilience/rate-limiter.js";
import { calculateRetryDelay, executeWithRetry } from "../src/resilience/retry-policy.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class VirtualClock {
  nowMs = 0;
  private sleepers: Array<{ target: number; resolve: () => void }> = [];

  now = (): number => this.nowMs;

  sleep = async (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.sleepers.push({ target: this.nowMs + ms, resolve });
    });

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    const ready = this.sleepers.filter((item) => item.target <= this.nowMs);
    this.sleepers = this.sleepers.filter((item) => item.target > this.nowMs);
    for (const item of ready) item.resolve();
    await settle();
  }
}

{
  const delay = calculateRetryDelay(
    { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.2 },
    2,
    () => 0,
  );
  assert(delay === 1600, "retry jitter stays within the configured lower bound");
}

{
  let calls = 0;
  const contexts: string[] = [];
  const result = await executeWithRetry(
    async () => {
      calls++;
      if (calls === 1) throw new Error("temporary timeout");
      return "ok";
    },
    { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 },
    {
      operation: "audit",
      sleep: async () => undefined,
      onRetry: ({ attempt, delayMs }) => {
        contexts.push(String(attempt) + ":" + String(delayMs));
      },
    },
  );
  assert(result.retries === 1, "executeWithRetry reports actual retries");
  assert(contexts[0] === "2:100", "executeWithRetry exposes retry context");
}

{
  const clock = new VirtualClock();
  const limiter = new AsyncRateLimiter(
    { enabled: true, requestsPerMinute: 60, burst: 2 },
    { now: clock.now, sleep: clock.sleep },
  );
  const order: string[] = [];
  const acquire = (label: string) =>
    limiter.acquire().then((result) => {
      order.push(label + "@" + String(clock.nowMs) + ":" + String(result.waitedMs));
      return result;
    });

  const pending = [acquire("a"), acquire("b"), acquire("c"), acquire("d")];
  await settle();
  assert(order[0] === "a@0:0" && order[1] === "b@0:0", "initial burst resolves immediately");
  await clock.advance(1000);
  assert(order[2] === "c@1000:1000", "third acquire resolves at the first refill");
  await clock.advance(1000);
  assert(order[3] === "d@2000:2000", "fourth acquire resolves at the second refill");
  await Promise.all(pending);
}

{
  const clock = new VirtualClock();
  const limiter = new AsyncRateLimiter(
    { enabled: true, requestsPerMinute: 60, burst: 2 },
    { now: clock.now, sleep: clock.sleep },
  );
  let resolved = 0;
  for (let i = 0; i < 100; i++) {
    void limiter.acquire().then(() => {
      resolved++;
    });
  }
  await settle();
  assert(resolved === 2, "sustained limiter grants only the initial burst immediately");
  for (let seconds = 1; seconds <= 5; seconds++) {
    await clock.advance(1000);
    assert(
      resolved <= 2 + seconds,
      "sustained throughput never exceeds burst plus refill allowance",
    );
  }
}

console.log(
  "\nRate limiter audit tests: " +
    String(passed) +
    " passed, " +
    String(failed) +
    " failed",
);
if (failed > 0) process.exit(1);
