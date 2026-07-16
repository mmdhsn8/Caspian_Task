/**
 * Centris Scraper — Google Apps Script Web App
 *
 * Syncs current Centris listings with Google Sheets.
 *
 * Deploy as:
 * - Type: Web App
 * - Execute as: Me
 * - Who has access: Anyone
 *
 * Supported actions:
 *
 * "sync" (default):
 * {
 *   "action": "sync",
 *   "checkedAt": "2026-07-14T12:34:56.000Z",
 *   "rows": [[25 scraper columns]]
 * }
 *
 * "ackTelegram":
 * {
 *   "action": "ackTelegram",
 *   "results": [
 *     {
 *       "listingId": "19475885",
 *       "success": true,
 *       "messageId": 8,
 *       "attempts": 1,
 *       "error": null,
 *       "sentAt": "2026-07-14T09:20:51.048Z"
 *     }
 *   ]
 * }
 */

const EXPECTED_KEY = "centris-X9m2K7pQ-2026";

const SHEET_NAME = "Sheet1";

const INCOMING_COLS = 25;
const FULL_COLS = 34;

const IDX = Object.freeze({
  LISTING_ID: 0,
  PROPERTY_URL: 1,

  ADDRESS: 2,
  PROPERTY_TYPE: 3,
  ROOMS: 4,
  BEDROOMS: 5,
  BATHROOMS: 6,
  LIVING_AREA: 7,
  YEAR_BUILT: 8,
  PARKING: 9,
  LATITUDE: 10,
  LONGITUDE: 11,

  PRICE: 12,
  LAND_ASSESSMENT: 13,
  BUILDING_ASSESSMENT: 14,
  TOTAL_ASSESSMENT: 15,
  MUNICIPAL_TAX: 16,
  SCHOOL_TAX: 17,
  CONDO_FEES: 18,

  BROKER_ID: 19,
  BROKER_NAME: 20,
  BROKER_PHONE: 21,
  BROKER_PROFILE_URL: 22,
  AGENCY_NAME: 23,

  SCRAPED_AT: 24,

  FIRST_SEEN: 25,
  LAST_SEEN: 26,
  LAST_CHECKED: 27,
  STATUS: 28,

  TELEGRAM_STATUS: 29,
  TELEGRAM_SENT_AT: 30,
  TELEGRAM_MESSAGE_ID: 31,
  TELEGRAM_ATTEMPTS: 32,
  TELEGRAM_LAST_ERROR: 33,
});

const HEADERS = [
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
];

const BUSINESS_FIELD_INDICES = [
  IDX.PROPERTY_URL,
  IDX.ADDRESS,
  IDX.PROPERTY_TYPE,
  IDX.ROOMS,
  IDX.BEDROOMS,
  IDX.BATHROOMS,
  IDX.LIVING_AREA,
  IDX.YEAR_BUILT,
  IDX.PARKING,
  IDX.LATITUDE,
  IDX.LONGITUDE,
  IDX.PRICE,
  IDX.LAND_ASSESSMENT,
  IDX.BUILDING_ASSESSMENT,
  IDX.TOTAL_ASSESSMENT,
  IDX.MUNICIPAL_TAX,
  IDX.SCHOOL_TAX,
  IDX.CONDO_FEES,
  IDX.BROKER_ID,
  IDX.BROKER_NAME,
  IDX.BROKER_PHONE,
  IDX.BROKER_PROFILE_URL,
  IDX.AGENCY_NAME,
];

const NUMERIC_FIELD_INDICES = [
  IDX.ROOMS,
  IDX.BEDROOMS,
  IDX.BATHROOMS,
  IDX.LIVING_AREA,
  IDX.YEAR_BUILT,
  IDX.LATITUDE,
  IDX.LONGITUDE,
  IDX.PRICE,
  IDX.LAND_ASSESSMENT,
  IDX.BUILDING_ASSESSMENT,
  IDX.TOTAL_ASSESSMENT,
  IDX.MUNICIPAL_TAX,
  IDX.SCHOOL_TAX,
  IDX.CONDO_FEES,
];

const NEW_ROW_HIGHLIGHT_MINUTES = 10;
const NEW_ROW_HIGHLIGHT_FILL = "#E5E7EB";
const SHEET_TIMESTAMP_DISPLAY_FORMAT = "yyyy-MM-dd HH:mm";

