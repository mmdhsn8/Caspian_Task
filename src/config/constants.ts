export const PROJECT = {
  NAME: "centris-scraper",
  VERSION: "1.0.0",
} as const;

export const CENTRIS_BASE_URL = "https://www.centris.ca" as const;

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" as const;

export const DEFAULT_ACCEPT_LANGUAGE = "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7" as const;

export const BROWSER_CONTEXT_HEADERS: Record<string, string> = {
  "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
  DNT: "1",
  "Upgrade-Insecure-Requests": "1",
};

export const BROWSER_LAUNCH_ARGS = [
  "--disable-background-networking",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-component-extensions-with-browser-start",
  "--disable-component-update",
  "--disable-field-trial-config",
] as const satisfies readonly string[];
