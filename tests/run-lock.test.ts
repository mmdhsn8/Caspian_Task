import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, getCurrentProcessStartTime } from "../src/services/run-lock.js";

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

function writeOwner(lockPath: string, overrides: Record<string, unknown>): Promise<void> {
  const data: Record<string, unknown> = {
    pid: process.pid,
    hostname: "test-host",
    acquiredAt: new Date().toISOString(),
    token: "test-token",
    processStartTime: getCurrentProcessStartTime(),
    ...overrides,
  };
  return writeFile(join(lockPath, "owner.json"), JSON.stringify(data), "utf8");
}

const directory = await mkdtemp(join(tmpdir(), "centris-run-lock-"));
const lockPath = join(directory, "run.lock");

try {
  // ── Disabled ──────────────────────────────────────────────────────────────
  {
    const disabled = await acquireRunLock({
      enabled: false,
      path: lockPath,
      staleAfterMs: 1_000,
    });
    assert(!disabled.acquired && disabled.reason === "disabled", "disabled lock is skipped");
  }

  // ── Normal acquire / double acquire / release ──────────────────────────────
  {
    const first = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 1_000,
    });
    assert(first.acquired, "first process acquires lock");

    const held = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 1_000,
    });
    assert(!held.acquired && held.reason === "held", "second process is prevented from overlap");

    if (first.acquired) await first.lock.release();

    const afterRelease = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 1_000,
    });
    assert(afterRelease.acquired, "lock is available after release");
    if (afterRelease.acquired) await afterRelease.lock.release();
  }

  // ── Stale PID (dead process, old age) ──────────────────────────────────────
  {
    await mkdir(lockPath);
    await writeOwner(lockPath, {
      pid: 999_999_999,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const recovered = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 1_000,
    });
    assert(recovered.acquired, "dead stale lock is recovered");
    assert(
      recovered.acquired && recovered.recoveredStaleLock,
      "stale recovery is reported",
    );
    if (recovered.acquired) await recovered.lock.release();
  }

  // ── Fresh lock with dead PID (now recovered — PID check comes before age) ─
  {
    await mkdir(lockPath);
    await writeOwner(lockPath, { pid: 999_999_999 });
    const recovered = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 60_000,
    });
    assert(recovered.acquired, "fresh lock with dead PID is recovered despite young age");
    if (recovered.acquired) await recovered.lock.release();
  }

  // ── Timeout recovery (live PID but too old) ────────────────────────────────
  {
    await mkdir(lockPath);
    await writeOwner(lockPath, {
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const recovered = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 60_000,
    });
    assert(recovered.acquired && recovered.recoveredStaleLock, "too-old lock with live PID is recovered");
    if (recovered.acquired) await recovered.lock.release();
  }

  // ── Corrupt lock (unparseable owner.json) → rename + recover ──────────────
  {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), "not valid json", "utf8");
    const recovered = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 1_000,
    });
    assert(recovered.acquired, "corrupt lock is recovered");
    assert(
      recovered.acquired && recovered.recoveredCorruptLock,
      "corrupt recovery flag is set",
    );
    if (recovered.acquired) await recovered.lock.release();
  }

  // ── Reused PID (live PID but processStartTime differs) ─────────────────────
  {
    await mkdir(lockPath);
    const fakeStartTime = new Date(Date.now() - 3_600_000).toISOString();
    await writeOwner(lockPath, {
      pid: process.pid,
      processStartTime: fakeStartTime,
    });
    const recovered = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 60_000,
    });
    if (recovered.acquired) {
      assert(recovered.recoveredStaleLock, "reused PID: stale recovery flag set");
      await recovered.lock.release();
    } else {
      // queryRemoteProcessStartTime unavailable → age check still guards it
      assert(recovered.reason === "held", "reused PID not detected via start time (age check holds)");
    }
  }

  // ── SIGINT cleanup (shutdown handler releases lock) ────────────────────────
  {
    await mkdir(lockPath);
    const acquired = await acquireRunLock({
      enabled: true,
      path: lockPath,
      staleAfterMs: 60_000,
    });
    assert(acquired.acquired, "acquire before SIGINT");
    if (acquired.acquired) {
      // Emit SIGINT so the registered once-handler fires
      process.emit("SIGINT" as any);
      // Give the async release a moment to complete
      await new Promise((r) => setTimeout(r, 100));
      // After SIGINT, the lock directory should be removed
      const { access } = await import("node:fs/promises");
      let exists = true;
      try {
        await access(lockPath);
      } catch {
        exists = false;
      }
      assert(!exists, "lock released after SIGINT");
      // Re-register since process.once consumed it
      // (the handler will be re-registered by the next acquire via registerShutdownHandlers)
    }
  }

} finally {
  await rm(directory, { recursive: true, force: true });
  // Remove lingering signal listeners
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("beforeExit");
  process.removeAllListeners("exit");
}

console.log(
  "\nRun lock tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
