import { config as loadDotEnv } from "dotenv";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";

loadDotEnv();

type CheckStatus = "PASS" | "WARN" | "FAIL";

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly lines: string[];
}

export interface ConfigDoctorReport {
  readonly ok: boolean;
  readonly checks: CheckResult[];
  readonly output: string;
}

export interface ConfigDoctorDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly nodeVersion: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly ensureDirectory: (path: string) => Promise<void>;
  readonly verifyWritableDirectory: (path: string) => Promise<void>;
  readonly detectBrowser: (channel: string) => Promise<string>;
  readonly validateParsedEnv: () => Promise<void>;
}

export class ConfigDoctorError extends Error {
  readonly report!: ConfigDoctorReport;

  constructor(report: ConfigDoctorReport) {
    super("Configuration invalid");
    this.name = "ConfigDoctorError";
    Object.defineProperty(this, "report", {
      value: report,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    this.stack = this.name + ": " + this.message;
  }
}

function missingValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === "" || /^(undefined|null)$/i.test(trimmed);
}

function parseBoolean(name: string, value: string | undefined): string | null {
  if (missingValue(value)) return name + " is missing";
  return value === "true" || value === "false"
    ? null
    : name + " must be 'true' or 'false'";
}

function parseRequiredInteger(name: string, value: string | undefined): string | null {
  const present = value ?? "";
  if (missingValue(present)) return name + " is missing";
  const trimmed = present.trim();
  return /^\d+$/.test(trimmed) ? null : name + " must be a positive integer";
}

function sanitizeProxy(raw: string): string {
  try {
    const url = new URL(raw);
    const auth = url.username || url.password ? "[redacted]@" : "";
    const port = url.port ? ":" + url.port : "";
    return url.protocol + "//" + auth + url.hostname + port;
  } catch {
    return "Configured";
  }
}

function isValidGoogleAppsScriptUrl(value: string | undefined): boolean {
  const present = value ?? "";
  if (missingValue(present)) return false;
  try {
    const trimmed = present.trim();
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.hostname === "script.google.com";
  } catch {
    return false;
  }
}

function isValidTelegramToken(value: string | undefined): boolean {
  const present = value ?? "";
  if (missingValue(present)) return false;
  const trimmed = present.trim();
  return /^\d+:[A-Za-z0-9_-]+$/.test(trimmed);
}

function isValidTelegramChatId(value: string | undefined): boolean {
  const present = value ?? "";
  if (missingValue(present)) return false;
  const trimmed = present.trim();
  return /^(-?\d+|@.+)$/.test(trimmed);
}

function configuredOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? fallback : trimmed;
}

async function defaultVerifyWritableDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, fsConstants.W_OK);
  const probePath = join(path, ".config-doctor-probe-" + String(process.pid) + ".tmp");
  await writeFile(probePath, "ok", "utf8");
  await rm(probePath, { force: true });
}

