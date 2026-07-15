export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveUrl(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  const prefix = href.startsWith("/") ? "" : "/";
  return `https://www.centris.ca${prefix}${href}`;
}

export function extractNumericId(url: string): string {
  const match = /(\d{6,})/.exec(url);
  return match ? match[1] : "";
}

export function buildSearchPageUrl(
  baseUrl: string,
  page: number,
  pageSize: number,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  return url.toString();
}
