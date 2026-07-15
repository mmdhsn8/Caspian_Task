import { env } from "../src/config/env.js";
import { createBrowserSession } from "../src/scraper/browser.js";
import { writeFile } from "node:fs/promises";

function redactUrl(urlValue: string): string {
  const url = new URL(urlValue);
  if (url.searchParams.has("q")) url.searchParams.set("q", "[redacted]");
  return url.toString();
}

async function main(): Promise<void> {
  const session = await createBrowserSession();
  const { page } = session;

  console.log("Requested URL:", redactUrl(env.centrisSearchUrl));

  try {
    const response = await page.goto(env.centrisSearchUrl, {
      waitUntil: "domcontentloaded",
    });

    console.log("HTTP status:", response?.status() ?? "none");
    console.log("Final URL:", redactUrl(page.url()));
    console.log("Title:", await page.title());
    console.log("Body text:", (await page.locator("body").innerText()).slice(0, 300));
  } catch (error) {
    console.log("Navigation error:", error instanceof Error ? error.message : String(error));
    console.log("Final URL:", redactUrl(page.url()));
    try {
      console.log("Title:", await page.title());
      console.log("Body text:", (await page.locator("body").innerText()).slice(0, 300));
    } catch (captureError) {
      console.log(
        "Body capture error:",
        captureError instanceof Error ? captureError.message : String(captureError),
      );
    }
  } finally {
    try {
      await page.screenshot({ path: "debug/centris-probe.png", fullPage: true });
      await writeFile("debug/centris-probe.html", await page.content(), "utf8");
    } finally {
      await session.close();
    }
  }
}

void main();
