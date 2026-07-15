import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from "playwright";
import { env } from "../config/env.js";
import {
  BROWSER_LAUNCH_ARGS,
  BROWSER_CONTEXT_HEADERS,
  DEFAULT_USER_AGENT,
} from "../config/constants.js";

export interface BrowserSession {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  close: () => Promise<void>;
}

export async function createBrowserSession(): Promise<BrowserSession> {
  const launchOptions: LaunchOptions = {
    headless: env.headless,
    args: [...BROWSER_LAUNCH_ARGS],
    slowMo: env.slowMoMs,
    ...(env.browserChannel === "chromium" ? {} : { channel: env.browserChannel }),
  };

  let browser: Browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (originalError) {
    if (env.browserChannel !== "chromium") {
      throw new Error(
        `Failed to launch browser channel "${env.browserChannel}". ` +
          `Install Google Chrome, switch BROWSER_CHANNEL to "msedge", ` +
          `or use "chromium" after running "npx playwright install chromium".`,
        { cause: originalError },
      );
    }
    throw originalError;
  }

  try {
    const contextOptions: Record<string, unknown> = {
      viewport: { width: env.viewport.width, height: env.viewport.height },
      locale: env.locale,
      timezoneId: env.timezone,
      userAgent: DEFAULT_USER_AGENT,
      extraHTTPHeaders: BROWSER_CONTEXT_HEADERS,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      colorScheme: "light",
      reducedMotion: "no-preference",
      serviceWorkers: "allow",
    };

    const context = await browser.newContext(contextOptions);

    try {
      const page = await context.newPage();
      page.setDefaultTimeout(env.scraperTimeoutMs);
      page.setDefaultNavigationTimeout(env.scraperTimeoutMs);

      let closed = false;

      const close = async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await context.close();
        } finally {
          await browser.close();
        }
      };

      return { browser, context, page, close };
    } catch (pageError) {
      await context.close();
      await browser.close();
      throw pageError;
    }
  } catch (contextError) {
    await browser.close();
    throw contextError;
  }
}
