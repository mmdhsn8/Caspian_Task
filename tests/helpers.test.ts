import { buildSearchPageUrl, extractNumericId, sleep } from "../src/utils/helpers.js";

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

// ── buildSearchPageUrl ──────────────────────────────────────────────────────
{
  const base = "https://www.centris.ca/en/properties~for-sale~montreal";
  const url1 = buildSearchPageUrl(base, 1, 20);
  assert(
    url1 === base + "?page=1&pageSize=20",
    "buildSearchPageUrl page=1 pageSize=20. Got: " + url1,
  );

  const url2 = buildSearchPageUrl(base, 5, 50);
  assert(
    url2 === base + "?page=5&pageSize=50",
    "buildSearchPageUrl page=5 pageSize=50. Got: " + url2,
  );

  const url3 = buildSearchPageUrl(base + "?sort=PriceDesc", 2, 20);
  const parsed3 = new URL(url3);
  assert(
    parsed3.searchParams.get("page") === "2",
    "buildSearchPageUrl preserves existing query params (page). Got: " +
      parsed3.searchParams.get("page"),
  );
  assert(
    parsed3.searchParams.get("pageSize") === "20",
    "buildSearchPageUrl sets pageSize. Got: " + parsed3.searchParams.get("pageSize"),
  );
  assert(
    parsed3.searchParams.get("sort") === "PriceDesc",
    "buildSearchPageUrl preserves existing query params (sort). Got: " +
      parsed3.searchParams.get("sort"),
  );
}

// ── extractNumericId ────────────────────────────────────────────────────────
{
  const r1 = extractNumericId(
    "https://www.centris.ca/en/5plex~for-sale~montreal/14827136",
  );
  assert(r1 === "14827136", "extractNumericId skips '5' from 5plex. Got: " + r1);

  const r2 = extractNumericId("https://www.centris.ca/en/properties~42");
  assert(r2 === "", "extractNumericId returns empty for short number. Got: " + r2);

  const r3 = extractNumericId("https://www.centris.ca/en/properties~14827136");
  assert(r3 === "14827136", "extractNumericId from typical URL. Got: " + r3);

  const r4 = extractNumericId("/en/properties~14827136");
  assert(r4 === "14827136", "extractNumericId from relative URL. Got: " + r4);
}

// ── sleep ───────────────────────────────────────────────────────────────────
{
  const start = Date.now();
  await sleep(50);
  const elapsed = Date.now() - start;
  assert(elapsed >= 40, "sleep(50) waited at least 40ms. Got: " + String(elapsed));
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\nHelpers test results: " + String(passed) + " passed, " + String(failed) + " failed");
if (failed > 0) process.exit(1);
