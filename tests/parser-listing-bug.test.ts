import * as cheerio from "cheerio";
import { searchSelectors } from "../src/scraper/selectors.js";
import { extractNumericId } from "../src/utils/helpers.js";
import { parseListingDetail } from "../src/parser/detail.js";
import { parseSearchResults } from "../src/parser/listing.js";

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

// ── Test 1: Root card has data-id="5", descendant has listing-id="14827136" ──
{
  const html = `
    <div class="property-thumbnail-item" data-id="5">
      <a href="/en/properties~14827136">link</a>
      <span listing-id="14827136">hidden</span>
      <span class="price">$699,000</span>
      <span class="address">123 Main St</span>
    </div>`;
  const results = parseSearchResults(html);
  assert(results.length === 1, "Test 1a: card is parsed");
  assert(
    results[0]?.listingId === "14827136",
    "Test 1b: listingId is from descendant listing-id, not root data-id. Got: " +
      (results[0]?.listingId ?? "undefined"),
  );
}

// ── Test 2: Only data-id="5" on root, no descendant listing-id, no valid URL ──
{
  const html = `
    <div class="property-thumbnail-item" data-id="5">
      <span class="price">$699,000</span>
    </div>`;
  const results = parseSearchResults(html);
  assert(results.length === 0, "Test 2: card without valid listing ID is skipped");
}

// ── Test 3: No attribute listing-id, URL fallback ───────────────────────────
{
  const html = `
    <div class="property-thumbnail-item" data-id="5">
      <a href="/en/condos~for-sale~montreal/14827136">link</a>
      <span class="price">$699,000</span>
      <span class="address">123 Main St</span>
    </div>`;
  const results = parseSearchResults(html);
  assert(results.length === 1, "Test 3a: card is parsed via URL fallback");
  assert(
    results[0]?.listingId === "14827136",
    "Test 3b: listingId from URL. Got: " + (results[0]?.listingId ?? "undefined"),
  );
}

// ── Test 4: data-listing-id on descendant ───────────────────────────────────
{
  const html = `
    <div class="property-thumbnail-item" data-id="5">
      <a href="/en/properties~99999999">link</a>
      <span data-listing-id="14827136">hidden</span>
    </div>`;
  const results = parseSearchResults(html);
  assert(results.length === 1, "Test 4a: card with data-listing-id is parsed");
  assert(
    results[0]?.listingId === "14827136",
    "Test 4b: listingId from descendant data-listing-id. Got: " +
      (results[0]?.listingId ?? "undefined"),
  );
}

// ── Test 5: Deduplication ───────────────────────────────────────────────────
{
  const html = `
    <div class="property-thumbnail-item" data-id="5">
      <a href="/en/properties~14827136">link</a>
      <span listing-id="14827136">a</span>
    </div>
    <div class="property-thumbnail-item" data-id="5">
      <a href="/en/properties~14827136">link</a>
      <span listing-id="14827136">b</span>
    </div>
    <div class="property-thumbnail-item" data-id="5">
      <a href="/en/properties~22222222">link</a>
      <span listing-id="22222222">c</span>
    </div>`;
  const results = parseSearchResults(html);
  assert(
    results.length === 2,
    "Test 5a: duplicates removed. Got: " + String(results.length),
  );
  assert(
    results[0]?.listingId === "14827136",
    "Test 5b: first unique listingId preserved. Got: " +
      (results[0]?.listingId ?? "undefined"),
  );
  assert(
    results[1]?.listingId === "22222222",
    "Test 5c: second unique listingId preserved. Got: " +
      (results[1]?.listingId ?? "undefined"),
  );
}

// ── Test 6: extractNumericId skips short numbers ────────────────────────────
{
  const result1 = extractNumericId(
    "https://www.centris.ca/en/5plex~for-sale~montreal/14827136",
  );
  assert(result1 === "14827136", "Test 6a: skips '5' from 5plex. Got: " + result1);

  const result2 = extractNumericId("https://www.centris.ca/en/properties~42");
  assert(result2 === "", "Test 6b: returns empty for short number. Got: " + result2);

  const result3 = extractNumericId("https://www.centris.ca/en/properties~14827136");
  assert(
    result3 === "14827136",
    "Test 6c: extracts from typical property URL. Got: " + result3,
  );

  const result4 = extractNumericId("/en/properties~14827136");
  assert(result4 === "14827136", "Test 6d: extracts from relative URL. Got: " + result4);
}

// ── Test 7: listing-id on root (no descendant) ──────────────────────────────
{
  const html = `
    <div class="property-thumbnail-item" listing-id="14827136">
      <a href="/en/properties~14827136">link</a>
    </div>`;
  const results = parseSearchResults(html);
  assert(results.length === 1, "Test 7a: card with root listing-id is parsed");
  assert(
    results[0]?.listingId === "14827136",
    "Test 7b: listingId from root listing-id. Got: " +
      (results[0]?.listingId ?? "undefined"),
  );
}

// ── Test 8: data-listing-id on root (no descendant) ─────────────────────────
{
  const html = `
    <div class="property-thumbnail-item" data-listing-id="14827136">
      <a href="/en/properties~14827136">link</a>
    </div>`;
  const results = parseSearchResults(html);
  assert(results.length === 1, "Test 8a: card with root data-listing-id is parsed");
  assert(
    results[0]?.listingId === "14827136",
    "Test 8b: listingId from root data-listing-id. Got: " +
      (results[0]?.listingId ?? "undefined"),
  );
}

// ── Test 9: detail parser extracts rooms/bedrooms/bathrooms/living area ─────
{
  const html = `
    <body>
      <span id="ListingId">17042189</span>
      <div class="piece">7 rooms</div>
      <div class="cac">3 bedrooms</div>
      <div class="sdb">1 bathroom and 1 powder room</div>
      <div class="carac-container">
        <div class="carac-title">Living area</div>
        <div class="carac-value"><span>946 sqft</span></div>
      </div>
    </body>`;
  const detail = parseListingDetail(html, "https://www.centris.ca/en/test/17042189");
  assert(detail.rooms === 7, "Test 9a: rooms extracted from detail page");
  assert(detail.bedrooms === 3, "Test 9b: bedrooms extracted from detail page");
  assert(detail.bathrooms === 1, "Test 9c: bathrooms extracted from detail page");
  assert(detail.livingArea === 946, "Test 9d: living area extracted from carac label");
}

// ── Test 10: detail parser falls back to characteristic labels for all 4 ────
{
  const html = `
    <body>
      <span id="ListingId">17042190</span>
      <div class="carac-container">
        <div class="carac-title">Rooms</div>
        <div class="carac-value"><span>8</span></div>
      </div>
      <div class="carac-container">
        <div class="carac-title">Bedrooms</div>
        <div class="carac-value"><span>4</span></div>
      </div>
      <div class="carac-container">
        <div class="carac-title">Bathrooms</div>
        <div class="carac-value"><span>2</span></div>
      </div>
      <div class="carac-container">
        <div class="carac-title">Net area</div>
        <div class="carac-value"><span>1,120 sqft</span></div>
      </div>
    </body>`;
  const detail = parseListingDetail(html, "https://www.centris.ca/en/test/17042190");
  assert(detail.rooms === 8, "Test 10a: rooms fallback uses carac title");
  assert(detail.bedrooms === 4, "Test 10b: bedrooms fallback uses carac title");
  assert(detail.bathrooms === 2, "Test 10c: bathrooms fallback uses carac title");
  assert(detail.livingArea === 1120, "Test 10d: living area fallback uses carac title");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nResults: ${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