/**
 * Main Web App entry point.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;

  try {
    lock.waitLock(30000);
    lockAcquired = true;
  } catch (_) {
    return jsonResponse({
      success: false,
      error: "Could not acquire execution lock",
      code: "LOCK_TIMEOUT",
    });
  }

  try {
    validateApiKey(e);

    const payload = parsePayload(e);
    const action = payload.action || "sync";

    if (action === "ackTelegram") {
      return handleAckTelegram(payload);
    }

    return handleSync(payload);
  } catch (error) {
    const code = error && error.code ? String(error.code) : "INTERNAL_ERROR";
    return jsonResponse({
      success: false,
      error: getErrorMessage(error),
      code: code,
    });
  } finally {
    if (lockAcquired && lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

/**
 * Sync action: classify incoming rows and store to sheet.
 */
function handleSync(payload) {
  const checkedAt = validateCheckedAt(payload.checkedAt);
  const incomingRows = validateIncomingRows(payload.rows);

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(spreadsheet);

  ensureHeaders(sheet);

  const existingRows = readExistingRows(sheet);
  const existingMap = createExistingMap(existingRows);

  const syncResult = synchronizeRows(
    incomingRows,
    existingRows,
    existingMap,
    checkedAt,
  );

  writeRows(sheet, syncResult.outputRows);
  formatSheet(sheet);

  return jsonResponse({
    success: true,
    received: incomingRows.length,
    newCount: syncResult.newListingIds.length,
    updatedCount: syncResult.updatedListingIds.length,
    unchangedCount: syncResult.unchangedListingIds.length,
    totalStored: syncResult.outputRows.length,
    newListingIds: syncResult.newListingIds,
    updatedListingIds: syncResult.updatedListingIds,
    pendingTelegramListingIds: syncResult.pendingTelegramListingIds,
    checkedAt: checkedAt,
  });
}

/**
 * ackTelegram action: update delivery metadata for notified listings.
 */
function handleAckTelegram(payload) {
  if (!payload.results || !Array.isArray(payload.results)) {
    return jsonResponse({
      success: false,
      error: "results array is required",
      code: "BAD_REQUEST",
    });
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(spreadsheet);
  ensureHeaders(sheet);

  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({
      success: true,
      updatedCount: 0,
      notFoundCount: payload.results.length,
    });
  }

  // Read all data rows, build listingId → rowIndex map
  const data = sheet.getRange(2, 1, lastRow - 1, FULL_COLS).getValues();
  const idToRowIndex = {};

  for (var ri = 0; ri < data.length; ri++) {
    const id = normalizeText(data[ri][IDX.LISTING_ID]);

    if (id) {
      idToRowIndex[id] = ri;
    }
  }

  var updatedCount = 0;
  var notFoundCount = 0;

  payload.results.forEach(function (result) {
    const targetId = normalizeText(result.listingId);

    if (!targetId || !(targetId in idToRowIndex)) {
      notFoundCount++;
      return;
    }

    const rowIndex = idToRowIndex[targetId];
    var row = data[rowIndex];

    // Normalize to ensure FULL_COLS width (handles sheet migration)
    var normalized = new Array(FULL_COLS).fill("");

    for (var ci = 0; ci < FULL_COLS && ci < row.length; ci++) {
      normalized[ci] = toSheetValue(row[ci]);
    }

    if (result.success) {
      normalized[IDX.TELEGRAM_STATUS] = "SENT";
      normalized[IDX.TELEGRAM_SENT_AT] = toSheetTimestampValue(
        result.sentAt || new Date().toISOString(),
      );
      normalized[IDX.TELEGRAM_MESSAGE_ID] = String(result.messageId ?? "");
      var currentAttempts =
        typeof normalized[IDX.TELEGRAM_ATTEMPTS] === "number"
          ? normalized[IDX.TELEGRAM_ATTEMPTS]
          : parseInt(String(normalized[IDX.TELEGRAM_ATTEMPTS]), 10) || 0;
      normalized[IDX.TELEGRAM_ATTEMPTS] =
        currentAttempts + (result.attempts || 1);
      normalized[IDX.TELEGRAM_LAST_ERROR] = "";
    } else {
      normalized[IDX.TELEGRAM_STATUS] = "FAILED";
      var currentAttempts =
        typeof normalized[IDX.TELEGRAM_ATTEMPTS] === "number"
          ? normalized[IDX.TELEGRAM_ATTEMPTS]
          : parseInt(String(normalized[IDX.TELEGRAM_ATTEMPTS]), 10) || 0;
      normalized[IDX.TELEGRAM_ATTEMPTS] =
        currentAttempts + (result.attempts || 1);
      normalized[IDX.TELEGRAM_LAST_ERROR] = result.error
        ? String(result.error).substring(0, 500)
        : "";
    }

    data[rowIndex] = normalized;
    updatedCount++;
  });

  if (updatedCount > 0) {
    writeRows(sheet, data);
    formatSheet(sheet);
    SpreadsheetApp.flush();
  }

  return jsonResponse({
    success: true,
    updatedCount: updatedCount,
    notFoundCount: notFoundCount,
    reason: notFoundCount > 0 ? "Some listing IDs were not found" : undefined,
  });
}

