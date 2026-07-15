import { ProxyAgent } from "undici";
import { env } from "../config/env.js";
import type { ListingDetail } from "../models/listing.js";
import type {
  TelegramSendResult,
  TelegramNotificationSummary,
} from "../models/telegram.js";
import { sleep } from "../utils/helpers.js";

// ── HTML escaping ──────────────────────────────────────────────────────────

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Number / currency formatting ───────────────────────────────────────────

export function formatNumber(value: number | null): string | null {
  if (value == null) return null;
  return new Intl.NumberFormat("en-CA").format(value);
}

export function formatCurrency(value: number | null): string | null {
  if (value == null) return null;
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(value);
}

// ── Message formatting ─────────────────────────────────────────────────────

export function formatNewListingMessage(listing: ListingDetail): string {
  const lines: string[] = [];
  const e = escapeTelegramHtml;

  lines.push("\uD83D\uDD35 <b>New Property</b>");

  if (listing.price != null) {
    const formatted = formatCurrency(listing.price);
    if (formatted) lines.push("\n\uD83D\uDCB0 <b>Price:</b> " + e(formatted));
  }

  if (listing.propertyType) {
    lines.push("\n\uD83C\uDFE0 <b>Type:</b> " + e(listing.propertyType));
  }

  if (listing.address) {
    lines.push("\n\uD83D\uDCCD <b>Address:</b> " + e(listing.address));
  }

  if (listing.bedrooms != null) {
    lines.push("\n\uD83D\uDECF <b>Bedrooms:</b> " + String(listing.bedrooms));
  }

  if (listing.bathrooms != null) {
    lines.push("\n\uD83D\uDEC1 <b>Bathrooms:</b> " + String(listing.bathrooms));
  }

  if (listing.livingArea != null) {
    lines.push(
      "\n\uD83D\uDCD0 <b>Living area:</b> " +
        e(formatNumber(listing.livingArea) ?? String(listing.livingArea)) +
        " sq. ft.",
    );
  }

  if (listing.parking) {
    lines.push("\n\uD83D\uDE97 <b>Parking:</b> " + e(listing.parking));
  }

  if (listing.yearBuilt != null) {
    lines.push("\n\uD83C\uDFD7 <b>Year built:</b> " + String(listing.yearBuilt));
  }

  if (listing.municipalTax != null) {
    const formatted = formatCurrency(listing.municipalTax);
    if (formatted) {
      lines.push("\n\uD83D\uDCB5 <b>Municipal tax:</b> " + e(formatted));
    }
  }

  if (listing.schoolTax != null) {
    const formatted = formatCurrency(listing.schoolTax);
    if (formatted) {
      lines.push("\n\uD83C\uDF93 <b>School tax:</b> " + e(formatted));
    }
  }

  if (listing.condoFees != null) {
    const formatted = formatCurrency(listing.condoFees);
    if (formatted) {
      lines.push("\n\uD83C\uDFE2 <b>Condo fees:</b> " + e(formatted));
    }
  }

  if (listing.brokerName) {
    lines.push("\n\uD83D\uDC64 <b>Broker:</b> " + e(listing.brokerName));
  }

  if (listing.brokerPhone) {
    lines.push("\n\uD83D\uDCDE <b>Phone:</b> " + e(listing.brokerPhone));
  }

  if (listing.agencyName) {
    lines.push("\n\uD83C\uDFE2 <b>Agency:</b> " + e(listing.agencyName));
  }

  const sanitizedUrl = escapeTelegramHtml(listing.url);
  if (/^https?:\/\//.test(listing.url)) {
    lines.push('\n\n\uD83D\uDD17 <a href="' + sanitizedUrl + '">View on Centris</a>');
  } else {
    lines.push("\n\n\uD83D\uDD17 " + sanitizedUrl);
  }

  lines.push("\n\uD83D\uDD18 <b>Listing ID:</b> " + e(listing.listingId));

  return lines.join("");
}

// ── NEW listing selection ───────────────────────────────────────────────────

export function selectNewListings(
  details: readonly ListingDetail[],
  newListingIds: readonly string[],
): ListingDetail[] {
  const idSet = new Set(newListingIds);
  const seen = new Set<string>();
  const listings: ListingDetail[] = [];

  for (const detail of details) {
    if (idSet.has(detail.listingId) && !seen.has(detail.listingId)) {
      seen.add(detail.listingId);
      listings.push(detail);
    }
  }

  return listings;
}

function findMissingNewListingIds(
  details: readonly ListingDetail[],
  newListingIds: readonly string[],
): string[] {
  const currentIds = new Set(details.map((detail) => detail.listingId));
  return newListingIds.filter((id) => !currentIds.has(id));
}

// ── Proxy helper ────────────────────────────────────────────────────────────

let _proxyAgent: ProxyAgent | null | undefined;

