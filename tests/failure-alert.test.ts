import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  escapeFailureAlertHtml,
  formatFailureAlert,
  sendFailureAlert,
} from "../src/services/failure-alert.js";

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

const directory = await mkdtemp(join(tmpdir(), "centris-failure-alert-"));
const statePath = join(directory, "failure-alert-state.json");
const input = {
  runId: "run<1>",
  stage: "sheet-sync",
  error: "unexpected <failure> & details",
  occurredAt: "2026-07-14T12:00:00.000Z",
};

try {
  assert(
    escapeFailureAlertHtml('<tag>&"') === "&lt;tag&gt;&amp;&quot;",
    "failure alert HTML is escaped",
  );
  assert(
    formatFailureAlert(input).includes("run&lt;1&gt;"),
    "formatted alert escapes the run ID",
  );

  const disabled = await sendFailureAlert(
    input,
    { enabled: false, chatId: "-100123", cooldownMs: 60_000, statePath },
    { send: async () => undefined },
  );
  assert(disabled === "disabled", "disabled alerts do not send");

  const sentMessages: string[] = [];
  const first = await sendFailureAlert(
    input,
    { enabled: true, chatId: "-100123", cooldownMs: 60_000, statePath },
    {
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      send: async (_chatId, text) => {
        sentMessages.push(text);
      },
      info: () => undefined,
    },
  );
  assert(first === "sent", "first critical failure sends an alert");
  assert(sentMessages.length === 1, "first alert sends exactly once");

  const suppressed = await sendFailureAlert(
    input,
    { enabled: true, chatId: "-100123", cooldownMs: 60_000, statePath },
    {
      now: () => new Date("2026-07-14T12:00:30.000Z"),
      send: async (_chatId, text) => {
        sentMessages.push(text);
      },
      info: () => undefined,
    },
  );
  assert(suppressed === "suppressed", "cooldown suppresses repeated alerts");
  assert(sentMessages.length === 1, "suppressed alert does not send");

  const afterCooldown = await sendFailureAlert(
    input,
    { enabled: true, chatId: "-100123", cooldownMs: 60_000, statePath },
    {
      now: () => new Date("2026-07-14T12:01:00.000Z"),
      send: async (_chatId, text) => {
        sentMessages.push(text);
      },
      info: () => undefined,
    },
  );
  assert(afterCooldown === "sent", "alert sends after cooldown expires");
  assert(sentMessages.length === 2, "post-cooldown alert sends once");

  const differentFailure = await sendFailureAlert(
    { ...input, stage: "search" },
    { enabled: true, chatId: "-100123", cooldownMs: 60_000, statePath },
    {
      now: () => new Date("2026-07-14T12:01:30.000Z"),
      send: async (_chatId, text) => {
        sentMessages.push(text);
      },
      info: () => undefined,
    },
  );
  assert(differentFailure === "sent", "different failure fingerprint bypasses cooldown");
  assert(sentMessages.length === 3, "different failure sends immediately");

  const failedSend = await sendFailureAlert(
    input,
    {
      enabled: true,
      chatId: "-100123",
      cooldownMs: 60_000,
      statePath: join(directory, "failed-state.json"),
    },
    {
      send: async () => {
        throw new Error("network unavailable");
      },
      warn: () => undefined,
      info: () => undefined,
    },
  );
  assert(failedSend === "failed", "alert delivery errors do not throw");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(
  "\nFailure alert tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
