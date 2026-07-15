import { config } from "dotenv";
import { z } from "zod";

config();

const telegramBotTokenSchema = z
  .string()
  .min(1, "TELEGRAM_BOT_TOKEN must not be empty")
  .refine((val) => /^\d+:[A-Za-z0-9_-]+$/.test(val), {
    message: "TELEGRAM_BOT_TOKEN must match the format: <numeric_id>:<token_string>",
  });

const telegramChatIdSchema = z
  .string()
  .min(1, "TELEGRAM_CHAT_ID must not be empty")
  .refine((val) => /^(-?\d+|@.+)$/.test(val), {
    message: "TELEGRAM_CHAT_ID must be a numeric ID or a @username",
  });

function intRange(min: number, max: number, label: string, defaultVal: number) {
  return z
    .string()
    .default(String(defaultVal))
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(min, label + " must be at least " + String(min))
        .max(max, label + " must be at most " + String(max)),
    );
}

function booleanValue(name: string, defaultValue: boolean) {
  return z
    .string()
    .default(String(defaultValue))
    .refine((value) => value === "true" || value === "false", {
      message: name + " must be 'true' or 'false'",
    })
    .transform((value) => value === "true");
}

function numberRange(min: number, max: number, label: string, defaultVal: number) {
  return z
    .string()
    .default(String(defaultVal))
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, label + " must be at least " + String(min))
        .max(max, label + " must be at most " + String(max)),
    );
}

