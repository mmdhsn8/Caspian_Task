import { env } from "../config/env.js";
import {
  executeWithRetry,
  isRetryableNetworkError,
  type RetryResult,
} from "../resilience/retry-policy.js";
import {
  type ListingDetail,
  SCRAPER_ROW_LENGTH,
  detailToRow,
} from "../models/listing.js";

const OPTIONAL_SHEET_FIELD_INDICES = new Set<number>([
  4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
]);

function toOptionalSheetFallback(
  value: string | number | null | undefined,
): string | number {
  if (value == null) return "N/A";
  if (typeof value === "string") {
    return value.trim().length === 0 ? "N/A" : value;
  }
  return value;
}

function applySheetPresentationFallbacks(
  row: readonly (string | number | null)[],
): (string | number)[] {
  return row.map((value, index) =>
    OPTIONAL_SHEET_FIELD_INDICES.has(index)
      ? toOptionalSheetFallback(value)
      : (value ?? ""),
  );
}

export interface SheetSyncResult {
  success: true;
  received: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  totalStored: number;
  newListingIds: string[];
  updatedListingIds: string[];
  pendingTelegramListingIds: string[];
  checkedAt: string;
}

export interface TelegramAckItem {
  listingId: string;
  success: boolean;
  messageId: string | number | null;
  attempts: number;
  error: string | null;
  sentAt: string | null;
}

export interface AppsScriptRetryInfo {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface AppsScriptRequestMetrics {
  readonly attempts: number;
  readonly retries: number;
  readonly totalDelayMs: number;
}

export interface AppsScriptRequestOptions {
  readonly onRetry?: (info: AppsScriptRetryInfo) => void | Promise<void>;
  readonly onComplete?: (metrics: AppsScriptRequestMetrics) => void | Promise<void>;
}

export interface TelegramAckOptions extends AppsScriptRequestOptions {
  readonly throwOnError?: boolean;
}

export interface TelegramAckResult {
  readonly updatedCount: number;
  readonly notFoundCount: number;
}

interface AppsScriptResponse extends Record<string, unknown> {
  readonly success: boolean;
  readonly error?: unknown;
  readonly code?: unknown;
}

class AppsScriptAcknowledgementError extends Error {
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, code: string | null, retryable: boolean) {
    super(message);
    this.name = "AppsScriptAcknowledgementError";
    this.code = code;
    this.retryable = retryable;
  }
}

function formatAppsScriptFailure(data: AppsScriptResponse): {
  readonly code: string | null;
  readonly message: string;
} {
  const code =
    typeof data.code === "string" && data.code.trim().length > 0 ? data.code : null;
  const reason =
    typeof data.error === "string" && data.error.trim().length > 0
      ? data.error.trim()
      : "Apps Script returned success=false";
  return {
    code,
    message: code ? code + ": " + reason : reason,
  };
}

function isRetryableAckFailure(error: unknown): boolean {
  if (error instanceof AppsScriptAcknowledgementError) {
    return error.retryable;
  }
  return isRetryableNetworkError(error);
}

function sanitize(detail: ListingDetail): ListingDetail {
  const emptyToNull = (v: string | null | undefined): string | null =>
    v == null || v === "" ? null : v;

  return {
    ...detail,
    brokerId: emptyToNull(detail.brokerId),
    brokerName: emptyToNull(detail.brokerName),
    brokerPhone: emptyToNull(detail.brokerPhone),
    brokerProfileUrl: emptyToNull(detail.brokerProfileUrl),
    agencyName: emptyToNull(detail.agencyName),
    parking: emptyToNull(detail.parking),
  };
}

function buildAppsScriptUrl(): string {
  if (!env.googleAppsScriptUrl) {
    throw new Error("Google Apps Script not configured. Set GOOGLE_APPS_SCRIPT_URL.");
  }
  return env.googleAppsScriptKey
    ? `${env.googleAppsScriptUrl}?key=${encodeURIComponent(env.googleAppsScriptKey)}`
    : env.googleAppsScriptUrl;
}

async function postToAppsScript(
  body: Record<string, unknown>,
  options: AppsScriptRequestOptions = {},
): Promise<Record<string, unknown>> {
  const result = await postToAppsScriptRaw(body, options);
  const data = result.value;
  if (!data.success) {
    const failure = formatAppsScriptFailure(data);
    throw new Error(failure.message);
  }
  return data;
}