function maybeGetDispatcher(): { dispatcher?: ProxyAgent } {
  if (_proxyAgent !== undefined) {
    return _proxyAgent ? { dispatcher: _proxyAgent } : {};
  }
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "";
  if (!proxyUrl) {
    _proxyAgent = null;
    return {};
  }
  _proxyAgent = new ProxyAgent(proxyUrl);
  return { dispatcher: _proxyAgent };
}

// ── Send one message ───────────────────────────────────────────────────────

export interface TelegramMessageSendResult {
  messageId: number;
  attempts: number;
  retries: number;
  totalDelayMs: number;
}

export interface TelegramRetryInfo {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface TelegramMessageOptions {
  parseMode?: string;
  onRetry?: (info: TelegramRetryInfo) => void | Promise<void>;
}

export interface NotifyNewListingsOptions {
  readonly onRetry?: (
    info: TelegramRetryInfo & { readonly listingId: string },
  ) => void | Promise<void>;
}

// Telegram retry metrics cover message-send attempts only.
// Apps Script acknowledgements are part of the Sheet acknowledgement path and are excluded.

export async function sendTelegramMessage(
  text: string,
  options?: TelegramMessageOptions,
): Promise<TelegramMessageSendResult> {
  const chatId = env.telegramChatId;
  if (!chatId) {
    throw new Error("Telegram chat ID not configured");
  }
  return sendTelegramMessageToChat(chatId, text, options);
}

export async function sendTelegramMessageToChat(
  chatId: string,
  text: string,
  options?: TelegramMessageOptions,
): Promise<TelegramMessageSendResult> {
  const token = env.telegramBotToken;
  if (!token) {
    throw new Error("Telegram bot token not configured");
  }

  const url = new URL("/bot" + token + "/sendMessage", "https://api.telegram.org");

  const maxAttempts = 1 + env.telegramMaxRetries;
  let totalDelayMs = 0;

  const waitBeforeRetry = async (
    attempt: number,
    delayMs: number,
    reason: string,
  ): Promise<void> => {
    totalDelayMs += delayMs;
    await options?.onRetry?.({
      attempt: attempt + 1,
      maxAttempts,
      delayMs,
      reason,
    });
    await sleep(delayMs);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      timeoutId = setTimeout(function () {
        controller.abort();
      }, 15000);

      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
      };

      if (options?.parseMode) {
        body.parse_mode = options.parseMode;
        body.link_preview_options = { is_disabled: true };
      }

      const dispatcher = maybeGetDispatcher();
      const fetchOpts: Record<string, unknown> = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      };
      if (dispatcher.dispatcher) {
        fetchOpts.dispatcher = dispatcher.dispatcher;
      }

      const response = await fetch(url.toString(), fetchOpts);

      clearTimeout(timeoutId);
      timeoutId = undefined;

      const responseText = await response.text();

      let safeBody: Record<string, unknown> | undefined;
      try {
        safeBody = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        safeBody = undefined;
      }

      if (response.ok && safeBody?.ok === true) {
        const result = safeBody.result as Record<string, unknown> | undefined;
        if (result && typeof result.message_id === "number") {
          return {
            messageId: result.message_id,
            attempts: attempt,
            retries: attempt - 1,
            totalDelayMs,
          };
        }
      }

      const errorCode =
        typeof safeBody?.error_code === "number" ? safeBody.error_code : null;
      const description =
        typeof safeBody?.description === "string"
          ? safeBody.description
          : "HTTP " + String(response.status) + " (non-JSON response)";

      console.warn(
        "[telegram] attempt " +
          String(attempt) +
          " HTTP " +
          String(response.status) +
          (errorCode !== null ? " error_code=" + String(errorCode) : "") +
          " " +
          description,
      );

      const shouldRetry = shouldRetryError(
        errorCode,
        response.status,
        attempt,
        maxAttempts,
      );

      if (!shouldRetry) {
        throw new TelegramSendError(errorCode, description, attempt, totalDelayMs);
      }

      if (errorCode === 429 && safeBody?.parameters) {
        const params = safeBody.parameters as Record<string, unknown>;
        const retryAfter = params.retry_after;
        if (typeof retryAfter === "number") {
          const waitMs = Math.min(retryAfter * 1000, 30000);
          console.warn("[telegram] rate limited (429), waiting " + String(waitMs) + "ms");
          await waitBeforeRetry(attempt, waitMs, "retry_after");
          continue;
        }
      }

