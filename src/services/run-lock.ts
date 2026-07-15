import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname, resolve } from "node:path";

const OWNER_FILE = "owner.json";

export interface RunLockConfig {
  readonly enabled: boolean;
  readonly path: string;
  readonly staleAfterMs: number;
  readonly trigger?: string;
}

export interface RunLockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly trigger: string;
  readonly token: string;
  readonly processStartTime: string;
}

export interface RunLock {
  readonly path: string;
  release(): Promise<void>;
}

export type RunLockAcquireResult =
  | {
      readonly acquired: true;
      readonly lock: RunLock;
      readonly recoveredStaleLock: boolean;
      readonly recoveredCorruptLock: boolean;
    }
  | {
      readonly acquired: false;
      readonly owner: RunLockOwner | null;
      readonly reason: "disabled" | "held";
    };

// ── Internal helpers ─────────────────────────────────────────────────────────

function ownerPath(lockPath: string): string {
  return resolve(lockPath, OWNER_FILE);
}

export function describeRunLockOwner(owner: RunLockOwner | null): string {
  if (!owner) return "owner metadata unavailable";
  return (
    "pid=" +
    String(owner.pid) +
    " hostname=" +
    owner.hostname +
    " acquiredAt=" +
    owner.acquiredAt +
    " trigger=" +
    owner.trigger +
    " processStartTime=" +
    owner.processStartTime
  );
}