const envSchema = z.object({
  CENTRIS_SEARCH_URL: z
    .string()
    .url()
    .refine(
      (val) => {
        try {
          const url = new URL(val);
          return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            (url.hostname === "centris.ca" || url.hostname.endsWith(".centris.ca"))
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "CENTRIS_SEARCH_URL must point to centris.ca or a subdomain of centris.ca (https required)",
      },
    ),

  HEADLESS: booleanValue("HEADLESS", true),

  SCRAPER_TIMEOUT_MS: intRange(5000, 120000, "SCRAPER_TIMEOUT_MS", 30000),

  SCRAPER_LOCALE: z.string().min(1).default("en-CA"),

  SCRAPER_TIMEZONE: z.string().min(1).default("America/Toronto"),

  SCRAPER_VIEWPORT_WIDTH: intRange(800, 3840, "SCRAPER_VIEWPORT_WIDTH", 1440),

  SCRAPER_VIEWPORT_HEIGHT: intRange(600, 2160, "SCRAPER_VIEWPORT_HEIGHT", 900),

  SCRAPER_SLOW_MO_MS: intRange(0, 5000, "SCRAPER_SLOW_MO_MS", 0),

  BROWSER_CHANNEL: z.enum(["chrome", "msedge", "chromium"]).default("chrome"),

  SEARCH_PAGE_SIZE: intRange(1, 100, "SEARCH_PAGE_SIZE", 20),

  MAX_SEARCH_PAGES: intRange(1, 100, "MAX_SEARCH_PAGES", 20),

  SEARCH_MAX_LISTINGS: intRange(1, 5000, "SEARCH_MAX_LISTINGS", 500),

  DETAIL_CONCURRENCY: intRange(1, 5, "DETAIL_CONCURRENCY", 3),

  REQUEST_DELAY_MS: intRange(0, 5000, "REQUEST_DELAY_MS", 400),

  PAGE_NAVIGATION_DELAY_MS: intRange(0, 5000, "PAGE_NAVIGATION_DELAY_MS", 500),

  DETAIL_RECHECK_MODE: z
    .string()
    .refine((v) => v === "all" || v === "changed-only", {
      message: "DETAIL_RECHECK_MODE must be 'all' or 'changed-only'",
    })
    .default("all"),

  DETAIL_RECHECK_HOURS: intRange(1, 168, "DETAIL_RECHECK_HOURS", 24),

  RUN_ID_PREFIX: z.string().min(1).default("centris"),

  GOOGLE_APPS_SCRIPT_URL: z.string().optional(),
  GOOGLE_APPS_SCRIPT_KEY: z.string().optional(),

  TELEGRAM_ENABLED: booleanValue("TELEGRAM_ENABLED", true),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  TELEGRAM_PARSE_MODE: z.enum(["HTML", "MarkdownV2"]).default("HTML"),

  TELEGRAM_SEND_DELAY_MS: intRange(0, 5000, "TELEGRAM_SEND_DELAY_MS", 500),

  TELEGRAM_MAX_RETRIES: intRange(0, 5, "TELEGRAM_MAX_RETRIES", 2),

  TELEGRAM_RETRY_DELAY_MS: intRange(100, 10000, "TELEGRAM_RETRY_DELAY_MS", 1000),

  SCHEDULER_ENABLED: booleanValue("SCHEDULER_ENABLED", true),
  SCHEDULE_INTERVAL_MINUTES: intRange(1, 1440, "SCHEDULE_INTERVAL_MINUTES", 30),
  SCHEDULE_RUN_ON_START: booleanValue("SCHEDULE_RUN_ON_START", true),

  RUN_LOCK_ENABLED: booleanValue("RUN_LOCK_ENABLED", true),
  RUN_LOCK_PATH: z.string().min(1).default(".runtime/centris-scraper.lock"),
  RUN_LOCK_STALE_MINUTES: intRange(1, 10080, "RUN_LOCK_STALE_MINUTES", 180),

  FAILURE_ALERTS_ENABLED: booleanValue("FAILURE_ALERTS_ENABLED", false),
  TELEGRAM_ALERT_CHAT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
  FAILURE_ALERT_COOLDOWN_MINUTES: intRange(1, 1440, "FAILURE_ALERT_COOLDOWN_MINUTES", 60),

  FAIL_TEST_ENABLED: booleanValue("FAIL_TEST_ENABLED", false),
  FAIL_TEST_STAGE: z.enum(["none", "search", "sheet-sync"]).default("none"),

  METRICS_ENABLED: booleanValue("METRICS_ENABLED", true),
  METRICS_PATH: z.string().min(1).default(".runtime/metrics.json"),
  METRICS_HISTORY_LIMIT: intRange(10, 10000, "METRICS_HISTORY_LIMIT", 500),
  METRICS_FLUSH_MODE: z.literal("per-run").default("per-run"),

  HEALTH_REPORT_ENABLED: booleanValue("HEALTH_REPORT_ENABLED", true),
  HEALTH_REPORT_PATH: z.string().min(1).default(".runtime/health.json"),

  RETRY_MAX_ATTEMPTS: intRange(1, 10, "RETRY_MAX_ATTEMPTS", 3),
  RETRY_BASE_DELAY_MS: intRange(100, 10000, "RETRY_BASE_DELAY_MS", 500),
  RETRY_MAX_DELAY_MS: intRange(500, 60000, "RETRY_MAX_DELAY_MS", 10000),
  RETRY_JITTER_RATIO: numberRange(0, 1, "RETRY_JITTER_RATIO", 0.2),
  SEARCH_RETRY_MAX_ATTEMPTS: intRange(1, 10, "SEARCH_RETRY_MAX_ATTEMPTS", 3),
  DETAIL_RETRY_MAX_ATTEMPTS: intRange(1, 10, "DETAIL_RETRY_MAX_ATTEMPTS", 3),
  SHEET_RETRY_MAX_ATTEMPTS: intRange(1, 10, "SHEET_RETRY_MAX_ATTEMPTS", 3),

  RATE_LIMIT_ENABLED: booleanValue("RATE_LIMIT_ENABLED", true),
  SEARCH_REQUESTS_PER_MINUTE: intRange(1, 120, "SEARCH_REQUESTS_PER_MINUTE", 20),
  DETAIL_REQUESTS_PER_MINUTE: intRange(1, 300, "DETAIL_REQUESTS_PER_MINUTE", 30),
  RATE_LIMIT_BURST: intRange(1, 20, "RATE_LIMIT_BURST", 3),

  DETAIL_CACHE_ENABLED: booleanValue("DETAIL_CACHE_ENABLED", true),
  DETAIL_CACHE_PATH: z.string().min(1).default(".runtime/detail-cache.json"),
  DETAIL_CACHE_TTL_HOURS: intRange(1, 720, "DETAIL_CACHE_TTL_HOURS", 24),
  DETAIL_CACHE_MAX_ENTRIES: intRange(100, 100000, "DETAIL_CACHE_MAX_ENTRIES", 5000),
  DETAIL_CACHE_SCHEMA_VERSION: intRange(1, 1000, "DETAIL_CACHE_SCHEMA_VERSION", 1),

  API_PORT: intRange(1024, 65535, "API_PORT", 8787),

  WORKFLOW_API_KEY: z.string().min(1, "WORKFLOW_API_KEY must not be empty").optional(),
});

type EnvSchema = z.infer<typeof envSchema>;

let parsed: EnvSchema;
try {
  parsed = envSchema.parse(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    const messages = err.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${messages}`);
  }
  throw err;
}

if (parsed.TELEGRAM_ENABLED) {
  if (!parsed.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED=true");
  }
  const tokenResult = telegramBotTokenSchema.safeParse(parsed.TELEGRAM_BOT_TOKEN);
  if (!tokenResult.success) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is invalid. Expected format: <numeric_id>:<token_string>",
    );
  }
  if (!parsed.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID is required when TELEGRAM_ENABLED=true");
  }
  const chatResult = telegramChatIdSchema.safeParse(parsed.TELEGRAM_CHAT_ID);
  if (!chatResult.success) {
    throw new Error(
      "TELEGRAM_CHAT_ID is invalid. Must be a numeric ID (e.g. -100123456789) or a @username",
    );
  }
}

if (parsed.FAILURE_ALERTS_ENABLED) {
  if (!parsed.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required when FAILURE_ALERTS_ENABLED=true");
  }
  if (!telegramBotTokenSchema.safeParse(parsed.TELEGRAM_BOT_TOKEN).success) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is invalid. Expected format: <numeric_id>:<token_string>",
    );
  }
  const alertChatId = parsed.TELEGRAM_ALERT_CHAT_ID ?? parsed.TELEGRAM_CHAT_ID;
  if (!alertChatId) {
    throw new Error(
      "TELEGRAM_ALERT_CHAT_ID or TELEGRAM_CHAT_ID is required when FAILURE_ALERTS_ENABLED=true",
    );
  }
  if (!telegramChatIdSchema.safeParse(alertChatId).success) {
    throw new Error(
      "TELEGRAM_ALERT_CHAT_ID must be a numeric ID (e.g. -100123456789) or a @username",
    );
  }
}

export const env = Object.freeze({
  centrisSearchUrl: parsed.CENTRIS_SEARCH_URL,
  headless: parsed.HEADLESS,
  scraperTimeoutMs: parsed.SCRAPER_TIMEOUT_MS,
  browserChannel: parsed.BROWSER_CHANNEL,
  locale: parsed.SCRAPER_LOCALE,
  timezone: parsed.SCRAPER_TIMEZONE,
  viewport: Object.freeze({
    width: parsed.SCRAPER_VIEWPORT_WIDTH,
    height: parsed.SCRAPER_VIEWPORT_HEIGHT,
  }),
  slowMoMs: parsed.SCRAPER_SLOW_MO_MS,
  searchPageSize: parsed.SEARCH_PAGE_SIZE,
  maxSearchPages: parsed.MAX_SEARCH_PAGES,
  searchMaxListings: parsed.SEARCH_MAX_LISTINGS,
  detailConcurrency: parsed.DETAIL_CONCURRENCY,
  requestDelayMs: parsed.REQUEST_DELAY_MS,
  pageNavigationDelayMs: parsed.PAGE_NAVIGATION_DELAY_MS,
  detailRecheckMode: parsed.DETAIL_RECHECK_MODE,
  detailRecheckHours: parsed.DETAIL_RECHECK_HOURS,
  runIdPrefix: parsed.RUN_ID_PREFIX,
  googleAppsScriptUrl: parsed.GOOGLE_APPS_SCRIPT_URL,
  googleAppsScriptKey: parsed.GOOGLE_APPS_SCRIPT_KEY,
  telegramEnabled: parsed.TELEGRAM_ENABLED,
  telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
  telegramChatId: parsed.TELEGRAM_CHAT_ID,
  telegramParseMode: parsed.TELEGRAM_PARSE_MODE,
  telegramSendDelayMs: parsed.TELEGRAM_SEND_DELAY_MS,
  telegramMaxRetries: parsed.TELEGRAM_MAX_RETRIES,
  telegramRetryDelayMs: parsed.TELEGRAM_RETRY_DELAY_MS,
  schedulerEnabled: parsed.SCHEDULER_ENABLED,
  scheduleIntervalMinutes: parsed.SCHEDULE_INTERVAL_MINUTES,
  scheduleRunOnStart: parsed.SCHEDULE_RUN_ON_START,
  runLockEnabled: parsed.RUN_LOCK_ENABLED,
  runLockPath: parsed.RUN_LOCK_PATH,
  runLockStaleMinutes: parsed.RUN_LOCK_STALE_MINUTES,
  failureAlertsEnabled: parsed.FAILURE_ALERTS_ENABLED,
  telegramAlertChatId: parsed.TELEGRAM_ALERT_CHAT_ID,
  failureAlertCooldownMinutes: parsed.FAILURE_ALERT_COOLDOWN_MINUTES,
  failureInjectionEnabled: parsed.FAIL_TEST_ENABLED || process.env.NODE_ENV === "test",
  failureTestStage: parsed.FAIL_TEST_STAGE,
  metricsEnabled: parsed.METRICS_ENABLED,
  metricsPath: parsed.METRICS_PATH,
  metricsHistoryLimit: parsed.METRICS_HISTORY_LIMIT,
  metricsFlushMode: parsed.METRICS_FLUSH_MODE,
  healthReportEnabled: parsed.HEALTH_REPORT_ENABLED,
  healthReportPath: parsed.HEALTH_REPORT_PATH,
  retryMaxAttempts: parsed.RETRY_MAX_ATTEMPTS,
  retryBaseDelayMs: parsed.RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: parsed.RETRY_MAX_DELAY_MS,
  retryJitterRatio: parsed.RETRY_JITTER_RATIO,
  searchRetryMaxAttempts: parsed.SEARCH_RETRY_MAX_ATTEMPTS,
  detailRetryMaxAttempts: parsed.DETAIL_RETRY_MAX_ATTEMPTS,
  sheetRetryMaxAttempts: parsed.SHEET_RETRY_MAX_ATTEMPTS,
  rateLimitEnabled: parsed.RATE_LIMIT_ENABLED,
  searchRequestsPerMinute: parsed.SEARCH_REQUESTS_PER_MINUTE,
  detailRequestsPerMinute: parsed.DETAIL_REQUESTS_PER_MINUTE,
  rateLimitBurst: parsed.RATE_LIMIT_BURST,
  detailCacheEnabled: parsed.DETAIL_CACHE_ENABLED,
  detailCachePath: parsed.DETAIL_CACHE_PATH,
  detailCacheTtlHours: parsed.DETAIL_CACHE_TTL_HOURS,
  detailCacheMaxEntries: parsed.DETAIL_CACHE_MAX_ENTRIES,
  detailCacheSchemaVersion: parsed.DETAIL_CACHE_SCHEMA_VERSION,

  apiPort: parsed.API_PORT,
  workflowApiKey: parsed.WORKFLOW_API_KEY ?? "",
});
