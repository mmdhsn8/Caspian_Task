import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricsStore } from "../src/metrics/metrics-store.js";

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

const directory = await mkdtemp(join(tmpdir(), "centris-metrics-store-"));
const path = join(directory, "metrics.json");
const now = () => new Date("2026-07-15T12:00:00.000Z");

try {
  const store = createMetricsStore({ path, maxEvents: 1 }, { now });
  const first = await store.increment("runs");
  assert(first.counters.runs === 1, "increments counters");

  const recorded = await store.record({
    name: "failures",
    error: "token=top-secret request failed",
  });
  assert(recorded.counters.failures === 1, "records event values in counters");
  assert(recorded.events.length === 1, "stores events");
  assert(
    recorded.events[0]?.error === "token=[redacted] request failed",
    "redacts sensitive error values",
  );
  const persisted = JSON.parse(await readFile(path, "utf8")) as { counters: Record<string, number> };
  assert(persisted.counters.runs === 1, "writes the snapshot to disk");

  await writeFile(path, "not valid json", "utf8");
  const recovered = await store.read();
  assert(Object.keys(recovered.counters).length === 0, "returns an empty snapshot after corruption");
  const files = await readdir(directory);
  assert(
    files.some((file) => /^metrics\.corrupt\.\d+\.json$/.test(file)),
    "renames corrupt storage before recovery",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(
  "\nMetrics store tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