/**
 * Validates the query-string API key.
 */
function validateApiKey(e) {
  if (!EXPECTED_KEY) {
    throw new Error("EXPECTED_KEY is not configured");
  }

  const requestKey = e && e.parameter ? e.parameter.key : null;

  if (requestKey !== EXPECTED_KEY) {
    throw new Error("Invalid or missing API key");
  }
}

/**
 * Parses the JSON request body.
 */
function parsePayload(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Request body is missing");
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (_) {
    throw new Error("Request body is not valid JSON");
  }
}

/**
 * Validates the run-level timestamp.
 */
function validateCheckedAt(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("checkedAt is required");
  }

  const timestamp = value.trim();
  const parsed = new Date(timestamp);

  if (isNaN(parsed.getTime())) {
    throw new Error("checkedAt must be a valid ISO timestamp");
  }

  return timestamp;
}

/**
 * Validates incoming 25-column rows.
 */
function validateIncomingRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("rows must be an array");
  }

  if (rows.length === 0) {
    throw new Error("rows must not be empty");
  }

  const seenListingIds = {};

  rows.forEach(function (row, index) {
    if (!Array.isArray(row)) {
      throw new Error("Row " + (index + 1) + " must be an array");
    }

    if (row.length !== INCOMING_COLS) {
      throw new Error(
        "Row " +
          (index + 1) +
          " has " +
          row.length +
          " columns; expected " +
          INCOMING_COLS,
      );
    }

    const listingId = normalizeText(row[IDX.LISTING_ID]);

    if (!listingId) {
      throw new Error("Row " + (index + 1) + " has no Listing ID");
    }

    if (seenListingIds[listingId]) {
      throw new Error(
        'Duplicate Listing ID "' + listingId + '" in incoming payload',
      );
    }

    seenListingIds[listingId] = true;
  });

  return rows;
}

/**
 * Gets Sheet1 or creates it.
 */
function getOrCreateSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  return sheet;
}

/**
 * Ensures the sheet has the exact FULL_COLS-column header layout.
 */
function ensureHeaders(sheet) {
  const existingHeaders = sheet
    .getRange(1, 1, 1, FULL_COLS)
    .getValues()[0];

  const headersMatch = HEADERS.every(function (header, index) {
    return normalizeText(existingHeaders[index]) === header;
  });

  if (!headersMatch) {
    sheet.getRange(1, 1, 1, FULL_COLS).setValues([HEADERS]);
  }

  sheet
    .getRange(1, 1, 1, FULL_COLS)
    .setFontWeight("bold")
    .setWrap(true);

  sheet.setFrozenRows(1);
}

/**
 * Reads all current data rows as FULL_COLS-column arrays.
 *
 * Existing 25-column rows are automatically padded with empty metadata
 * cells by Google Sheets when this wider range is read.
 */
function readExistingRows(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return [];
  }

  return sheet
    .getRange(2, 1, lastRow - 1, FULL_COLS)
    .getValues()
    .filter(function (row) {
      return normalizeText(row[IDX.LISTING_ID]) !== null;
    });
}

/**
 * Creates a map keyed by Listing ID.
 */
function createExistingMap(rows) {
  const map = {};

  rows.forEach(function (row, index) {
    const listingId = normalizeText(row[IDX.LISTING_ID]);

    if (!listingId) {
      return;
    }

    if (!map[listingId]) {
      map[listingId] = {
        outputIndex: index,
        row: row,
      };
    }
  });

  return map;
}

/**
 * Applies NEW / UPDATED / UNCHANGED logic.
 *
 * NEW listings get Telegram Status = PENDING.
 * UPDATED and UNCHANGED listings preserve their existing Telegram metadata.
 */
