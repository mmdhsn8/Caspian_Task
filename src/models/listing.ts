import type { ListingSummary } from "../parser/listing.js";

export type { ListingSummary };

export const SCRAPER_ROW_LENGTH = 25;

export interface ListingDetail extends ListingSummary {
  brokerId: string | null;
  brokerName: string | null;
  brokerPhone: string | null;
  brokerProfileUrl: string | null;
  agencyName: string | null;
  rooms: number | null;
  livingArea: number | null;
  yearBuilt: number | null;
  parking: string | null;
  latitude: number | null;
  longitude: number | null;
  landAssessment: number | null;
  buildingAssessment: number | null;
  totalAssessment: number | null;
  municipalTax: number | null;
  schoolTax: number | null;
  condoFees: number | null;
  scrapedAt: string;
}

export const SHEET_HEADERS: readonly string[] = [
  "Listing ID",
  "Property URL",

  "Address",
  "Property Type",
  "Rooms",
  "Bedrooms",
  "Bathrooms",
  "Living Area",
  "Year Built",
  "Parking",
  "Latitude",
  "Longitude",

  "Price",
  "Land Assessment",
  "Building Assessment",
  "Total Assessment",
  "Municipal Tax",
  "School Tax",
  "Condo Fees",

  "Broker ID",
  "Broker Name",
  "Broker Phone",
  "Broker Profile URL",
  "Agency Name",

  "Scraped At",
  "First Seen",
  "Last Seen",
  "Last Checked",
  "Status",

  "Telegram Status",
  "Telegram Sent At",
  "Telegram Message ID",
  "Telegram Attempts",
  "Telegram Last Error",
] as const;

export const SHEET_COL_COUNT = SHEET_HEADERS.length; // 34

export function detailToRow(detail: ListingDetail): (string | number | null)[] {
  return [
    detail.listingId,
    detail.url,
    detail.address,
    detail.propertyType,
    detail.rooms,
    detail.bedrooms,
    detail.bathrooms,
    detail.livingArea,
    detail.yearBuilt,
    detail.parking,
    detail.latitude,
    detail.longitude,
    detail.price,
    detail.landAssessment,
    detail.buildingAssessment,
    detail.totalAssessment,
    detail.municipalTax,
    detail.schoolTax,
    detail.condoFees,
    detail.brokerId,
    detail.brokerName,
    detail.brokerPhone,
    detail.brokerProfileUrl,
    detail.agencyName,
    detail.scrapedAt,
  ];
}
