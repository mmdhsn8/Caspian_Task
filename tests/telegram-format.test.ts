import type { ListingDetail } from "../src/models/listing.js";
import {
  escapeTelegramHtml,
  formatNumber,
  formatCurrency,
  formatNewListingMessage,
  selectNewListings,
} from "../src/services/telegram.js";

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

function assertIncludes(haystack: string, needle: string, msg: string): void {
  if (haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL: " + msg + " — expected to find: " + needle);
  }
}

function assertNotIncludes(haystack: string, needle: string, msg: string): void {
  if (!haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL: " + msg + " — expected NOT to find: " + needle);
  }
}

// ── Create a full listing for tests ─────────────────────────────────────────

function makeFullListing(overrides?: Partial<ListingDetail>): ListingDetail {
  return {
    listingId: "17042189",
    url: "https://www.centris.ca/en/properties~17042189",
    price: 699000,
    priceRaw: "$699,000",
    address: "123 Rue Example, Montréal",
    propertyType: "5plex",
    bedrooms: 4,
    bathrooms: 2,
    livingArea: 946,
    yearBuilt: 2011,
    parking: "Garage (1)",
    latitude: 45.5,
    longitude: -73.6,
    landAssessment: 154200,
    buildingAssessment: 421800,
    totalAssessment: 576000,
    municipalTax: 3766,
    schoolTax: 441,
    condoFees: 350,
    brokerId: "103362",
    brokerName: "Frank Monaco",
    brokerPhone: "+1 514-971-8910",
    brokerProfileUrl: "https://www.centris.ca/en/realtor~103362",
    agencyName: "RE/MAX ALLIANCE INC.",
    rooms: 7,
    scrapedAt: "2026-07-14T12:34:56.000Z",
    ...overrides,
  };
}

// ── Test escapeTelegramHtml ─────────────────────────────────────────────────
{
  const result = escapeTelegramHtml('<b>Hello</b> & "World"');
  assert(
    result === "&lt;b&gt;Hello&lt;/b&gt; &amp; &quot;World&quot;",
    'escapeTelegramHtml escapes < > & ". Got: ' + result,
  );
}

// ── Test formatNumber ───────────────────────────────────────────────────────
{
  const result = formatNumber(946);
  assert(result === "946", "formatNumber(946). Got: " + String(result));
  assert(formatNumber(null) === null, "formatNumber(null) returns null");
  assert(
    formatNumber(1000000) === "1,000,000",
    "formatNumber(1000000). Got: " + String(formatNumber(1000000)),
  );
}

// ── Test formatCurrency ─────────────────────────────────────────────────────
{
  const result = formatCurrency(699000);
  assert(
    result !== null && result.includes("699"),
    "formatCurrency(699000) includes 699. Got: " + String(result),
  );
  assert(formatCurrency(null) === null, "formatCurrency(null) returns null");
  const result2 = formatCurrency(3766);
  assert(
    result2 !== null && result2.includes("3,766"),
    "formatCurrency(3766) includes 3,766. Got: " + String(result2),
  );
}

// ── Test formatNewListingMessage — full listing ─────────────────────────────
{
  const listing = makeFullListing();
  const msg = formatNewListingMessage(listing);

  assertIncludes(msg, "New Property", "full: title");
  assertIncludes(msg, "$699,000", "full: price");
  assertIncludes(msg, "5plex", "full: type");
  assertIncludes(msg, "123 Rue Example", "full: address");
  assertIncludes(msg, "<b>Bedrooms:</b> 4", "full: bedrooms");
  assertIncludes(msg, "<b>Bathrooms:</b> 2", "full: bathrooms");
  assertIncludes(msg, "946 sq. ft.", "full: living area");
  assertIncludes(msg, "Garage (1)", "full: parking");
  assertIncludes(msg, "<b>Year built:</b> 2011", "full: year built");
  assertIncludes(msg, "Frank Monaco", "full: broker");
  assertIncludes(msg, "+1 514-971-8910", "full: phone");
  assertIncludes(msg, "RE/MAX ALLIANCE INC.", "full: agency");
  assertIncludes(msg, "View on Centris", "full: link text");
  assertIncludes(msg, "centris.ca", "full: link URL");
  assertIncludes(msg, "<b>Listing ID:</b> 17042189", "full: listing ID");
}

