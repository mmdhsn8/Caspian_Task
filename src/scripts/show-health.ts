import { access } from "node:fs/promises";
import { HealthStore } from "../health/health-store.js";
import { env } from "../config/env.js";

try {
  await access(env.healthReportPath);
} catch {
  throw new Error("Health report does not exist: " + env.healthReportPath);
}
const report = await new HealthStore({
  path: env.healthReportPath,
  enabled: env.healthReportEnabled,
}).load();
console.log("Status: " + report.status);
console.log("Last run: " + (report.lastRun.runId ?? "none"));
console.log("Last success: " + (report.lastSuccessAt ?? "none"));
console.log("Last failure: " + (report.lastFailureAt ?? "none"));
console.log("Consecutive failures: " + String(report.consecutiveFailures));
console.log("Scheduler: " + (report.scheduler.running ? "running" : "stopped"));
console.log("Next run: " + (report.scheduler.nextRunAt ?? "none"));
console.log(
  "Active run: " +
    (report.activeRun.active ? (report.activeRun.runId ?? "unknown") : "none"),
);
console.log("Cache entries: " + String(report.cache.entries));
console.log(
  "Last cache hit rate: " + (report.cache.hitRateLastRun * 100).toFixed(1) + "%",
);
