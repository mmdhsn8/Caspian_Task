process.env.TELEGRAM_ENABLED = "true";
process.env.TELEGRAM_SEND_DELAY_MS = "0";

import type { ListingDetail } from "../src/models/listing.js";

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
}

function response(status: number, body: Record<string, unknown>): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

function mockFetch(
  handler: (url: string, init?: RequestInit) => MockResponse | Promise<MockResponse>,
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

const { notifyNewListings, sendTelegramMessage } = await import(
  "../src/services/telegram.js"
);

try {
  // No NEW IDs must not invoke fetch.
  mockFetch(() => response(200, { ok: true, result: { message_id: 1 } }));
  {
    const result = await notifyNewListings([makeListing("111")], []);
    assert(result.requested === 0, "no-new: requested is 0");
    assert(result.sent === 0, "no-new: sent is 0");
    assert(result.failed === 0, "no-new: failed is 0");
    assert(result.skipped === 0, "no-new: skipped is 0");
    assert(fetchCalls.length === 0, "no-new: no Telegram request");
  }

  // One Sheet-NEW ID sends exactly its matching current detail.
  mockFetch(() => response(200, { ok: true, result: { message_id: 2 } }));
  {
    const result = await notifyNewListings(
      [makeListing("111"), makeListing("222")],
      ["222"],
    );
    assert(result.requested === 1, "one-new: requested is 1");
    assert(result.sent === 1, "one-new: sent is 1");
    assert(fetchCalls.length === 1, "one-new: one Telegram request");
    assert(
      String(fetchCalls[0]?.body.text).includes("Listing ID:</b> 222"),
      "one-new: matching listing is sent",
    );
  }

  // Sheet NEW IDs select in current-detail order, not Sheet-ID order.
  mockFetch(() => response(200, { ok: true, result: { message_id: 3 } }));
  {
    const result = await notifyNewListings(
      [makeListing("111"), makeListing("222"), makeListing("333")],
      ["333", "111"],
    );
    assert(result.sent === 2, "multiple-new: two messages sent");
    assert(fetchCalls.length === 2, "multiple-new: two requests");
    assert(
      String(fetchCalls[0]?.body.text).includes("Listing ID:</b> 111") &&
        String(fetchCalls[1]?.body.text).includes("Listing ID:</b> 333"),
      "multiple-new: detail order preserved",
    );
  }

  // IDs absent from newListingIds represent UPDATED/UNCHANGED and never send.
  mockFetch(() => response(200, { ok: true, result: { message_id: 4 } }));
  {
    const result = await notifyNewListings(
      [makeListing("updated"), makeListing("unchanged")],
      [],
    );
    assert(result.sent === 0, "updated-unchanged: none sent");
    assert(fetchCalls.length === 0, "updated-unchanged: no request");
  }

  // Missing Sheet-NEW IDs are skipped without a fabricated send.
  mockFetch(() => response(200, { ok: true, result: { message_id: 5 } }));
  {
    const result = await notifyNewListings([makeListing("111")], ["111", "missing"]);
    assert(result.requested === 1, "missing: one matching request");
    assert(result.sent === 1, "missing: matching listing sent");
    assert(result.skipped === 1, "missing: missing ID skipped");
    assert(fetchCalls.length === 1, "missing: no fabricated request");
  }

  // Duplicate Sheet IDs result in one request, not one per duplicate.
  mockFetch(() => response(200, { ok: true, result: { message_id: 6 } }));
  {
    const result = await notifyNewListings([makeListing("111")], ["111", "111"]);
    assert(result.requested === 1, "duplicate-id: requested once");
    assert(result.sent === 1, "duplicate-id: sent once");
    assert(result.skipped === 0, "duplicate-id: not skipped");
    assert(fetchCalls.length === 1, "duplicate-id: one request");
  }

  // One permanent failure does not stop remaining NEW listing sends.
  let partialCall = 0;
  mockFetch(() => {
    partialCall++;
    return partialCall === 1
      ? response(400, { ok: false, error_code: 400, description: "Bad Request" })
      : response(200, { ok: true, result: { message_id: 7 } });
  });
  {
    const result = await notifyNewListings(
      [makeListing("111"), makeListing("222")],
      ["111", "222"],
    );
    assert(result.sent === 1, "partial-failure: one sent");
    assert(result.failed === 1, "partial-failure: one failed");
    assert(fetchCalls.length === 2, "partial-failure: second listing still sent");
  }

  // Existing single-message behavior retains the Telegram response parsing path.
  mockFetch(() => response(200, { ok: true, result: { message_id: 42 } }));
  {
    const result = await sendTelegramMessage("test message");
    assert(result.messageId === 42, "send: message ID parsed");
  }
} finally {
  restoreFetch();
}

console.log(
  "\nTelegram service tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
