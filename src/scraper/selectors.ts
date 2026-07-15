export const LISTING_ID_ATTRIBUTES = [
  "listing-id",
  "data-listing-id",
] as const satisfies readonly string[];

export const BROKER_ID_ATTRIBUTES = [
  "broker-id",
  "data-broker-id",
  "data-member-id",
] as const satisfies readonly string[];

export interface SearchSelectorGroup {
  readonly listingCard: readonly string[];
  readonly listingLink: readonly string[];
  readonly listingIdAttribute: readonly string[];
  readonly price: readonly string[];
  readonly address: readonly string[];
  readonly propertyType: readonly string[];
  readonly bedrooms: readonly string[];
  readonly bathrooms: readonly string[];
}

export const searchSelectors = Object.freeze({
  listingCard: [
    "div.property-thumbnail-item",
    "article[data-listing-id]",
    "div[data-listing-id]",
    "div.shell-card",
    "div.property-card",
  ] satisfies readonly string[],

  listingLink: [
    'a[href*="/en/properties~"]',
    'a[href*="/fr/proprietes~"]',
    'a[href*="/en/property/"]',
    "a.listing-link",
  ] satisfies readonly string[],

  listingIdAttribute: [...LISTING_ID_ATTRIBUTES] satisfies readonly string[],

  price: [
    '[itemprop="price"]',
    "[data-price]",
    ".price",
    "span.price",
  ] satisfies readonly string[],

  address: [
    '[itemprop="address"]',
    "[data-address]",
    ".address",
    "h3.address",
  ] satisfies readonly string[],

  propertyType: [
    '[itemprop="propertyType"]',
    "[data-property-type]",
    ".property-type",
  ] satisfies readonly string[],

  bedrooms: [
    '[itemprop="numberOfBedrooms"]',
    "[data-bedrooms]",
    ".bedrooms",
    ".nb-beds",
  ] satisfies readonly string[],

  bathrooms: [
    '[itemprop="numberOfBathrooms"]',
    "[data-bathrooms]",
    ".bathrooms",
    ".nb-baths",
  ] satisfies readonly string[],
} satisfies SearchSelectorGroup);

export interface DetailSelectorGroup {
  readonly listingId: readonly string[];
  readonly brokerId: readonly string[];
  readonly brokerName: readonly string[];
  readonly brokerPhone: readonly string[];
  readonly brokerProfileLink: readonly string[];
  readonly agencyName: readonly string[];
  readonly price: readonly string[];
  readonly address: readonly string[];
  readonly propertyType: readonly string[];
  readonly bedrooms: readonly string[];
  readonly bathrooms: readonly string[];
  readonly rooms: readonly string[];
  readonly livingArea: readonly string[];
  readonly yearBuilt: readonly string[];
  readonly parking: readonly string[];
  readonly characteristicsSection: readonly string[];
  readonly financialSection: readonly string[];
  readonly assessmentTable: readonly string[];
  readonly taxTable: readonly string[];
  readonly condoFeesTable: readonly string[];
  readonly latitude: readonly string[];
  readonly longitude: readonly string[];
}