function createToken(): string {
  return (
    String(process.pid) +
    "-" +
    String(Date.now()) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// ── PID aliveness ────────────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

/** On Windows, double-check that the PID belongs to a node process (guards against PID reuse). */
export function isNodeProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  try {
    const result = spawnSync(
      "tasklist",
      ["/FO", "CSV", "/NH", "/FI", "PID eq " + String(pid)],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    if (result.status !== 0 || !result.stdout) return false;
    for (const line of result.stdout.split(/\r?\n/)) {
      const cells = line.replace(/""/g, "").split('","');
      if (cells.length >= 2) {
        const name = cells[0].replace(/^"+/, "").toLowerCase();
        // Accept node.exe, node, and common JS runtimes
        if (name.includes("node") || name.includes("deno") || name.includes("bun"))
          return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── Process start time ───────────────────────────────────────────────────────

/** Returns the absolute start time of the current process as an ISO string. */
export function getCurrentProcessStartTime(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** Query the start time of another process by PID (best-effort, platform-specific). */
export function queryRemoteProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const out = spawnSync(
        "wmic",
        [
          "process",
          "where",
          "processid=" + String(pid),
          "get",
          "creationdate",
          "/FORMAT:VALUE",
        ],
        { encoding: "utf8", timeout: 3000, windowsHide: true },
      );
      if (out.status === 0) {
        const re =
          /CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d+)/;
        const m = re.exec(out.stdout);
        if (m) {
          const year = parseInt(m[1], 10);
          const month = parseInt(m[2], 10) - 1;
          const day = parseInt(m[3], 10);
          const hour = parseInt(m[4], 10);
          const min = parseInt(m[5], 10);
          const sec = parseInt(m[6], 10);
          const ms = parseInt(m[7].substring(0, 3).padEnd(3, "0"), 10);
          const offsetMin = parseInt(m[8], 10); // +270 means UTC+4:30
          // WMIC returns local time; convert to UTC by subtracting the offset
          return new Date(
            Date.UTC(year, month, day, hour, min, sec, ms) - offsetMin * 60000,
          ).toISOString();
        }
      }
      return null;
    }
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (out.status === 0) {
      const line = out.stdout.trim();
      if (line) {
        const d = new Date(line);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Lock age ─────────────────────────────────────────────────────────────────

async function lockAgeMs(lockPath: string, owner: RunLockOwner | null): Promise<number> {
  const acquiredAt = owner ? Date.parse(owner.acquiredAt) : Number.NaN;
  if (Number.isFinite(acquiredAt)) return Math.max(0, Date.now() - acquiredAt);
  try {
    const metadata = await stat(lockPath);
    return Math.max(0, Date.now() - metadata.mtimeMs);
  } catch {
    return 0;
  }
}

// ── Staleness detection ──────────────────────────────────────────────────────

export interface StalenessResult {
  readonly stale: boolean;
  readonly reason: string;
}

/**
 * Determine whether a lock should be considered stale.
 *
 * Order of checks (early-exit):
 *  1. Owner.json missing / corrupt → stale when directory is old enough,
 *     otherwise the caller treats it as corrupt.
 *  2. PID dead via process.kill(pid,0) → stale.
 *  3. On Windows, PID does not belong to a node process → stale (PID reuse).
 *  4. processStartTime mismatch → stale (PID reuse without a new node process).
 *  5. Lock age exceeds staleAfterMs timeout → stale.
 *  6. Otherwise → active.
 */
async function checkStale(
  lockPath: string,
  owner: RunLockOwner | null,
  staleAfterMs: number,
): Promise<StalenessResult> {
  if (!owner) {
    const age = await lockAgeMs(lockPath, null);
    if (age >= staleAfterMs)
      return { stale: true, reason: "owner.json missing, directory old" };
    return { stale: false, reason: "owner.json missing, directory recent" };
  }

  // 1. PID aliveness (cross-platform, fast)
  if (!isProcessAlive(owner.pid)) return { stale: true, reason: "dead process" };

  // 2. On Windows, verify the PID still belongs to a JS runtime (catches PID reuse)
  if (process.platform === "win32" && !isNodeProcess(owner.pid)) {
    return { stale: true, reason: "PID reused (not a node process)" };
  }

  // 3. processStartTime comparison (detect PID reuse on any platform)
  if (owner.processStartTime) {
    const stored = Date.parse(owner.processStartTime);
    if (Number.isFinite(stored)) {
      const actual = queryRemoteProcessStartTime(owner.pid);
      if (actual) {
        const actualMs = Date.parse(actual);
        if (Number.isFinite(actualMs) && Math.abs(stored - actualMs) > 5000) {
          return { stale: true, reason: "PID reused (start time mismatch)" };
        }
      }
    }
  }

  // 4. Age-based timeout
  const age = await lockAgeMs(lockPath, owner);
  if (age >= staleAfterMs)
    return { stale: true, reason: "lock age exceeds stale timeout" };

  return { stale: false, reason: "active" };
}

// ── Lock file operations ─────────────────────────────────────────────────────

async function moveLockAside(lockPath: string, label: string): Promise<boolean> {
  const dest = lockPath + "." + label + "." + String(Date.now());
  try {
    await rename(lockPath, dest);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    await rm(dest, { recursive: true, force: true });
  } catch {
    /* leftover rename target is harmless */
  }
  return true;
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return;
  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readOwner(lockPath: string): Promise<RunLockOwner | null> {
  try {
    const raw = await readFile(ownerPath(lockPath), "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>).pid !== "number" ||
      typeof (value as Record<string, unknown>).hostname !== "string" ||
      typeof (value as Record<string, unknown>).acquiredAt !== "string" ||
      typeof (value as Record<string, unknown>).token !== "string"
    ) {
      return null;
    }
    const obj = value as Record<string, unknown>;
    return {
      pid: obj.pid as number,
      hostname: obj.hostname as string,
      acquiredAt: obj.acquiredAt as string,
      trigger: typeof obj.trigger === "string" ? obj.trigger : "unknown",
      token: obj.token as string,
      processStartTime:
        typeof obj.processStartTime === "string" ? obj.processStartTime : "",
    };
  } catch {
    return null;
  }
}

async function createLock(lockPath: string, trigger: string): Promise<RunLock> {
  await mkdir(lockPath);
  const owner: RunLockOwner = {
    pid: process.pid,
    hostname: getHostname(),
    acquiredAt: new Date().toISOString(),
    trigger,
    token: createToken(),
    processStartTime: getCurrentProcessStartTime(),
  };
  try {
    await writeFile(ownerPath(lockPath), JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  const lock: RunLock = {
    path: lockPath,
    release: async () => {
      await releaseLock(lockPath, owner.token);
      untrackLock(lock);
    },
  };
  return lock;
}

// ── Shutdown auto-release ────────────────────────────────────────────────────

const activeLocks = new Set<RunLock>();
let shutdownHandlersRegistered = false;

function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const releaseAll = (_event: string) => {
    for (const lk of [...activeLocks]) {
      lk.release().catch(() => {
        /* release is best-effort during shutdown */
      });
    }
  };

  // Use synchronous exit handlers for maximum reliability
  const exitHandler = () => {
    for (const lk of [...activeLocks]) {
      try {
        void lk.release();
      } catch {
        /* ignore */
      }
    }
  };

  process.once("SIGINT", () => {
    releaseAll("SIGINT");
  });
  process.once("SIGTERM", () => {
    releaseAll("SIGTERM");
  });
  process.on("beforeExit", exitHandler);
  process.on("exit", exitHandler);
}

function trackLock(lock: RunLock): void {
  activeLocks.add(lock);
  registerShutdownHandlers();
}

function untrackLock(lock: RunLock): void {
  activeLocks.delete(lock);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function acquireRunLock(
  config: RunLockConfig,
): Promise<RunLockAcquireResult> {
  if (!config.enabled) {
    return { acquired: false, owner: null, reason: "disabled" };
  }
  if (!Number.isFinite(config.staleAfterMs) || config.staleAfterMs <= 0) {
    throw new Error("RUN_LOCK_STALE_MINUTES must be greater than zero");
  }

  const lockPath = resolve(config.path);
  await mkdir(dirname(lockPath), { recursive: true });

  // Fast path: no lock yet
  try {
    const lock = await createLock(lockPath, config.trigger ?? "unknown");
    trackLock(lock);
    return {
      acquired: true,
      lock,
      recoveredStaleLock: false,
      recoveredCorruptLock: false,
    };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  // Lock directory exists.  Check owner.json.
  const owner = await readOwner(lockPath);
  let recoverReason = "";

  if (!owner) {
    // The directory exists but owner.json is missing or unparseable → corrupt.
    const moved = await moveLockAside(lockPath, "corrupt");
    if (moved) {
      recoverReason = "corrupt";
    } else {
      // Directory disappeared between stat and rename → avoid TOCTOU.
      try {
        const lock = await createLock(lockPath, config.trigger ?? "unknown");
        trackLock(lock);
        return {
          acquired: true,
          lock,
          recoveredStaleLock: false,
          recoveredCorruptLock: true,
        };
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        return { acquired: false, owner: null, reason: "held" };
      }
    }
  } else {
    const result = await checkStale(lockPath, owner, config.staleAfterMs);
    if (result.stale) {
      const moved = await moveLockAside(lockPath, "stale");
      if (moved) {
        recoverReason = result.reason;
      } else {
        // Someone else grabbed it.
        return { acquired: false, owner: await readOwner(lockPath), reason: "held" };
      }
    } else {
      return { acquired: false, owner, reason: "held" };
    }
  }

  // Recover: create a fresh lock
  try {
    const lock = await createLock(lockPath, config.trigger ?? "unknown");
    trackLock(lock);
    return {
      acquired: true,
      lock,
      recoveredStaleLock: !owner || recoverReason !== "corrupt",
      recoveredCorruptLock: !owner || recoverReason === "corrupt",
    };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return { acquired: false, owner: await readOwner(lockPath), reason: "held" };
  }
}
