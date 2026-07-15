import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";
import { sendTelegramMessageToChat } from "./telegram.js";

const MAX_ERROR_LENGTH = 1800;

export interface FailureAlertConfig {
  readonly enabled: boolean;
  readonly chatId: string | undefined;
  readonly cooldownMs: number;
  readonly statePath: string;
}

export interface FailureAlertInput {
  readonly runId: string;
  readonly stage: string;
  readonly error: string;
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly nextRetryAt?: string;
}

interface FailureAlertState {
  readonly lastAlertAt: string;
  readonly fingerprint?: string;
}

export type FailureAlertResult = "disabled" | "suppressed" | "sent" | "failed";

export interface FailureAlertDependencies {
  readonly now?: () => Date;
  readonly send?: (chatId: string, text: string) => Promise<unknown>;
  readonly warn?: (message: string) => void;
  readonly info?: (message: string) => void;
}

export function escapeFailureAlertHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatFailureAlert(input: FailureAlertInput): string {
  const error =
    input.error.length > MAX_ERROR_LENGTH
      ? input.error.slice(0, MAX_ERROR_LENGTH) + "..."
      : input.error;
  return [
    "<b>Centris scraper failure</b>",
    "<b>Run:</b> " + escapeFailureAlertHtml(input.runId),
    "<b>Stage:</b> " + escapeFailureAlertHtml(input.stage),
    "<b>Time:</b> " + escapeFailureAlertHtml(input.occurredAt),
    input.durationMs === undefined
      ? ""
      : "<b>Duration:</b> " + String(input.durationMs) + "ms",
    "<b>Error:</b> " + escapeFailureAlertHtml(error),
    "<b>Next scheduler retry:</b> " +
      escapeFailureAlertHtml(
        input.nextRetryAt ?? "on the next fixed-delay scheduler run",
      ),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function createFailureAlertFingerprint(input: FailureAlertInput): string {
  return createHash("sha256")
    .update(input.stage)
    .update("\u0000")
    .update(input.error)
    .digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readState(statePath: string): Promise<FailureAlertState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).lastAlertAt === "string"
    ) {
      return value as FailureAlertState;
    }
  } catch (error) {
    if (!isMissing(error)) return null;
  }
  return null;
}

function isCoolingDown(
  state: FailureAlertState | null,
  fingerprint: string,
  now: Date,
  cooldownMs: number,
): boolean {
  if (!state) return false;
  const lastAlertAt = Date.parse(state.lastAlertAt);
  return (
    state.fingerprint === fingerprint &&
    Number.isFinite(lastAlertAt) &&
    now.getTime() - lastAlertAt < cooldownMs
  );
}

function readMessageId(result: unknown): number | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "messageId" in result &&
    typeof (result as { messageId?: unknown }).messageId === "number"
  ) {
    return (result as { messageId: number }).messageId;
  }
  return null;
}

async function writeState(statePath: string, state: FailureAlertState): Promise<void> {
  const directory = dirname(statePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = statePath + "." + String(process.pid) + ".tmp";
  await writeFile(temporaryPath, JSON.stringify(state), "utf8");
  await rename(temporaryPath, statePath);
}

export async function sendFailureAlert(
  input: FailureAlertInput,
  config: FailureAlertConfig,
  dependencies: FailureAlertDependencies = {},
): Promise<FailureAlertResult> {
  if (!config.enabled || !config.chatId) return "disabled";
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) {
    throw new Error("FAILURE_ALERT_COOLDOWN_MINUTES must not be negative");
  }

  const now = dependencies.now ?? (() => new Date());
  const statePath = resolve(config.statePath);
  const state = await readState(statePath);
  const sentAt = now();
  const fingerprint = createFailureAlertFingerprint(input);
  if (isCoolingDown(state, fingerprint, sentAt, config.cooldownMs)) return "suppressed";

  const send =
    dependencies.send ??
    ((chatId: string, text: string) =>
      sendTelegramMessageToChat(chatId, text, { parseMode: "HTML" }));
  const warn =
    dependencies.warn ??
    ((message: string): void => {
      console.warn(message);
    });
  const info =
    dependencies.info ??
    ((message: string): void => {
      console.log(message);
    });

  try {
    const sendResult = await send(config.chatId, formatFailureAlert(input));
    await writeState(statePath, {
      lastAlertAt: sentAt.toISOString(),
      fingerprint,
    });
    const messageId = readMessageId(sendResult);
    info(
      "[failure-alert] sent" +
        (messageId === null ? "" : " messageId=" + String(messageId)),
    );
    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn("[failure-alert] delivery failed: " + message);
    return "failed";
  }
}

export async function sendConfiguredFailureAlert(
  input: FailureAlertInput,
): Promise<FailureAlertResult> {
  return sendFailureAlert(input, {
    enabled: env.failureAlertsEnabled,
    chatId: env.telegramAlertChatId ?? env.telegramChatId,
    cooldownMs: env.failureAlertCooldownMinutes * 60_000,
    statePath: ".runtime/failure-alert-state.json",
  });
}
