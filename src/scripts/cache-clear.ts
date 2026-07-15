import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { env } from "../config/env.js";

const runtimeRoot = resolve(".runtime");
const cachePath = resolve(env.detailCachePath);
const relativePath = relative(runtimeRoot, cachePath);
if (isAbsolute(relativePath) || relativePath.startsWith("..")) {
  throw new Error("DETAIL_CACHE_PATH must remain inside .runtime for cache:clear");
}
await rm(cachePath, { force: true });
console.log("Detail cache cleared.");
