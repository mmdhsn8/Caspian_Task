import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { detailSelectors } from "../scraper/selectors.js";
import {
  normalizePrice,
  normalizeText,
  normalizeInteger,
  normalizeCurrency,
  normalizeArea,
} from "../utils/normalize.js";
import { resolveUrl } from "../utils/helpers.js";
import type { ListingSummary } from "./listing.js";
import type { ListingDetail } from "../models/listing.js";

function firstAttr(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  attrs: readonly string[],
): string | null {
  for (const attr of attrs) {
    const val = root.attr(attr);
    if (val != null && val.trim().length > 0) return val.trim();
  }
  return null;
}

function firstText(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string | null {
  for (const sel of selectors) {
    const el = root.find(sel).first();
    const text = el.text().trim();
    if (text.length > 0) return text;
  }
  return null;
}

function firstContentAttr(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string | null {
  for (const sel of selectors) {
    const el = root.find(sel).first();
    const val = el.attr("content");
    if (val != null && val.trim().length > 0) return val.trim();
  }
  return null;
}

function firstHrefSegment(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string | null {
  for (const sel of selectors) {
    const el = root.find(sel).first();
    const href = el.attr("href");
    if (href) {
      const segments = href.replace(/\/+$/, "").split("/");
      const last = segments[segments.length - 1];
      if (last && last.length > 0) return last;
    }
  }
  return null;
}

function extractListingId($: cheerio.CheerioAPI): string {
  const text = firstText($, $("body"), detailSelectors.listingId);
  if (text) return text;
  const attr = firstAttr($, $("body"), ["data-listing-id"]);
  if (attr) return attr;
  throw new Error("Could not extract listingId from detail page");
}

function extractBrokerId($: cheerio.CheerioAPI): string | null {
  const sel = detailSelectors.brokerId;
  for (const s of sel) {
    if (s.includes("data-broker-id")) {
      const el = $(s).first();
      const val = el.attr("data-broker-id");
      if (val && val.trim().length > 0) return val.trim();
    }
  }
  const hrefId = firstHrefSegment($, $("body"), [".realtor-card .card-link[href]"]);
  if (hrefId) return hrefId;
  for (const s of sel) {
    if (s.startsWith("[") || s.startsWith(".")) {
      const el = $(s).first();
      for (const attr of ["data-broker-id", "broker-id", "data-member-id"]) {
        const v = el.attr(attr);
        if (v && v.trim().length > 0) return v.trim();
      }
    }
  }
  return null;
}

function extractBrokerName($: cheerio.CheerioAPI): string | null {
  return normalizeText(firstText($, $("body"), detailSelectors.brokerName));
}

function extractBrokerPhone($: cheerio.CheerioAPI): string | null {
  return normalizeText(firstText($, $("body"), detailSelectors.brokerPhone));
}

function extractBrokerProfileUrl($: cheerio.CheerioAPI): string | null {
  for (const sel of detailSelectors.brokerProfileLink) {
    const el = $(sel).first();
    const href = el.attr("href");
    if (href && href.trim().length > 0) {
      return resolveUrl(href.trim());
    }
  }
  return null;
}

function extractAgencyName($: cheerio.CheerioAPI): string | null {
  return normalizeText(firstText($, $("body"), detailSelectors.agencyName));
}

function extractRooms($: cheerio.CheerioAPI): number | null {
  const text = firstText($, $("body"), detailSelectors.rooms);
  if (text) return normalizeInteger(text);
  const carac = findCaracValueByLabels($, ["Rooms", "Pièces"]);
  return carac ? normalizeInteger(carac) : null;
}

function findCaracValue($: cheerio.CheerioAPI, label: string): string | null {
  const containers = $(".carac-container");
  for (let i = 0; i < containers.length; i++) {
    const container = containers.eq(i);
    const title = container.find("> .carac-title, .carac-title").first().text().trim();
    if (title.toLowerCase() === label.toLowerCase()) {
      return container.find("> .carac-value, .carac-value").first().text().trim() || null;
    }
  }
  return null;
}

function findCaracValueByLabels(
  $: cheerio.CheerioAPI,
  labels: readonly string[],
): string | null {
  for (const label of labels) {
    const value = findCaracValue($, label);
    if (value) return value;
  }
  return null;
}

function extractLivingArea($: cheerio.CheerioAPI): number | null {
  const text = firstText($, $("body"), detailSelectors.livingArea);
  if (text) return normalizeArea(text);
  const carac = findCaracValueByLabels($, [
    "Net area",
    "Living area",
    "Superficie habitable",
    "Superficie nette",
  ]);
  return carac ? normalizeArea(carac) : null;
}

function extractYearBuilt($: cheerio.CheerioAPI): number | null {
  const text = firstText($, $("body"), detailSelectors.yearBuilt);
  if (text) return normalizeInteger(text);
  const carac = findCaracValue($, "Year built");
  return carac ? normalizeInteger(carac) : null;
}

function extractParking($: cheerio.CheerioAPI): string | null {
  const text = firstText($, $("body"), detailSelectors.parking);
  if (text) return normalizeText(text);
  return normalizeText(findCaracValue($, "Parking (total)"));
}

function extractLatitude($: cheerio.CheerioAPI): number | null {
  const val = firstContentAttr($, $("body"), detailSelectors.latitude);
  if (val) {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  const text = firstText($, $("body"), detailSelectors.latitude.slice(1));
  if (text) {
    const n = Number(text);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function extractLongitude($: cheerio.CheerioAPI): number | null {
  const val = firstContentAttr($, $("body"), detailSelectors.longitude);
  if (val) {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  const text = firstText($, $("body"), detailSelectors.longitude.slice(1));
  if (text) {
    const n = Number(text);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function extractCondoFees(
  $: cheerio.CheerioAPI,
  financialSection: cheerio.Cheerio<AnyNode> | null,
): number | null {
  if (!financialSection) return null;
  for (const sel of detailSelectors.condoFeesTable) {
    const table = financialSection.find(sel).first();
    if (table.length === 0) continue;
    const rows = table.find("tr.financial-details-table__row");
    for (let i = 0; i < rows.length; i++) {
      const row = rows.eq(i);
      const label = normalizeText(row.find("td.financial-details-table__label").text());
      if (label && /condominium\s+fees/i.test(label)) {
        const val = normalizeCurrency(
          row.find("td.financial-details-table__value").text(),
        );
        if (val != null) return val;
      }
    }
  }
  return null;
}

function extractPrice($: cheerio.CheerioAPI): number | null {
  const metaVal = firstContentAttr($, $("body"), [detailSelectors.price[0]]);
  if (metaVal) return normalizePrice(metaVal);
  const text = firstText($, $("body"), detailSelectors.price.slice(1));
  return text ? normalizePrice(text) : null;
}

function extractAddress($: cheerio.CheerioAPI): string | null {
  return normalizeText(firstText($, $("body"), detailSelectors.address));
}

function extractPropertyType($: cheerio.CheerioAPI): string | null {
  const raw = firstText($, $("body"), detailSelectors.propertyType);
  if (!raw) return null;
  return normalizePropertyType(raw);
}

function normalizePropertyType(raw: string): string {
  const activityPhrases = [
    /\s+for\s+sale\s*$/i,
    /\s+for\s+rent\s*$/i,
    /\s+à\s+vendre\s*$/i,
    /\s+à\s+louer\s*$/i,
  ];
  let cleaned = raw.trim();
  for (const pattern of activityPhrases) {
    cleaned = cleaned.replace(pattern, "");
  }
  return normalizeText(cleaned) ?? raw.trim();
}

function extractBedrooms($: cheerio.CheerioAPI): number | null {
  const text = firstText($, $("body"), detailSelectors.bedrooms);
  if (text) return normalizeInteger(text);
  const carac = findCaracValueByLabels($, ["Bedrooms", "Chambres"]);
  return carac ? normalizeInteger(carac) : null;
}

function extractBathrooms($: cheerio.CheerioAPI): number | null {
  const text = firstText($, $("body"), detailSelectors.bathrooms);
  if (text) return normalizeInteger(text);
  const carac = findCaracValueByLabels($, ["Bathrooms", "Salles de bains"]);
  return carac ? normalizeInteger(carac) : null;
}

function findFinancialSection($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
  for (const sel of detailSelectors.financialSection) {
    const el = $(sel).first();
    if (el.length > 0) return el;
  }
  return null;
}

const ASSESSMENT_LABELS = new Map<string, string>([
  ["lot", "land"],
  ["terrain", "land"],
  ["building", "building"],
  ["bâtiment", "building"],
  ["batiment", "building"],
  ["total", "total"],
]);

const TAX_LABELS = new Map<string, string>([
  ["municipal", "municipal"],
  ["municipales", "municipal"],
  ["school", "school"],
  ["scolaire", "school"],
  ["scolaires", "school"],
]);

function parseFinanceTable(
  $: cheerio.CheerioAPI,
  tableContainer: cheerio.Cheerio<AnyNode>,
  labelMap: Map<string, string>,
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const rows = tableContainer.find("tr.financial-details-table__row");
  rows.each((_i, row) => {
    const labelEl = $(row).find("td.financial-details-table__label").first();
    const valueEl = $(row).find("td.financial-details-table__value").first();
    if (labelEl.length === 0 || valueEl.length === 0) return;
    const label = normalizeText(labelEl.text());
    if (!label) return;
    const normalized = label
      .toLowerCase()
      .replace(/[^a-zéèêëàâùûüôöîïç]/g, "")
      .trim();
    for (const [key, mapped] of labelMap) {
      if (normalized.includes(key)) {
        const existing = result.get(mapped);
        if (existing === undefined || existing === null) {
          result.set(mapped, normalizeCurrency(valueEl.text()));
        }
        break;
      }
    }
  });
  return result;
}

function parseAssessmentTable(
  $: cheerio.CheerioAPI,
  section: cheerio.Cheerio<AnyNode>,
): { land: number | null; building: number | null; total: number | null } {
  let tableContainer: cheerio.Cheerio<AnyNode> | null = null;
  const baseSelector = detailSelectors.assessmentTable[0];
  if (baseSelector) {
    const el = section.find(baseSelector).first();
    if (el.length > 0) tableContainer = el;
  }
  if (!tableContainer) {
    const fallbacks = detailSelectors.assessmentTable.slice(1);
    for (const sel of fallbacks) {
      const el = section.find(sel).first();
      if (el.length > 0) {
        tableContainer = el;
        break;
      }
    }
  }
  if (!tableContainer) return { land: null, building: null, total: null };

  const parsed = parseFinanceTable($, tableContainer, ASSESSMENT_LABELS);
  const land = parsed.get("land") ?? null;
  const building = parsed.get("building") ?? null;

  let total: number | null = null;
  const tfoot = tableContainer
    .find(
      "tfoot tr.financial-details-table__row--total td.financial-details-table__value",
    )
    .first();
  if (tfoot.length > 0) {
    total = normalizeCurrency(tfoot.text());
  } else {
    total = parsed.get("total") ?? null;
  }

  return { land, building, total };
}

function parseTaxTable(
  $: cheerio.CheerioAPI,
  section: cheerio.Cheerio<AnyNode>,
): { municipalTax: number | null; schoolTax: number | null } {
  let taxTable: cheerio.Cheerio<AnyNode> | null = null;
  for (const sel of detailSelectors.taxTable) {
    const el = section.find(sel).first();
    if (el.length > 0) {
      taxTable = el;
      break;
    }
  }
  if (!taxTable || taxTable.length === 0) {
    return { municipalTax: null, schoolTax: null };
  }

  const parsed = parseFinanceTable($, taxTable, TAX_LABELS);
  return {
    municipalTax: parsed.get("municipal") ?? null,
    schoolTax: parsed.get("school") ?? null,
  };
}

export function parseListingDetail(
  html: string,
  _sourceUrl: string,
  summary?: ListingSummary,
): ListingDetail {
  const $ = cheerio.load(html);

  const listingId = extractListingId($);

  const detail: ListingDetail = {
    listingId,
    url: summary?.url ?? _sourceUrl,
    price: extractPrice($),
    priceRaw: null,
    address: extractAddress($),
    propertyType: extractPropertyType($),
    bedrooms: extractBedrooms($),
    bathrooms: extractBathrooms($),
    brokerId: extractBrokerId($),
    brokerName: extractBrokerName($),
    brokerPhone: extractBrokerPhone($),
    brokerProfileUrl: extractBrokerProfileUrl($),
    agencyName: extractAgencyName($),
    rooms: extractRooms($),
    livingArea: extractLivingArea($),
    yearBuilt: extractYearBuilt($),
    parking: extractParking($),
    latitude: extractLatitude($),
    longitude: extractLongitude($),
    landAssessment: null,
    buildingAssessment: null,
    totalAssessment: null,
    municipalTax: null,
    schoolTax: null,
    condoFees: null,
    scrapedAt: new Date().toISOString(),
  };

  const financialSection = findFinancialSection($);
  if (financialSection) {
    const assessments = parseAssessmentTable($, financialSection);
    detail.landAssessment = assessments.land;
    detail.buildingAssessment = assessments.building;
    detail.totalAssessment = assessments.total;

    const taxes = parseTaxTable($, financialSection);
    detail.municipalTax = taxes.municipalTax;
    detail.schoolTax = taxes.schoolTax;

    detail.condoFees = extractCondoFees($, financialSection);
  }

  if (summary) {
    if (detail.price == null) {
      detail.price = summary.price;
      detail.priceRaw = summary.priceRaw;
    }
    detail.address ??= summary.address;
    detail.propertyType ??= summary.propertyType;
    detail.bedrooms ??= summary.bedrooms;
    detail.bathrooms ??= summary.bathrooms;
  }

  return detail;
}