export function getWindowsBrowserPaths(channel: string): string[] {
  if (channel !== "chrome" && channel !== "msedge") return [];

  const pf = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const pfx86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const userProfile = process.env.USERPROFILE ?? "C:\\Users\\Default";
  const local = process.env.LOCALAPPDATA ?? join(userProfile, "AppData", "Local");

  if (channel === "chrome") {
    return [
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  }

  return [
    join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
}

function getRegistryBrowserPath(exeName: string): string | null {
  const keys = [
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
  for (const key of keys) {
    const result = spawnSync("reg", ["query", key, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const re = /\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/;
        const m = re.exec(line);
        if (m) return m[1].trim();
      }
    }
  }
  return null;
}

export async function defaultDetectBrowser(channel: string): Promise<string> {
  if (channel === "chromium") {
    const { chromium } = await import("playwright");
    const p = chromium.executablePath();
    await access(p, fsConstants.X_OK);
    return "Chromium executable detected";
  }

  if (process.platform === "win32" && (channel === "chrome" || channel === "msedge")) {
    for (const p of getWindowsBrowserPaths(channel)) {
      try {
        await access(p, fsConstants.X_OK);
        return channel + " executable detected";
      } catch {
        /* continue */
      }
    }

    const exeName = channel === "msedge" ? "msedge.exe" : "chrome.exe";
    const regPath = getRegistryBrowserPath(exeName);
    if (regPath) {
      try {
        await access(regPath, fsConstants.X_OK);
        return channel + " executable detected";
      } catch {
        /* continue */
      }
    }
  }

  const names: string[] =
    channel === "msedge"
      ? ["msedge.exe", "msedge"]
      : channel === "chrome"
        ? ["chrome.exe", "chrome"]
        : [channel];
  const locator = process.platform === "win32" ? "where" : "which";
  for (const name of names) {
    const result = spawnSync(locator, [name], { encoding: "utf8" });
    if (result.status === 0) {
      const line = result.stdout.split(/\r?\n/).find((l) => l.trim() !== "");
      if (line) return channel + " executable detected";
    }
  }

  throw new Error(channel + " executable not detected");
}

async function defaultValidateParsedEnv(): Promise<void> {
  await import("./env.js");
}

function renderReport(checks: readonly CheckResult[], ok: boolean): string {
  const lines: string[] = [];
  lines.push("=========================================");
  lines.push("CONFIG DOCTOR");
  lines.push("=========================================");
  lines.push("");
  for (const check of checks) {
    lines.push(check.name);
    lines.push("");
    lines.push(check.status);
    lines.push("");
    for (const line of check.lines) lines.push(line);
    lines.push("");
  }
  lines.push("=========================================");
  lines.push(ok ? "Configuration OK" : "Configuration invalid");
  lines.push("=========================================");
  return lines.join("\n") + "\n";
}

export async function inspectConfigDoctor(
  overrides: Partial<ConfigDoctorDependencies> = {},
): Promise<ConfigDoctorReport> {
  const dependencies: ConfigDoctorDependencies = {
    env: overrides.env ?? process.env,
    nodeVersion: overrides.nodeVersion ?? process.versions.node,
    cwd: overrides.cwd ?? process.cwd(),
    platform: overrides.platform ?? process.platform,
    ensureDirectory:
      overrides.ensureDirectory ??
      (async (path) => {
        await mkdir(path, { recursive: true });
      }),
    verifyWritableDirectory:
      overrides.verifyWritableDirectory ?? defaultVerifyWritableDirectory,
    detectBrowser: overrides.detectBrowser ?? defaultDetectBrowser,
    validateParsedEnv: overrides.validateParsedEnv ?? defaultValidateParsedEnv,
  };

  const checks: CheckResult[] = [];
  const env = dependencies.env;
  const runtimeDir = resolve(dependencies.cwd, ".runtime");
  const logsDir = resolve(dependencies.cwd, "logs");

  const major = Number.parseInt(dependencies.nodeVersion.split(".")[0] ?? "0", 10);
  checks.push({
    name: "Node",
    status: major >= 20 ? "PASS" : "FAIL",
    lines:
      major >= 20
        ? ["v" + dependencies.nodeVersion]
        : [
            "Node v" + dependencies.nodeVersion + " is too old",
            "How to fix",
            "Install Node.js 20 or newer",
          ],
  });

  const environmentErrors = [
    parseBoolean("HEADLESS", env.HEADLESS),
    parseRequiredInteger("SEARCH_PAGE_SIZE", env.SEARCH_PAGE_SIZE),
    parseRequiredInteger("MAX_SEARCH_PAGES", env.MAX_SEARCH_PAGES),
    parseRequiredInteger("SEARCH_MAX_LISTINGS", env.SEARCH_MAX_LISTINGS),
    parseRequiredInteger("DETAIL_CONCURRENCY", env.DETAIL_CONCURRENCY),
    missingValue(env.GOOGLE_APPS_SCRIPT_URL) ? "GOOGLE_APPS_SCRIPT_URL is missing" : null,
    missingValue(env.GOOGLE_APPS_SCRIPT_KEY) ? "GOOGLE_APPS_SCRIPT_KEY is missing" : null,
  ].filter((value): value is string => value !== null);
  try {
    await dependencies.validateParsedEnv();
  } catch (error) {
    environmentErrors.push(
      error instanceof Error
        ? error.message.split("\n")[0]
        : "Environment validation failed",
    );
  }
  checks.push({
    name: "Environment",
    status: environmentErrors.length === 0 ? "PASS" : "FAIL",
    lines:
      environmentErrors.length === 0
        ? ["Required variables present"]
        : [
            ...environmentErrors,
            "How to fix",
            "Update the missing or invalid values in .env",
          ],
  });

  const telegramEnabled = env.TELEGRAM_ENABLED !== "false";
  const telegramErrors: string[] = [];
  if (telegramEnabled) {
    if (!isValidTelegramToken(env.TELEGRAM_BOT_TOKEN)) {
      telegramErrors.push("TELEGRAM_BOT_TOKEN is missing or invalid");
    }
    if (!isValidTelegramChatId(env.TELEGRAM_CHAT_ID)) {
      telegramErrors.push("TELEGRAM_CHAT_ID must be numeric or start with @");
    }
  }
  checks.push({
    name: "Telegram",
    status: telegramEnabled ? (telegramErrors.length === 0 ? "PASS" : "FAIL") : "WARN",
    lines: telegramEnabled
      ? telegramErrors.length === 0
        ? ["Telegram configuration valid"]
        : [
            ...telegramErrors,
            "How to fix",
            "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env",
          ]
      : ["Telegram disabled"],
  });

  const sheetLines = isValidGoogleAppsScriptUrl(env.GOOGLE_APPS_SCRIPT_URL)
    ? ["Apps Script URL format valid", "Apps Script key present"]
    : [
        "GOOGLE_APPS_SCRIPT_URL must match https://script.google.com/...",
        "How to fix",
        "Set GOOGLE_APPS_SCRIPT_URL to the deployed Apps Script web app URL",
      ];
  if (missingValue(env.GOOGLE_APPS_SCRIPT_KEY)) {
    sheetLines.unshift("GOOGLE_APPS_SCRIPT_KEY is missing");
  }
  checks.push({
    name: "Google Sheets",
    status:
      isValidGoogleAppsScriptUrl(env.GOOGLE_APPS_SCRIPT_URL) &&
      !missingValue(env.GOOGLE_APPS_SCRIPT_KEY)
        ? "PASS"
        : "FAIL",
    lines: sheetLines,
  });

  const proxy = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? "";
  checks.push({
    name: "Proxy",
    status: "PASS",
    lines: [proxy ? sanitizeProxy(proxy) : "DIRECT"],
  });

  const filesystemLines: string[] = [];
  let filesystemStatus: CheckStatus = "PASS";
  try {
    await dependencies.ensureDirectory(runtimeDir);
    await dependencies.verifyWritableDirectory(runtimeDir);
    filesystemLines.push(".runtime writable");
    await dependencies.ensureDirectory(logsDir);
    await dependencies.verifyWritableDirectory(logsDir);
    filesystemLines.push("logs writable");
  } catch (error) {
    filesystemStatus = "FAIL";
    filesystemLines.push(
      error instanceof Error ? error.message : "filesystem check failed",
    );
    filesystemLines.push("How to fix");
    filesystemLines.push("Ensure the working directory is writable");
  }
  checks.push({ name: "Filesystem", status: filesystemStatus, lines: filesystemLines });

  const browserChannel = configuredOrDefault(env.BROWSER_CHANNEL, "chrome");
  try {
    const browserMessage = await dependencies.detectBrowser(browserChannel);
    checks.push({ name: "Browser", status: "PASS", lines: [browserMessage] });
  } catch (error) {
    checks.push({
      name: "Browser",
      status: "FAIL",
      lines: [
        error instanceof Error ? error.message : "browser executable not detected",
        "How to fix",
        browserChannel === "chromium"
          ? "Run npm run playwright:install"
          : "Install the configured browser or set BROWSER_CHANNEL=chromium",
      ],
    });
  }

  const pathChecks = [
    {
      name: "Cache",
      path: resolve(
        dependencies.cwd,
        configuredOrDefault(env.DETAIL_CACHE_PATH, ".runtime/detail-cache.json"),
      ),
    },
    {
      name: "Metrics",
      path: resolve(
        dependencies.cwd,
        configuredOrDefault(env.METRICS_PATH, ".runtime/metrics.json"),
      ),
    },
    {
      name: "Health",
      path: resolve(
        dependencies.cwd,
        configuredOrDefault(env.HEALTH_REPORT_PATH, ".runtime/health.json"),
      ),
    },
    {
      name: "Lock",
      path: resolve(
        dependencies.cwd,
        configuredOrDefault(env.RUN_LOCK_PATH, ".runtime/centris-scraper.lock"),
      ),
    },
  ] as const;
  for (const check of pathChecks) {
    try {
      await dependencies.ensureDirectory(dirname(check.path));
      await dependencies.verifyWritableDirectory(dirname(check.path));
      checks.push({
        name: check.name,
        status: "PASS",
        lines: [check.path + " parent writable"],
      });
    } catch (error) {
      checks.push({
        name: check.name,
        status: "FAIL",
        lines: [
          error instanceof Error ? error.message : check.name + " path not writable",
          "How to fix",
          "Ensure the configured path parent directory is writable",
        ],
      });
    }
  }

  const schedulerLines =
    env.SCHEDULER_ENABLED === "false"
      ? ["Scheduler disabled"]
      : [
          "Scheduler enabled",
          "Interval minutes: " + configuredOrDefault(env.SCHEDULE_INTERVAL_MINUTES, "30"),
        ];
  checks.push({ name: "Scheduler", status: "PASS", lines: schedulerLines });

  const ok = checks.every((check) => check.status !== "FAIL");
  return { ok, checks, output: renderReport(checks, ok) };
}

export async function runConfigDoctor(): Promise<void> {
  const report = await inspectConfigDoctor();
  process.stdout.write(report.output);
  if (!report.ok) {
    throw new ConfigDoctorError(report);
  }
}
