import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHealthStore } from "../src/health/health-store.js";

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

const directory = await mkdtemp(join(tmpdir(), "centris-health-store-"));
const path = join(directory, "health.json");
const now = () => new Date("2026-07-15T12:00:00.000Z");

try {
  const store = createHealthStore({ path }, { now });
  await store.set("sheets", {
    status: "unhealthy",
    error: new Error("authorization: bearer-token unavailable"),
  });
  const check = await store.get("sheets");
  assert(check?.status === "unhealthy", "persists component health");
  assert(
    check?.error === "authorization:[redacted] unavailable",
    "sanitizes stored health errors",
  );

  await store.set("sheets", { status: "healthy", error: "old error" });
  assert((await store.get("sheets"))?.error === null, "healthy checks clear prior errors");

  await writeFile(path, "{}", "utf8");
  const recovered = await store.read();
  assert(Object.keys(recovered.checks).length === 0, "recovers from invalid health snapshots");
  const files = await readdir(directory);
  assert(
    files.some((file) => /^health\.corrupt\.\d+\.json$/.test(file)),
    "renames invalid health storage",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(
  "\nHealth store tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