function synchronizeRows(
  incomingRows,
  existingRows,
  existingMap,
  checkedAt,
) {
  const outputRows = existingRows.map(function (row) {
    return normalizeFullRow(row);
  });

  const newListingIds = [];
  const updatedListingIds = [];
  const unchangedListingIds = [];

  // Collect pending IDs from existing rows (PENDING or FAILED status)
  var pendingSet = {};

  existingRows.forEach(function (row) {
    const id = normalizeText(row[IDX.LISTING_ID]);
    const telStatus = normalizeText(row[IDX.TELEGRAM_STATUS]);

    if (id && (telStatus === "PENDING" || telStatus === "FAILED")) {
      pendingSet[id] = true;
    }
  });

  incomingRows.forEach(function (incoming) {
    const listingId = normalizeText(incoming[IDX.LISTING_ID]);
    const existing = existingMap[listingId];

    if (!existing) {
      outputRows.push(
        buildFullRow(incoming, {
          firstSeen: checkedAt,
          lastSeen: checkedAt,
          lastChecked: checkedAt,
          status: "NEW",
          telegramStatus: "PENDING",
          telegramSentAt: "",
          telegramMessageId: "",
          telegramAttempts: "",
          telegramLastError: "",
        }),
      );

      newListingIds.push(listingId);
      pendingSet[listingId] = true;
      return;
    }

    const originalFirstSeen = isBlankCell(existing.row[IDX.FIRST_SEEN])
      ? checkedAt
      : existing.row[IDX.FIRST_SEEN];

    // Preserve existing Telegram metadata
    var telStatus = normalizeText(existing.row[IDX.TELEGRAM_STATUS]);
    var telSentAt = toSheetValue(existing.row[IDX.TELEGRAM_SENT_AT]);
    var telMessageId = toSheetValue(existing.row[IDX.TELEGRAM_MESSAGE_ID]);
    var telAttempts = toSheetValue(existing.row[IDX.TELEGRAM_ATTEMPTS]);
    var telLastError = toSheetValue(existing.row[IDX.TELEGRAM_LAST_ERROR]);

    // Historical rows without Telegram columns get empty values.
    // Treat empty as "SENT" (migrated) — do NOT re-notify.

    if (businessFieldsChanged(incoming, existing.row)) {
      outputRows[existing.outputIndex] = buildFullRow(incoming, {
        firstSeen: originalFirstSeen,
        lastSeen: checkedAt,
        lastChecked: checkedAt,
        status: "UPDATED",
        telegramStatus: telStatus,
        telegramSentAt: telSentAt,
        telegramMessageId: telMessageId,
        telegramAttempts: telAttempts,
        telegramLastError: telLastError,
      });

      updatedListingIds.push(listingId);
      return;
    }

    outputRows[existing.outputIndex] = buildFullRow(incoming, {
      firstSeen: originalFirstSeen,
      lastSeen: checkedAt,
      lastChecked: checkedAt,
      status: "UNCHANGED",
      telegramStatus: telStatus,
      telegramSentAt: telSentAt,
      telegramMessageId: telMessageId,
      telegramAttempts: telAttempts,
      telegramLastError: telLastError,
    });

    unchangedListingIds.push(listingId);
  });

  // Build pendingTelegramListingIds from pendingSet
  var pendingList = [];

  for (var pid in pendingSet) {
    if (pendingSet.hasOwnProperty(pid)) {
      pendingList.push(pid);
    }
  }

  return {
    outputRows: outputRows,
    newListingIds: newListingIds,
    updatedListingIds: updatedListingIds,
    unchangedListingIds: unchangedListingIds,
    pendingTelegramListingIds: pendingList,
  };
}

/**
 * Converts a 25-column scraper row to a full FULL_COLS-column sheet row.
 *
 * @param {Array}          incoming  25-column incoming row
 * @param {Object}         fields    {
 *   firstSeen, lastSeen, lastChecked, status,
 *   telegramStatus, telegramSentAt, telegramMessageId,
 *   telegramAttempts, telegramLastError
 * }
 */
