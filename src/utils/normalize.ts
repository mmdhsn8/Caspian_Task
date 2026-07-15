export function normalizePrice(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  return Number.isNaN(value) ? null : value;
}

export function normalizeText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeInteger(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const re = /(\d+)/;
  const match = re.exec(raw);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

export function normalizeArea(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const match = /([\d,]+)\s*(?:sqft|sq\.?\s*ft\.?|pi2|p\.?c\.?)/i.exec(raw);
  if (!match) return null;
  const value = parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isNaN(value) ? null : value;
}

export function normalizeCurrency(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  return Number.isNaN(value) ? null : value;
}