async function postToAppsScriptRaw(
  body: Record<string, unknown>,
  options: AppsScriptRequestOptions = {},
): Promise<RetryResult<AppsScriptResponse>> {
  const url = buildAppsScriptUrl();

  const result = await executeWithRetry(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(
          `Apps Script returned HTTP ${String(response.status)}: ${await response.text()}`,
        );
      }
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result == null ||
        !("success" in result) ||
        typeof (result as Record<string, unknown>).success !== "boolean"
      ) {
        throw new Error("Apps Script returned an unexpected response");
      }
      return result as AppsScriptResponse;
    },
    {
      maxAttempts: env.sheetRetryMaxAttempts,
      baseDelayMs: env.retryBaseDelayMs,
      maxDelayMs: env.retryMaxDelayMs,
      jitterRatio: env.retryJitterRatio,
    },
    {
      operation: "Google Apps Script request",
      shouldRetry: (error) => isRetryableNetworkError(error),
      onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
        options.onRetry?.({ attempt, maxAttempts, delayMs, error }),
    },
  );
  await options.onComplete?.({
    attempts: result.attempts,
    retries: result.retries,
    totalDelayMs: result.totalDelayMs,
  });
  return result;
}

export async function syncDetailsToSheet(
  details: readonly ListingDetail[],
  options: AppsScriptRequestOptions = {},
): Promise<SheetSyncResult> {
  if (!env.googleAppsScriptUrl) {
    throw new Error("Google Apps Script not configured. Set GOOGLE_APPS_SCRIPT_URL.");
  }

  const checkedAt = new Date().toISOString();

  const rows = details.map((d) => {
    const sanitized = sanitize(d);
    const row = applySheetPresentationFallbacks(detailToRow(sanitized));
    if (row.length !== SCRAPER_ROW_LENGTH) {
      throw new Error(
        `Row has ${String(row.length)} columns but expected ${String(SCRAPER_ROW_LENGTH)}. ` +
          "Update detailToRow to match.",
      );
    }
    return row;
  });

  console.log(`Syncing ${String(rows.length)} listings to Google Sheet...`);

  const data = await postToAppsScript(
    {
      action: "sync",
      checkedAt,
      rows,
    },
    options,
  );

  return data as unknown as SheetSyncResult;
}

export async function acknowledgeTelegramResults(
  results: readonly TelegramAckItem[],
  options: TelegramAckOptions = {},
): Promise<TelegramAckResult> {
  if (results.length === 0) {
    return { updatedCount: 0, notFoundCount: 0 };
  }

  if (!env.googleAppsScriptUrl) {
    console.warn("[sheets] Cannot acknowledge Telegram: Apps Script not configured.");
    return { updatedCount: 0, notFoundCount: results.length };
  }

  try {
    const payload = {
      action: "ackTelegram",
      results: results.map((r) => ({
        listingId: r.listingId,
        success: r.success,
        messageId: r.messageId,
        attempts: r.attempts,
        error: r.error,
        sentAt: r.sentAt,
      })),
    };
    const response = await executeWithRetry(
      async () => {
        const data = (await postToAppsScriptRaw(payload)).value;
        if (!data.success) {
          const failure = formatAppsScriptFailure(data);
          throw new AppsScriptAcknowledgementError(failure.message, failure.code, true);
        }
        return data;
      },
      {
        maxAttempts: env.sheetRetryMaxAttempts,
        baseDelayMs: env.retryBaseDelayMs,
        maxDelayMs: env.retryMaxDelayMs,
        jitterRatio: env.retryJitterRatio,
      },
      {
        operation: "Google Apps Script acknowledgement",
        shouldRetry: (error) => isRetryableAckFailure(error),
        onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
          options.onRetry?.({ attempt, maxAttempts, delayMs, error }),
      },
    );
    await options.onComplete?.({
      attempts: response.attempts,
      retries: response.retries,
      totalDelayMs: response.totalDelayMs,
    });
    const data = response.value;

    const updated: number = typeof data.updatedCount === "number" ? data.updatedCount : 0;
    const notFound: number =
      typeof data.notFoundCount === "number" ? data.notFoundCount : 0;
    console.log(
      "[sheets] Telegram ack: " +
        String(updated) +
        " updated, " +
        String(notFound) +
        " not found",
    );

    if (notFound > 0) {
      console.warn(
        "[sheets] " + String(notFound) + " acknowledgement target(s) not found in sheet",
      );
    }
    return { updatedCount: updated, notFoundCount: notFound };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[sheets] Telegram acknowledgement failed: " + msg);
    console.warn(
      "[sheets] Delivery state not saved — listings may be resent next run (at-least-once delivery)",
    );
    if (options.throwOnError) throw err;
    return { updatedCount: 0, notFoundCount: 0 };
  }
}