function buildFullRow(incoming, fields) {
  const row = new Array(FULL_COLS).fill("");

  for (let index = 0; index < INCOMING_COLS; index++) {
    row[index] = toSheetValue(incoming[index]);
  }

  row[IDX.FIRST_SEEN] = toSheetTimestampValue(fields.firstSeen);
  row[IDX.LAST_SEEN] = toSheetTimestampValue(fields.lastSeen);
  row[IDX.LAST_CHECKED] = toSheetTimestampValue(fields.lastChecked);
  row[IDX.STATUS] = fields.status;

  row[IDX.TELEGRAM_STATUS] = fields.telegramStatus || "";
  row[IDX.TELEGRAM_SENT_AT] = fields.telegramSentAt || "";
  row[IDX.TELEGRAM_MESSAGE_ID] = fields.telegramMessageId || "";
  row[IDX.TELEGRAM_ATTEMPTS] = fields.telegramAttempts || "";
  row[IDX.TELEGRAM_LAST_ERROR] = fields.telegramLastError || "";

  return row;
}

/**
 * Guarantees an existing row has exactly FULL_COLS columns.
 */
function normalizeFullRow(row) {
  const result = new Array(FULL_COLS).fill("");

  for (let index = 0; index < FULL_COLS; index++) {
    result[index] = toSheetValue(row[index]);
  }

  return result;
}

/**
 * Compares stable business fields only.
 */
function businessFieldsChanged(incomingRow, existingRow) {
  for (let index = 0; index < BUSINESS_FIELD_INDICES.length; index++) {
    const fieldIndex = BUSINESS_FIELD_INDICES[index];

    const incomingValue = normalizeForComparison(
      incomingRow[fieldIndex],
      fieldIndex,
    );

    const existingValue = normalizeForComparison(
      existingRow[fieldIndex],
      fieldIndex,
    );

    if (incomingValue !== existingValue) {
      return true;
    }
  }

  return false;
}

/**
 * Normalizes values before comparison.
 *
 * Numeric fields are compared as numbers so "699000" and 699000
 * are treated as equal.
 */
function normalizeForComparison(value, fieldIndex) {
  if (isNumericField(fieldIndex)) {
    return normalizeNumber(value);
  }

  return normalizeText(value);
}

function isNumericField(fieldIndex) {
  return NUMERIC_FIELD_INDICES.indexOf(fieldIndex) !== -1;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return isNaN(value) ? null : value;
  }

  const normalized = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[$,]/g, "");

  if (!normalized) {
    return null;
  }

  const numberValue = Number(normalized);

  return isNaN(numberValue) ? null : numberValue;
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value)
    .trim()
    .replace(/\s+/g, " ");

  return normalized ? normalized : null;
}

function isBlankCell(value) {
  return value === null || value === undefined || normalizeText(value) === null;
}

function parseIsoTimestampText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      normalized,
    )
  ) {
    return null;
  }

  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function toSheetTimestampValue(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? "" : value;
  }

  if (value === null || value === undefined || value === "") {
    return "";
  }

  const parsed = parseIsoTimestampText(value);
  return parsed || value;
}

/**
 * Converts null or undefined to an empty Google Sheets cell.
 */
function toSheetValue(value) {
  return value === null || value === undefined ? "" : value;
}

/**
 * Rewrites all preserved, updated and newly appended rows.
 *
 * Listings absent from the current scrape remain in outputRows unchanged.
 */
function writeRows(sheet, rows) {
  const currentLastRow = sheet.getLastRow();

  if (rows.length > 0) {
    sheet
      .getRange(2, 1, rows.length, FULL_COLS)
      .setValues(rows);
  }

  const firstUnusedRow = rows.length + 2;

  if (currentLastRow >= firstUnusedRow) {
    sheet
      .getRange(
        firstUnusedRow,
        1,
        currentLastRow - firstUnusedRow + 1,
        FULL_COLS,
      )
      .clearContent();
  }
}

/**
 * Applies lightweight formatting.
 */
function formatSheet(sheet) {
  sheet.autoResizeColumns(1, FULL_COLS);
  sheet.setFrozenRows(1);

  const lastRow = sheet.getLastRow();
  const firstSeenColumn = findHeaderColumn(sheet, "First Seen");
  const lastSeenColumn = findHeaderColumn(sheet, "Last Seen");
  const lastCheckedColumn = findHeaderColumn(sheet, "Last Checked");
  const statusColumn = findHeaderColumn(sheet, "Status");
  const scrapedAtColumn = findHeaderColumn(sheet, "Scraped At");

  if (lastRow > 1) {
    migrateIsoTextTimestamps(sheet, [firstSeenColumn, lastSeenColumn, lastCheckedColumn]);
    applyRecentNewRowBackgrounds(sheet, firstSeenColumn, statusColumn);

    sheet
      .getRange(2, IDX.PRICE + 1, lastRow - 1, 7)
      .setNumberFormat("#,##0");

    sheet
      .getRange(2, IDX.LATITUDE + 1, lastRow - 1, 2)
      .setNumberFormat("0.000000");

    sheet
      .getRange(2, firstSeenColumn, lastRow - 1, 1)
      .setNumberFormat(SHEET_TIMESTAMP_DISPLAY_FORMAT);

    sheet
      .getRange(2, lastSeenColumn, lastRow - 1, 1)
      .setNumberFormat(SHEET_TIMESTAMP_DISPLAY_FORMAT);

    sheet
      .getRange(2, lastCheckedColumn, lastRow - 1, 1)
      .setNumberFormat(SHEET_TIMESTAMP_DISPLAY_FORMAT);

    sheet
      .getRange(2, scrapedAtColumn, lastRow - 1, 1)
      .setNumberFormat("@");
  }
}