export const detailSelectors = Object.freeze({
  listingId: [
    'span#ListingDisplayId[itemprop="sku"]',
    "span#ListingId",
    '[itemprop="productID"]',
    "[data-listing-id]",
  ] satisfies readonly string[],

  brokerId: [
    "div.broker-info[data-broker-id]",
    ...BROKER_ID_ATTRIBUTES,
    ".realtor-card .card-link[href]",
  ] satisfies readonly string[],

  brokerName: [
    "#broker-card-container .realtor-name",
    ".realtor-card .realtor-name",
  ] satisfies readonly string[],

  brokerPhone: [
    "#broker-card-container .realtor-card__phone-option span",
    ".realtor-card a[href^='tel:'] span",
    ".realtor-card__phone-option span",
  ] satisfies readonly string[],

  brokerProfileLink: [
    "#broker-card-container .realtor-card .card-link[href]",
    ".realtor-card .card-link[href]",
  ] satisfies readonly string[],

  agencyName: [
    "#broker-card-container .office-name",
    ".realtor-card .office-name",
  ] satisfies readonly string[],

  price: [
    'div.property-summary-header__price[itemprop="offers"] > meta[itemprop="price"]',
    "span#BuyPrice",
    '[itemprop="price"]',
    "[data-price]",
  ] satisfies readonly string[],

  address: [
    'h2.property-summary-header__address[itemprop="address"]',
    '[itemprop="address"]',
    "[data-address]",
  ] satisfies readonly string[],

  propertyType: [
    'h1.property-summary-header__title[itemprop="category"]',
    "span[data-id='PageTitle']",
    '[itemprop="category"]',
    "[data-property-type]",
  ] satisfies readonly string[],

  bedrooms: [
    "div.cac",
    '[itemprop="numberOfBedrooms"]',
    "[data-bedrooms]",
    ".bedrooms",
  ] satisfies readonly string[],

  bathrooms: [
    "div.sdb",
    '[itemprop="numberOfBathrooms"]',
    "[data-bathrooms]",
    ".bathrooms",
  ] satisfies readonly string[],

  rooms: [
    "div.piece",
    '[itemprop="numberOfRooms"]',
    "[data-rooms]",
  ] satisfies readonly string[],

  livingArea: [
    "span[data-id='Superficie']",
    "span.superficie",
  ] satisfies readonly string[],

  yearBuilt: ["span[data-id='AnneeConstruction']"] satisfies readonly string[],

  parking: ["span[data-id='Stationnement']"] satisfies readonly string[],

  characteristicsSection: [
    "#property-details-section",
    ".property-details",
  ] satisfies readonly string[],

  financialSection: [
    "section[data-financial-details]",
    ".financial-details-container",
    "[data-financial-details]",
  ] satisfies readonly string[],

  assessmentTable: [
    "[data-financial-details-time-unit-scope] > div.financial-details-table-container",
    ".financial-details-table-container",
    ".financial-details-table",
  ] satisfies readonly string[],

  taxTable: [
    "#financial-details-extra-tables .financial-details-table--yearly",
    ".financial-details-table--yearly",
    "#financial-details-extra-tables",
  ] satisfies readonly string[],

  condoFeesTable: [
    ".financial-details-table--monthly",
    ".financial-details-table",
  ] satisfies readonly string[],

  latitude: ['meta[itemprop="latitude"]', "#PropertyLat"] satisfies readonly string[],

  longitude: ['meta[itemprop="longitude"]', "#PropertyLng"] satisfies readonly string[],
} satisfies DetailSelectorGroup);

export interface PaginationSelectorGroup {
  readonly nextPage: readonly string[];
  readonly previousPage: readonly string[];
  readonly pageNumber: readonly string[];
  readonly totalResults: readonly string[];
  readonly totalPages: readonly string[];
  readonly currentPage: readonly string[];
  readonly resultContainer: readonly string[];
  readonly disabledNext: readonly string[];
}

export const paginationSelectors = Object.freeze({
  nextPage: [
    '[rel="next"]',
    "a.pagination__next",
    "a.next",
    'a[aria-label="Next"]',
    "a.page-link.next",
    "a:has(span.next)",
    "li.next a",
  ] satisfies readonly string[],

  previousPage: [
    '[rel="prev"]',
    "a.pagination__prev",
    "a.previous",
    'a[aria-label="Previous"]',
  ] satisfies readonly string[],

  pageNumber: [
    ".pagination__page",
    ".page-number",
    "[data-page-number]",
    "a.page-link:not(.next):not(.prev):not(.previous)",
    "li.page-item a.page-link",
  ] satisfies readonly string[],

  totalResults: [
    ".total-results",
    "[data-total-results]",
    ".results-count",
    ".total-count",
    "[data-total-count]",
  ] satisfies readonly string[],

  totalPages: [
    "[data-total-pages]",
    ".pagination__total",
    ".total-pages",
    ".pagination-info .total",
    "span.total",
  ] satisfies readonly string[],

  currentPage: [
    "[data-current-page]",
    ".pagination__current",
    ".current-page",
    "li.page-item.active a.page-link",
    "span.page-link.current",
    "a.page-link.active",
  ] satisfies readonly string[],

  resultContainer: [
    ".property-thumbnail-item",
    "div[data-listing-id]",
    "article[data-listing-id]",
    ".shell-card",
    ".property-card",
    ".listings-container",
    ".search-results",
  ] satisfies readonly string[],

  disabledNext: [
    "li.next.disabled a",
    "a.page-link.next.disabled",
    "span.next.disabled",
    "a.next[aria-disabled='true']",
  ] satisfies readonly string[],
} satisfies PaginationSelectorGroup);
