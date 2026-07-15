import { sendTelegramMessage } from "../src/services/telegram.js";
import { env } from "../src/config/env.js";
import { formatNewListingMessage } from "../src/services/telegram.js";
import type { ListingDetail } from "../src/models/listing.js";

const SEP = "─".repeat(56);

function log(...args: unknown[]): void {
  console.log("[diag]", ...args);
}

async function testPlainText(): Promise<void> {
  log(SEP);
  log("TEST 1: Minimal plain text (no parse_mode)");
  log(SEP);

  const result = await sendTelegramMessage(
    "Caspian Task Telegram Test (plain text)",
  );
  log("OK  messageId=" + String(result.messageId) + " attempts=" + String(result.attempts));
}

async function testHtmlText(): Promise<void> {
  log(SEP);
  log("TEST 2: HTML text (parse_mode=HTML)");
  log(SEP);

  const result = await sendTelegramMessage(
    "<b>Bold</b> <i>italic</i> <code>code</code>",
    { parseMode: "HTML" },
  );
  log("OK  messageId=" + String(result.messageId) + " attempts=" + String(result.attempts));
}

async function testFormattedMessage(): Promise<void> {
  log(SEP);
  log("TEST 3: Full formatted new-listing message (parse_mode=HTML)");
  log(SEP);

  const sampleListing: ListingDetail = {
    listingId: "DIAG-0001",
    url: "https://www.centris.ca/en/properties~17042189",
    price: 599000,
    propertyType: "Condo",
    address: "123 Main St, Montreal, QC",
    bedrooms: 3,
    bathrooms: 2,
    livingArea: 1200,
    parking: "1 indoor",
    yearBuilt: 2015,
    municipalTax: 3500,
    schoolTax: 500,
    condoFees: 200,
    brokerName: "John Doe",
    brokerPhone: "514-555-0100",
    agencyName: "Realty Corp",
  };

  const message = formatNewListingMessage(sampleListing);
  log("Message length: " + String(message.length) + " chars");
  log("First 120 chars: " + message.substring(0, 120).replace(/\n/g, "\\n"));

  const result = await sendTelegramMessage(message, { parseMode: "HTML" });
  log("OK  messageId=" + String(result.messageId) + " attempts=" + String(result.attempts));
}

async function testProxy(): Promise<void> {
  log(SEP);
  log("ENV: Proxy detection");
  log(SEP);

  const httpsProxy = process.env.HTTPS_PROXY || "(not set)";
  const httpProxy = process.env.HTTP_PROXY || "(not set)";
  log("HTTPS_PROXY=" + httpsProxy);
  log("HTTP_PROXY=" + httpProxy);

  try {
    log("Attempting direct DNS lookup of api.telegram.org...");
    const addresses = await fetch("https://api.telegram.org/bot0:test/getMe");
    log("Direct fetch status: " + String(addresses.status));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("Direct fetch failed (expected behind proxy): " + msg);
  }
}

async function main(): Promise<void> {
  try {
    await testProxy();
    console.log();
    await testPlainText();
    console.log();
    await testHtmlText();
    console.log();
    await testFormattedMessage();
    log(SEP);
    log("All tests passed.");
  } catch (err) {
    console.error("[diag] FAILED:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
