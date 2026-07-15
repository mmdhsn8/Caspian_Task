import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { searchSelectors } from "../scraper/selectors.js";
import { normalizePrice } from "../utils/normalize.js";
import { resolveUrl, extractNumericId } from "../utils/helpers.js";

export interface ListingSummary {
  listingId: string;
  url: string;
  price: number | null;
  priceRaw: string | null;
  address: string | null;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
}

function firstMatch(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string | null {
  for (const sel of selectors) {
    const el = root.find(sel).first();
    const text = el.text().trim();
    if (text) return text;
  }
  return null;
}

function firstAttr(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  attributes: readonly string[],
): string | undefined {
  for (const attr of attributes) {
    const descendant = root.find(`[${attr}]`).first();
    const descendantVal = descendant.attr(attr);
    if (descendantVal) return descendantVal;
    const rootVal = root.attr(attr);
    if (rootVal) return rootVal;
  }
  return undefined;
}

function isValidListingId(id: string): boolean {
  return /^\d{6,}$/.test(id);
}

export function parseSearchResults(raw: string): ListingSummary[] {
  const $ = cheerio.load(raw);
  const listings: ListingSummary[] = [];
  const seenIds = new Set<string>();

  let cards: cheerio.Cheerio<AnyNode> | null = null;
  for (const selector of searchSelectors.listingCard) {
    const found = $(selector);
    if (found.length > 0) {
      cards = found;
      break;
    }
  }

  if (!cards || cards.length === 0) return [];

  cards.each((_index, element) => {
    const card = $(element);

    const rawId = firstAttr($, card, searchSelectors.listingIdAttribute) ?? "";

    let url = "";
    for (const sel of searchSelectors.listingLink) {
      const link = card.find(sel).first();
      const href = link.attr("href");
      if (href) {
        url = resolveUrl(href);
        break;
      }
    }
    if (!url) {
      const anyLink = card.find("a").first();
      const href = anyLink.attr("href");
      if (href) url = resolveUrl(href);
    }

    let finalId = "";
    if (isValidListingId(rawId)) {
      finalId = rawId;
    } else {
      const numericFromUrl = extractNumericId(url);
      if (isValidListingId(numericFromUrl)) {
        finalId = numericFromUrl;
      }
    }

    if (!finalId || !url) return;
    if (seenIds.has(finalId)) return;
    seenIds.add(finalId);

    const priceRaw = firstMatch($, card, searchSelectors.price);
    const price = priceRaw ? normalizePrice(priceRaw) : null;
    const address = firstMatch($, card, searchSelectors.address);
    const propertyType = firstMatch($, card, searchSelectors.propertyType);

    let bedrooms: number | null = null;
    const bedText = firstMatch($, card, searchSelectors.bedrooms);
    if (bedText) {
      const parsed = parseInt(bedText, 10);
      if (!Number.isNaN(parsed)) bedrooms = parsed;
    }

    let bathrooms: number | null = null;
    const bathText = firstMatch($, card, searchSelectors.bathrooms);
    if (bathText) {
      const parsed = parseInt(bathText, 10);
      if (!Number.isNaN(parsed)) bathrooms = parsed;
    }

    listings.push({
      listingId: finalId,
      url,
      price,
      priceRaw,
      address,
      propertyType,
      bedrooms,
      bathrooms,
    });
  });

  return listings;
}
