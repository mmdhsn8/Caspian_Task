import { env } from "../src/config/env.js";
import { createBrowserSession } from "../src/scraper/browser.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const debugDir = path.resolve(__dirname, "..", "debug");

const detailUrl = process.env.CENTRIS_DETAIL_TEST_URL;

if (!detailUrl) {
  throw new Error(
    "CENTRIS_DETAIL_TEST_URL is not set.\n" +
      "Add it to your .env file, for example:\n" +
      "CENTRIS_DETAIL_TEST_URL=https://www.centris.ca/en/properties~for-sale/12345678",
  );
}

function isValidCentrisUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "centris.ca" || parsed.hostname.endsWith(".centris.ca"))
    );
  } catch {
    return false;
  }
}

if (!isValidCentrisUrl(detailUrl)) {
  throw new Error(
    `Invalid CENTRIS_DETAIL_TEST_URL: "${detailUrl}".\n` +
      "The URL must point to centris.ca or a subdomain of centris.ca.",
  );
}

async function main(): Promise<void> {
  console.log(`Opening detail page: ${detailUrl}`);

  const session = await createBrowserSession();
  try {
    const { page } = session;

    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: env.scraperTimeoutMs,
    });

    console.log("Waiting for dynamic content...");
    await page.waitForTimeout(2000);

    console.log("Scrolling to load all content...");
    let previousHeight = 0;
    for (let i = 0; i < 20; i++) {
      previousHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(400);
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === previousHeight) break;
    }

    await mkdir(debugDir, { recursive: true });

    const htmlPath = path.join(debugDir, "centris-detail.html");
    const html = await page.content();
    await writeFile(htmlPath, html, "utf-8");

    const pngPath = path.join(debugDir, "centris-detail.png");
    await page.screenshot({ path: pngPath, fullPage: true });

    console.log(`HTML saved: ${htmlPath}`);
    console.log(`Screenshot saved: ${pngPath}`);
  } finally {
    await session.close();
  }
}

await main();