      await waitBeforeRetry(attempt, env.telegramRetryDelayMs, description);
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);

      if (err instanceof TelegramSendError) throw err;

      const msg = err instanceof Error ? err.message : "Unknown error";
      console.warn("[telegram] attempt " + String(attempt) + " failed: " + msg);

      if (attempt < maxAttempts) {
        console.warn("[telegram] retrying...");
        await waitBeforeRetry(attempt, env.telegramRetryDelayMs, msg);
        continue;
      }

      throw new TelegramSendError(
        null,
        "Telegram send failed after " + String(maxAttempts) + " attempts: " + msg,
        attempt,
        totalDelayMs,
      );
    }
  }

  throw new TelegramSendError(
    null,
    "Telegram send failed after " + String(maxAttempts) + " attempts",
    maxAttempts,
    totalDelayMs,
  );
}

function shouldRetryError(
  errorCode: number | null,
  httpStatus: number,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (attempt >= maxAttempts) return false;
  if (errorCode === null && httpStatus >= 400 && httpStatus < 500) return false;
  if (errorCode === null) return true;
  if (errorCode === 429) return true;
  if (errorCode >= 500 && errorCode < 600) return true;
  return false;
}

class TelegramSendError extends Error {
  readonly errorCode: number | null;
  readonly attempts: number;
  readonly retries: number;
  readonly totalDelayMs: number;

  constructor(
    errorCode: number | null,
    description: string,
    attempts: number,
    totalDelayMs: number,
  ) {
    const msg =
      errorCode !== null
        ? "Telegram API error " + String(errorCode) + ": " + description
        : "Telegram API error: " + description;
    super(msg);
    this.name = "TelegramSendError";
    this.errorCode = errorCode;
    this.attempts = attempts;
    this.retries = Math.max(0, attempts - 1);
    this.totalDelayMs = totalDelayMs;
  }
}

// ── Startup logging ────────────────────────────────────────────────────────

let _proxyLogged = false;

function logProxyConfig(): void {
  if (_proxyLogged) return;
  _proxyLogged = true;
  const url = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "";
  console.log("Telegram proxy: " + (url ? "configured" : "direct"));
}

// ── Batch notification ─────────────────────────────────────────────────────

export async function notifyNewListings(
  details: readonly ListingDetail[],
  newListingIds: readonly string[],
  options: NotifyNewListingsOptions = {},
): Promise<TelegramNotificationSummary> {
  if (newListingIds.length === 0) {
    console.log("No new listings to notify.");
    return {
      requested: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      retries: 0,
      retryDelayMs: 0,
      retriedListings: 0,
      maxAttemptsUsed: 0,
      results: [],
    };
  }

  if (!env.telegramEnabled) {
    console.log("Telegram notifications disabled.");
    return {
      requested: newListingIds.length,
      sent: 0,
      failed: 0,
      skipped: newListingIds.length,
      retries: 0,
      retryDelayMs: 0,
      retriedListings: 0,
      maxAttemptsUsed: 0,
      results: [],
    };
  }

  const listings = selectNewListings(details, newListingIds);
  const missingNewListingIds = findMissingNewListingIds(details, newListingIds);
  const skipped = missingNewListingIds.length;

  if (missingNewListingIds.length > 0) {
    console.warn(
      "[telegram] " +
        String(skipped) +
        " new listing ID(s) from sync had no matching detail (ignored)",
    );
  }

  logProxyConfig();

  const results: TelegramSendResult[] = [];
  let retries = 0;
  let retryDelayMs = 0;
  let retriedListings = 0;
  let maxAttemptsUsed = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const message = formatNewListingMessage(listing);

    try {
      const sendResult = await sendTelegramMessage(message, {
        parseMode: env.telegramParseMode,
        onRetry: (info) => options.onRetry?.({ ...info, listingId: listing.listingId }),
      });
      retries += sendResult.retries;
      retryDelayMs += sendResult.totalDelayMs;
      maxAttemptsUsed = Math.max(maxAttemptsUsed, sendResult.attempts);
      if (sendResult.retries > 0) retriedListings++;
      results.push({
        listingId: listing.listingId,
        success: true,
        messageId: sendResult.messageId,
        attempts: sendResult.attempts,
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      console.warn("[telegram] listing " + listing.listingId + " failed: " + error);
      const attempts = err instanceof TelegramSendError ? err.attempts : 1;
      const listingRetries = err instanceof TelegramSendError ? err.retries : 0;
      const listingDelayMs = err instanceof TelegramSendError ? err.totalDelayMs : 0;
      retries += listingRetries;
      retryDelayMs += listingDelayMs;
      maxAttemptsUsed = Math.max(maxAttemptsUsed, attempts);
      if (listingRetries > 0) retriedListings++;
      results.push({
        listingId: listing.listingId,
        success: false,
        messageId: null,
        attempts,
        error,
      });
    }

    if (i < listings.length - 1 && env.telegramSendDelayMs > 0) {
      await sleep(env.telegramSendDelayMs);
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    requested: listings.length,
    sent,
    failed,
    skipped,
    retries,
    retryDelayMs,
    retriedListings,
    maxAttemptsUsed,
    results,
  };
}
