process.env.TELEGRAM_ENABLED = "true";
process.env.TELEGRAM_SEND_DELAY_MS = "0";
process.env.GOOGLE_APPS_SCRIPT_URL = "https://script.google.com/mock/exec";

import type { ListingDetail } from "../src/models/listing.js";
import type { TelegramAckItem } from "../src/services/sheets.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL: " + msg);
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
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => MockResponse | Promise<MockResponse>,
): void {
  fetchCalls = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    fetchCalls.push({
      url: input.toString(),
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });
    return (await handler(input.toString(), init)) as unknown as Response;
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const { notifyNewListings } = await import("../src/services/telegram.js");
const { acknowledgeTelegramResults } = await import("../src/services/sheets.js");

try {
  // ── Test 1: pendingTelegramListingIds drives notification selection ──
  mockFetch(() => response(200, { ok: true, result: { message_id: 1 } }));
  {
    const details = [makeListing("111"), makeListing("222")];
    // Only "111" is pending (simulating pendingTelegramListingIds filtering)
    const result = await notifyNewListings(details, ["111", "999"]);
    assert(result.requested === 1, "pending: only matching pending ID selected");
    assert(result.sent === 1, "pending: matching listing sent");
    assert(result.skipped === 1, "pending: missing ID skipped");
    assert(fetchCalls.length === 1, "pending: one request");
  }

  // ── Test 2: acknowledgeTelegramResults sends correct action and body ──
  mockFetch(() =>
    response(200, { success: true, updatedCount: 1, notFoundCount: 0 }),
  );
  {
    const ackItems: TelegramAckItem[] = [
      {
        listingId: "111",
        success: true,
        messageId: 42,
        attempts: 1,
        error: null,
        sentAt: "2026-07-14T09:00:00.000Z",
      },
    ];

    await acknowledgeTelegramResults(ackItems);

    assert(fetchCalls.length === 1, "ack: one request sent");
    assert(
      fetchCalls[0]?.body.action === "ackTelegram",
      'ack: action is "ackTelegram"',
    );
    assert(
      Array.isArray(fetchCalls[0]?.body.results),
      "ack: results is array",
    );
    assert(
      fetchCalls[0]?.body.results[0]?.listingId === "111",
      "ack: listingId matches",
    );
    assert(
      fetchCalls[0]?.body.results[0]?.success === true,
      "ack: success matches",
    );
    assert(
      fetchCalls[0]?.body.results[0]?.messageId === 42,
      "ack: messageId matches",
    );
  }

  // ── Test 3: acknowledgeTelegramResults handles failure result ──
  mockFetch(() =>
    response(200, { success: true, updatedCount: 1, notFoundCount: 0 }),
  );
  {
    const ackItems: TelegramAckItem[] = [
      {
        listingId: "222",
        success: false,
        messageId: null,
        attempts: 3,
        error: "Telegram API error 400: Bad Request",
        sentAt: null,
      },
    ];

    await acknowledgeTelegramResults(ackItems);

    assert(fetchCalls.length === 1, "ack-fail: one request");
    assert(
      fetchCalls[0]?.body.results[0]?.success === false,
      "ack-fail: success is false on failed send",
    );
    assert(
      fetchCalls[0]?.body.results[0]?.error === "Telegram API error 400: Bad Request",
      "ack-fail: error message included",
    );
  }

  // ── Test 4: acknowledgeTelegramResults empty list does nothing ──
  let fetchCalled = false;
  mockFetch(() => {
    fetchCalled = true;
    return response(200, { success: true, updatedCount: 0, notFoundCount: 0 });
  });
  {
    await acknowledgeTelegramResults([]);
    assert(fetchCalled === false, "ack-empty: no fetch for empty list");
  }

  // ── Test 5: acknowledgeTelegramResults logs on failure, does not throw ──
  mockFetch(() => {
    throw new Error("Network error");
  });
  {
    let threw = false;
    try {
      await acknowledgeTelegramResults([
        {
          listingId: "333",
          success: true,
          messageId: 7,
          attempts: 1,
          error: null,
          sentAt: "2026-07-14T09:00:00.000Z",
        },
      ]);
    } catch {
      threw = true;
    }
    assert(threw === false, "ack-error: does not throw");
    // If fetch throws, the catch block logs and returns without throwing
  }

  // ── Test 6: duplicate pending IDs send once (dedup in selectNewListings) ──
  mockFetch(() => response(200, { ok: true, result: { message_id: 10 } }));
  {
    const result = await notifyNewListings(
      [makeListing("111")],
      ["111", "111"],
    );
    assert(result.requested === 1, "dedup: requested once");
    assert(result.sent === 1, "dedup: sent once");
    assert(fetchCalls.length === 1, "dedup: one request");
  }

  // ── Test 7: second run after successful send returns no pending IDs ──
  // (simulating that Apps Script returns empty pendingTelegramListingIds)
  mockFetch(() => response(200, { ok: true, result: { message_id: 11 } }));
  {
    const result = await notifyNewListings(
      [makeListing("111")],
      [], // empty pending list — all already SENT
    );
    assert(result.requested === 0, "no-pending: requested 0");
    assert(result.sent === 0, "no-pending: sent 0");
    assert(fetchCalls.length === 0, "no-pending: no fetch");
  }

  // ── Test 8: acknowledgeTelegramResults uses correctly typed fields ──
  mockFetch(() =>
    response(200, { success: true, updatedCount: 2, notFoundCount: 1 }),
  );
  {
    const items: TelegramAckItem[] = [
      {
        listingId: "a",
        success: true,
        messageId: 1,
        attempts: 1,
        error: null,
        sentAt: "2026-07-14T09:00:00.000Z",
      },
      {
        listingId: "b",
        success: false,
        messageId: null,
        attempts: 2,
        error: "timeout",
        sentAt: null,
      },
    ];
    await acknowledgeTelegramResults(items);
    assert(fetchCalls.length === 1, "ack-multi: one batch request");
    assert(
      fetchCalls[0]?.body.results.length === 2,
      "ack-multi: two items in batch",
    );
  }
} finally {
  restoreFetch();
}

console.log(
  "\nNotification outbox tests: " +
    String(passed) +
    " passed, " +
    String(failed) +
    " failed",
);
if (failed > 0) process.exit(1);