// ── Test formatNewListingMessage — minimal listing ──────────────────────────
{
  const listing = makeFullListing({
    address: null,
    propertyType: null,
    bedrooms: null,
    bathrooms: null,
    livingArea: null,
    yearBuilt: null,
    parking: null,
    municipalTax: null,
    schoolTax: null,
    condoFees: null,
    brokerName: null,
    brokerPhone: null,
    agencyName: null,
    price: null,
  });
  const msg = formatNewListingMessage(listing);
  assertIncludes(msg, "New Property", "minimal: title");
  assertIncludes(msg, "<b>Listing ID:</b> 17042189", "minimal: listing ID");
  assertIncludes(msg, "View on Centris", "minimal: link");
  assertNotIncludes(msg, "<b>Price:</b>", "minimal: no price");
  assertNotIncludes(msg, "<b>Address:</b>", "minimal: no address");
  assertNotIncludes(msg, "<b>Type:</b>", "minimal: no type");
  assertNotIncludes(msg, "<b>Bedrooms:</b>", "minimal: no bedrooms");
}

// ── Test formatNewListingMessage — HTML escaping ────────────────────────────
{
  const listing = makeFullListing({
    address: "<script>alert('xss')</script>",
    brokerName: 'Broker & "Co."',
  });
  const msg = formatNewListingMessage(listing);
  assertIncludes(msg, "&lt;script&gt;", "escape: script tag escaped");
  assertIncludes(msg, "&amp;", "escape: ampersand escaped");
  assertIncludes(msg, "&quot;", "escape: double quote escaped");
  assertNotIncludes(msg, "<script>", "escape: raw script tag not present");
}

// ── Test formatNewListingMessage — invalid URL ──────────────────────────────
{
  const listing = makeFullListing({
    url: "not-a-valid-url",
  });
  const msg = formatNewListingMessage(listing);
  assertIncludes(msg, "not-a-valid-url", "invalid URL: shown as text");
  assertNotIncludes(msg, 'href="', "invalid URL: no anchor created");
}

// ── Test formatNewListingMessage — no brokerPhone, no agencyName ────────────
{
  const listing = makeFullListing({
    brokerPhone: null,
    agencyName: null,
  });
  const msg = formatNewListingMessage(listing);
  assertIncludes(msg, "<b>Broker:</b> Frank Monaco", "no phone: broker name present");
  assertNotIncludes(msg, "Phone:", "no phone: phone label absent");
  assertNotIncludes(msg, "Agency:", "no agency: agency label absent");
}

// ── Test selectNewListings ──────────────────────────────────────────────────
{
  const d1 = makeFullListing({ listingId: "111" });
  const d2 = makeFullListing({ listingId: "222" });
  const d3 = makeFullListing({ listingId: "333" });
  const details = [d1, d2, d3];
  const newIds = ["222", "111"];

  const result = selectNewListings(details, newIds);
  assert(result.length === 2, "select: 2 matched");
  assert(
    result[0]?.listingId === "111",
    "select: preserves detail order (1st). Got: " +
      (result[0]?.listingId ?? "none"),
  );
  assert(
    result[1]?.listingId === "222",
    "select: preserves detail order (2nd). Got: " +
      (result[1]?.listingId ?? "none"),
  );
}

// ── Test selectNewListings — deduplication ──────────────────────────────────
{
  const d1 = makeFullListing({ listingId: "111" });
  const d2 = makeFullListing({ listingId: "111" });
  const details = [d1, d2];
  const newIds = ["111", "111"];

  const result = selectNewListings(details, newIds);
  assert(result.length === 1, "dedup: only one returned for duplicate IDs");
}

// ── Test selectNewListings — missing detail ─────────────────────────────────
{
  const d1 = makeFullListing({ listingId: "111" });
  const details = [d1];
  const newIds = ["111", "999"];

  const result = selectNewListings(details, newIds);
  assert(result.length === 1, "missing: only existing matched");
}

// ── Test selectNewListings — empty inputs ───────────────────────────────────
{
  const result = selectNewListings([], []);
  assert(result.length === 0, "empty: no listings");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(
  "\nTelegram format tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