/**
 * Backfills historical ISO text cells into real Date values once so
 * Sheets can display them using its own timezone-aware number format.
 */
function migrateIsoTextTimestamps(sheet, columns) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return;
  }

  columns.forEach(function (column) {
    const range = sheet.getRange(2, column, lastRow - 1, 1);
    const values = range.getValues();
    let changed = false;

    const updated = values.map(function (row) {
      const current = row[0];
      const parsed = parseIsoTimestampText(current);

      if (parsed) {
        changed = true;
        return [parsed];
      }

      return [current];
    });

    if (changed) {
      range.setValues(updated);
    }
  });
}

/**
 * Highlights only recent NEW rows and clears the highlight once they age out.
 * Rows outside the current populated range are never touched.
 */
function applyRecentNewRowBackgrounds(sheet, firstSeenColumn, statusColumn) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow <= 1 || lastColumn <= 0) {
    return;
  }

  const dataRange = sheet.getRange(2, 1, lastRow - 1, lastColumn);
  const values = dataRange.getValues();
  const backgrounds = dataRange.getBackgrounds();
  const nowMs = new Date().getTime();
  const maxAgeMs = NEW_ROW_HIGHLIGHT_MINUTES * 60 * 1000;
  let changed = false;

  for (var rowIndex = 0; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    const status = normalizeText(row[statusColumn - 1]);
    const firstSeenValue = row[firstSeenColumn - 1];
    const highlight =
      status === "NEW" &&
      firstSeenValue instanceof Date &&
      !isNaN(firstSeenValue.getTime()) &&
      nowMs >= firstSeenValue.getTime() &&
      nowMs - firstSeenValue.getTime() <= maxAgeMs;
    const rowIsHighlighted = backgrounds[rowIndex].every(function (color) {
      return color === NEW_ROW_HIGHLIGHT_FILL;
    });

    if (highlight && !rowIsHighlighted) {
      backgrounds[rowIndex] = new Array(lastColumn).fill(NEW_ROW_HIGHLIGHT_FILL);
      changed = true;
    } else if (!highlight && rowIsHighlighted) {
      backgrounds[rowIndex] = new Array(lastColumn).fill("#ffffff");
      changed = true;
    }
  }

  if (changed) {
    dataRange.setBackgrounds(backgrounds);
  }
}

function findHeaderColumn(sheet, headerName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  for (var index = 0; index < headers.length; index++) {
    if (normalizeText(headers[index]) === headerName) {
      return index + 1;
    }
  }

  throw new Error('Missing required header "' + headerName + '"');
}

function getDuplicateIds(rows) {
  const seen = {};
  const dups = [];

  rows.forEach(function (row) {
    const id = normalizeText(row[IDX.LISTING_ID]);

    if (id) {
      if (seen[id]) {
        dups.push(id);
      }

      seen[id] = true;
    }
  });

  return dups;
}

function getExistingIdsNotInIncoming(existingMap, incomingRows) {
  const incomingIds = {};

  incomingRows.forEach(function (row) {
    const id = normalizeText(row[IDX.LISTING_ID]);

    if (id) {
      incomingIds[id] = true;
    }
  });

  const orphanIds = [];

  for (var id in existingMap) {
    if (existingMap.hasOwnProperty(id) && !incomingIds[id]) {
      orphanIds.push(id);
    }
  }

  return orphanIds;
}

function getErrorMessage(error) {
  if (error && error.message) {
    return String(error.message);
  }

  return String(error);
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(
    JSON.stringify(payload),
  ).setMimeType(ContentService.MimeType.JSON);
}
