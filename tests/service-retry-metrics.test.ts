process.env.GOOGLE_APPS_SCRIPT_URL = "https://script.google.com/mock/exec";
process.env.GOOGLE_APPS_SCRIPT_KEY = "";
process.env.RETRY_BASE_DELAY_MS = "100";
process.env.RETRY_MAX_DELAY_MS = "1000";
process.env.RETRY_JITTER_RATIO = "0";
process.env.SHEET_RETRY_MAX_ATTEMPTS = "3";
process.env.TELEGRAM_ENABLED = "true";
process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN";
process.env.TELEGRAM_CHAT_ID = "-100123456789";
process.env.TELEGRAM_SEND_DELAY_MS = "0";
process.env.TELEGRAM_MAX_RETRIES = "2";
process.env.TELEGRAM_RETRY_DELAY_MS = "100";

import type { ListingDetail } from "../src/models/listing.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

function makeListing(listingId: string): ListingDetail {
  return {
    listingId,
    url: "https://www.centris.ca/en/properties~" + listingId,
    price: 699000,
    priceRaw: "$699,000",
    address: "123 Test Street",
    propertyType: "Quintuplex",
    bedrooms: 4,
    bathrooms: 2,
    brokerId: null,
    brokerName: null,
    brokerPhone: null,
    brokerProfileUrl: null,
    agencyName: null,
    rooms: null,
    livingArea: null,
    yearBuilt: null,
    parking: null,
    latitude: null,
    longitude: null,
    landAssessment: null,
    buildingAssessment: null,
    totalAssessment: null,
    municipalTax: null,
    schoolTax: null,
    condoFees: null,
    scrapedAt: "2026-07-14T00:00:00.000Z",
  };
}

interface MockResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<Record<string, unknown>>;
}

function response(status: number, body: Record<string, unknown>): MockResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  };
}

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => MockResponse | Promise<MockResponse>,
): void {
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    return (await handler(input.toString(), init)) as unknown as Response;
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const { syncDetailsToSheet } = await import("../src/services/sheets.js");
const { notifyNewListings } = await import("../src/services/telegram.js");

try {
  let sheetCall = 0;
  const sheetRetryDelays: number[] = [];
  let sheetMetrics:
    | { attempts: number; retries: number; totalDelayMs: number }
    | null = null;
  mockFetch(() => {
    sheetCall++;
    if (sheetCall < 3) {
      return response(500, { ok: false, description: "temporary outage" });
    }
    return response(200, {
      success: true,
      received: 1,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 1,
      totalStored: 1,
      newListingIds: [],
      updatedListingIds: [],
      pendingTelegramListingIds: [],
      checkedAt: "2026-07-15T00:00:00.000Z",
    });
  });
  await syncDetailsToSheet([makeListing("1")], {
    onRetry: ({ delayMs }) => sheetRetryDelays.push(delayMs),
    onComplete: (metrics) => {
      sheetMetrics = metrics;
    },
  });
  assert(sheetCall === 3, "sheet retries until success");
  assert(
    sheetRetryDelays.join(",") === "100,200",
    "sheet retry delays follow exponential backoff",
  );
  assert(sheetMetrics?.retries === 2, "sheet retry metrics count retries");
  assert(sheetMetrics?.attempts === 3, "sheet retry metrics count attempts");
  assert(sheetMetrics?.totalDelayMs === 300, "sheet retry metrics count delay");

  let telegramCall = 0;
  const telegramRetryDelays: number[] = [];
  mockFetch(() => {
    telegramCall++;
    if (telegramCall === 1) {
      return response(500, {
        ok: false,
        error_code: 500,
        description: "Internal Server Error",
      });
    }
    return response(200, { ok: true, result: { message_id: 99 } });
  });
  const telegramResult = await notifyNewListings([makeListing("2")], ["2"], {
    onRetry: ({ delayMs }) => telegramRetryDelays.push(delayMs),
  });
  assert(telegramCall === 2, "telegram retries once before success");
  assert(telegramResult.retries === 1, "telegram summary counts retries");
  assert(telegramResult.retryDelayMs === 100, "telegram summary counts retry delay");
  assert(telegramResult.retriedListings === 1, "telegram summary counts retried listings");
  assert(telegramResult.maxAttemptsUsed === 2, "telegram summary tracks max attempts");
  assert(telegramRetryDelays.join(",") === "100", "telegram callback receives actual delay");

  let permanentCall = 0;
  mockFetch(() => {
    permanentCall++;
    return response(400, { ok: false, error_code: 400, description: "Bad Request" });
  });
  const permanentResult = await notifyNewListings([makeListing("3")], ["3"]);
  assert(permanentCall === 1, "telegram permanent errors do not retry");
  assert(permanentResult.retries === 0, "telegram permanent errors do not increment retries");
} finally {
  restoreFetch();
}

console.log(
  "\nService retry metrics tests: " +
    String(passed) +
    " passed, " +
    String(failed) +
    " failed",
);
if (failed > 0) process.exit(1);
