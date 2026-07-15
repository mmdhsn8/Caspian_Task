import { inspectConfigDoctor, getWindowsBrowserPaths, defaultDetectBrowser } from "../src/config/config-doctor.js";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL: " + message);
  }
}

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GOOGLE_APPS_SCRIPT_URL: "https://script.google.com/macros/s/test/exec",
    GOOGLE_APPS_SCRIPT_KEY: "key",
    SEARCH_PAGE_SIZE: "20",
    MAX_SEARCH_PAGES: "2",
    SEARCH_MAX_LISTINGS: "40",
    DETAIL_CONCURRENCY: "2",
    HEADLESS: "true",
    TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN",
    TELEGRAM_CHAT_ID: "-100123456789",
    ...overrides,
  };
}

function statusOf(report: Awaited<ReturnType<typeof inspectConfigDoctor>>, name: string): string {
  return report.checks.find((check) => check.name === name)?.status ?? "missing";
}

function linesOf(report: Awaited<ReturnType<typeof inspectConfigDoctor>>, name: string): string[] {
  return report.checks.find((check) => check.name === name)?.lines ?? [];
}

const dependencies = {
  ensureDirectory: async () => undefined,
  verifyWritableDirectory: async () => undefined,
  detectBrowser: async () => "Chrome executable detected",
  validateParsedEnv: async () => undefined,
  cwd: "C:/workspace",
  platform: "win32" as const,
};

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ GOOGLE_APPS_SCRIPT_KEY: undefined }),
    nodeVersion: "22.0.0",
  });
  assert(statusOf(report, "Environment") === "FAIL", "missing env fails environment check");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ GOOGLE_APPS_SCRIPT_URL: "https://example.com" }),
    nodeVersion: "22.0.0",
  });
  assert(statusOf(report, "Google Sheets") === "FAIL", "bad Apps Script URL fails");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ TELEGRAM_BOT_TOKEN: "bad-token" }),
    nodeVersion: "22.0.0",
  });
  assert(statusOf(report, "Telegram") === "FAIL", "bad Telegram token fails");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ TELEGRAM_CHAT_ID: "bad chat" }),
    nodeVersion: "22.0.0",
  });
  assert(statusOf(report, "Telegram") === "FAIL", "bad Telegram chat id fails");
}

{
  const created: string[] = [];
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv(),
    nodeVersion: "22.0.0",
    ensureDirectory: async (path) => {
      created.push(path);
    },
  });
  assert(statusOf(report, "Filesystem") === "PASS", "missing dirs are created safely");
  assert(created.some((path) => path.endsWith(".runtime")), ".runtime is created");
  assert(created.some((path) => path.endsWith("logs")), "logs is created");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv(),
    nodeVersion: "22.0.0",
    verifyWritableDirectory: async (path) => {
      if (path.endsWith(".runtime")) throw new Error("read-only directory");
    },
  });
  assert(statusOf(report, "Filesystem") === "FAIL", "read-only directory fails");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv(),
    nodeVersion: "18.19.0",
  });
  assert(statusOf(report, "Node") === "FAIL", "old Node version fails");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ TELEGRAM_ENABLED: "false", TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }),
    nodeVersion: "22.0.0",
  });
  assert(statusOf(report, "Telegram") === "WARN", "disabled Telegram warns but does not fail");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ HTTPS_PROXY: "http://user:pass@127.0.0.1:10808" }),
    nodeVersion: "22.0.0",
  });
  assert(statusOf(report, "Proxy") === "PASS", "configured proxy passes");
  assert(linesOf(report, "Proxy")[0] === "http://[redacted]@127.0.0.1:10808", "proxy credentials are masked");
}

{
  const report = await inspectConfigDoctor({
    ...dependencies,
    env: baseEnv({ HTTPS_PROXY: undefined, HTTP_PROXY: undefined }),
    nodeVersion: "22.0.0",
  });
  assert(linesOf(report, "Proxy")[0] === "DIRECT", "direct proxy state is reported");
}

{
  const chromePaths = getWindowsBrowserPaths("chrome");
  assert(chromePaths.length === 3, "chrome has 3 candidate paths");
  assert(chromePaths[0].endsWith("chrome.exe"), "chrome path ends with chrome.exe");
  assert(
    chromePaths[0].includes("Google" + "\\Chrome\\Application"),
    "chrome path includes Google\\Chrome\\Application",
  );
}

{
  const edgePaths = getWindowsBrowserPaths("msedge");
  assert(edgePaths.length === 3, "edge has 3 candidate paths");
  assert(edgePaths[0].endsWith("msedge.exe"), "edge path ends with msedge.exe");
  assert(
    edgePaths[0].includes("Microsoft" + "\\Edge\\Application"),
    "edge path includes Microsoft\\Edge\\Application",
  );
}

