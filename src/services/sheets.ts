import { env } from "../config/env.js";
import { executeWithRetry, isRetryableNetworkError } from "../resilience/retry-policy.js";
import {
  type ListingDetail,
  SCRAPER_ROW_LENGTH,
  detailToRow,
} from "../models/listing.js";

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
  messageId: number | null;
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
      const data = result as Record<string, unknown>;
      if (!data.success) throw new Error("Apps Script returned success=false");
      return data;
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
  return result.value;
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
    const row = detailToRow(sanitized);
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
  options: AppsScriptRequestOptions = {},
): Promise<void> {
  if (results.length === 0) return;

  if (!env.googleAppsScriptUrl) {
    console.warn("[sheets] Cannot acknowledge Telegram: Apps Script not configured.");
    return;
  }

  try {
    const data = await postToAppsScript(
      {
        action: "ackTelegram",
        results: results.map((r) => ({
          listingId: r.listingId,
          success: r.success,
          messageId: r.messageId,
          attempts: r.attempts,
          error: r.error,
          sentAt: r.sentAt,
        })),
      },
      options,
    );

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[sheets] Telegram acknowledgement failed: " + msg);
    console.warn(
      "[sheets] Delivery state not saved — listings may be resent next run (at-least-once delivery)",
    );
  }
}