{
  const unknownPaths = getWindowsBrowserPaths("firefox");
  assert(unknownPaths.length === 0, "unsupported channel returns no paths");
}

{
  const tmpDir = mkdtempSync(join(tmpdir(), "doctor-browser-"));
  const chromeExe = join(tmpDir, "PF", "Google", "Chrome", "Application", "chrome.exe");
  await mkdir(join(tmpDir, "PF", "Google", "Chrome", "Application"), { recursive: true });
  await writeFile(chromeExe, "", "utf8");

  const origPF = process.env.PROGRAMFILES;
  const origPF86 = process.env["PROGRAMFILES(X86)"];
  const origLocal = process.env.LOCALAPPDATA;
  process.env.PROGRAMFILES = join(tmpDir, "PF");
  process.env["PROGRAMFILES(X86)"] = join(tmpDir, "PF86");
  process.env.LOCALAPPDATA = join(tmpDir, "Local");

  try {
    const result = await defaultDetectBrowser("chrome");
    assert(result === "chrome executable detected", "Chrome detected in Program Files");
  } finally {
    process.env.PROGRAMFILES = origPF;
    process.env["PROGRAMFILES(X86)"] = origPF86;
    process.env.LOCALAPPDATA = origLocal;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

{
  const tmpDir = mkdtempSync(join(tmpdir(), "doctor-browser-"));
  const chromeExe = join(tmpDir, "Local", "Google", "Chrome", "Application", "chrome.exe");
  await mkdir(join(tmpDir, "Local", "Google", "Chrome", "Application"), { recursive: true });
  await writeFile(chromeExe, "", "utf8");

  const origPF = process.env.PROGRAMFILES;
  const origPF86 = process.env["PROGRAMFILES(X86)"];
  const origLocal = process.env.LOCALAPPDATA;
  process.env.PROGRAMFILES = join(tmpDir, "PF");
  process.env["PROGRAMFILES(X86)"] = join(tmpDir, "PF86");
  process.env.LOCALAPPDATA = join(tmpDir, "Local");

  try {
    const result = await defaultDetectBrowser("chrome");
    assert(result === "chrome executable detected", "Chrome detected in LocalAppData");
  } finally {
    process.env.PROGRAMFILES = origPF;
    process.env["PROGRAMFILES(X86)"] = origPF86;
    process.env.LOCALAPPDATA = origLocal;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

{
  const tmpDir = mkdtempSync(join(tmpdir(), "doctor-browser-"));
  const edgeExe = join(tmpDir, "PF86", "Microsoft", "Edge", "Application", "msedge.exe");
  await mkdir(join(tmpDir, "PF86", "Microsoft", "Edge", "Application"), { recursive: true });
  await writeFile(edgeExe, "", "utf8");

  const origPF86 = process.env["PROGRAMFILES(X86)"];
  process.env["PROGRAMFILES(X86)"] = join(tmpDir, "PF86");

  try {
    const result = await defaultDetectBrowser("msedge");
    assert(result === "msedge executable detected", "Edge detected in Program Files (x86)");
  } finally {
    process.env["PROGRAMFILES(X86)"] = origPF86;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

{
  try {
    const result = await defaultDetectBrowser("chromium");
    assert(result === "Chromium executable detected", "Chromium executable detected");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("chromium"), "Chromium detection gives chromium-related error");
  }
}

{
  try {
    await defaultDetectBrowser("firefox");
    assert(false, "unsupported channel should throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg === "firefox executable not detected", "unsupported channel error: " + msg);
  }
}

{
  const tmpDir = mkdtempSync(join(tmpdir(), "doctor-browser-"));
  await mkdir(join(tmpDir, "empty"), { recursive: true });

  const origPF = process.env.PROGRAMFILES;
  const origPF86 = process.env["PROGRAMFILES(X86)"];
  const origLocal = process.env.LOCALAPPDATA;
  const origPath = process.env.PATH;
  process.env.PROGRAMFILES = join(tmpDir, "empty");
  process.env["PROGRAMFILES(X86)"] = join(tmpDir, "empty");
  process.env.LOCALAPPDATA = join(tmpDir, "empty");
  process.env.PATH = join(tmpDir, "empty");

  try {
    await defaultDetectBrowser("chrome");
    assert(false, "missing browser should throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg === "chrome executable not detected", "missing browser error: " + msg);
  } finally {
    process.env.PROGRAMFILES = origPF;
    process.env["PROGRAMFILES(X86)"] = origPF86;
    process.env.LOCALAPPDATA = origLocal;
    process.env.PATH = origPath;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(
  "\nConfig doctor tests: " + String(passed) + " passed, " + String(failed) + " failed",
);
if (failed > 0) process.exit(1);
