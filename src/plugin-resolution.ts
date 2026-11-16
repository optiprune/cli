import fs from "node:fs";
import path from "pathe";
import { createRequire } from "node:module";

export interface PluginResolution {
  requested: string;
  canonical?: string;
  suggestion?: string;
}

const PLUGIN_NAME_BY_FILE_STEM: Record<string, string> = {
  "lint-html-plugin": "linthtml-plugin",
  "markdown-lint-plugin": "markdownlint-plugin",
  "node-types-plugin": "node-builtin-plugin",
  "nuxtjs-plugin": "nuxt-plugin",
  "svelte-kit-plugin": "sveltekit-plugin",
  "temporal-io-plugin": "temporal-plugin",
  "webdriver-io-plugin": "webdriverio-plugin",
};

export function canonicalPluginName(fileStem: string): string {
  return PLUGIN_NAME_BY_FILE_STEM[fileStem] ?? fileStem;
}

function exportedPluginName(pluginPath: string, fileStem: string): string {
  try {
    const source = fs.readFileSync(pluginPath, "utf8");
    const names = [...source.matchAll(/\bname:\s*["']([^"']*-plugin)["']/g)];
    const match = names.at(-1)?.[1];
    if (match) return match;
  } catch {
    // Keep compatibility aliases when source inspection is unavailable.
  }
  return canonicalPluginName(fileStem);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/-plugin$/, "");
}

function distance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column] ?? column;
      const leftValue = left[row - 1] ?? "";
      const rightValue = right[column - 1] ?? "";
      const aboveValue = previous[column] ?? column;
      const leftValueDistance = previous[column - 1] ?? column - 1;
      previous[column] = leftValue === rightValue
        ? diagonal
        : Math.min(diagonal + 1, aboveValue + 1, leftValueDistance + 1);
      diagonal = above;
    }
  }
  return previous[right.length] ?? right.length;
}

/** Discover the plugin modules shipped by the installed Core package. */
export function discoverPluginNames(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const corePackage = require.resolve("@optiprune/core/package.json");
    const pluginDir = path.join(path.dirname(corePackage), "dist", "plugins");
    return fs.readdirSync(pluginDir)
      .filter((file) => /(?:-plugin|plugin)\.(?:c?m?js|ts)$/.test(file) && file !== "object-member-plugin.js")
      .map((file) => file.replace(/\.(?:c?m?js|ts)$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function discoverPluginCanonicalNames(available: string[]): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const require = createRequire(import.meta.url);
    const corePackage = require.resolve("@optiprune/core/package.json");
    const pluginDir = path.join(path.dirname(corePackage), "dist", "plugins");
    const files = fs.readdirSync(pluginDir);
    for (const fileStem of available) {
      const file = files.find((candidate) => candidate.startsWith(`${fileStem}.`));
      result.set(fileStem, file ? exportedPluginName(path.join(pluginDir, file), fileStem) : canonicalPluginName(fileStem));
    }
  } catch {
    for (const fileStem of available) result.set(fileStem, canonicalPluginName(fileStem));
  }
  return result;
}

export function resolvePlugins(requested: string[], available = discoverPluginNames()): PluginResolution[] {
  const byNormalized = new Map<string, string>();
  const canonicalNames = discoverPluginCanonicalNames(available);
  for (const fileStem of available) {
    const canonical = canonicalNames.get(fileStem) ?? canonicalPluginName(fileStem);
    byNormalized.set(normalize(canonical), canonical);
    const stemKey = normalize(fileStem);
    if (!byNormalized.has(stemKey)) byNormalized.set(stemKey, canonical);
  }

  return requested.map((value) => {
    const key = normalize(value);
    const canonical = byNormalized.get(key);
    if (canonical) return { requested: value, canonical };

    let suggestion: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const fileStem of available) {
      const candidate = canonicalNames.get(fileStem) ?? canonicalPluginName(fileStem);
      const candidateKeys = [normalize(candidate), normalize(fileStem)];
      const score = Math.min(...candidateKeys.map((candidateKey) => distance(key, candidateKey)));
      const threshold = Math.max(
        2,
        Math.floor(Math.max(key.length, ...candidateKeys.map((candidateKey) => candidateKey.length)) * 0.4),
      );
      if (score <= threshold && score < bestScore) {
        suggestion = candidate;
        bestScore = score;
      }
    }
    return suggestion
      ? { requested: value, suggestion }
      : { requested: value };
  });
}

export function assertPluginsExist(requested: string[], available = discoverPluginNames()): string[] {
  const resolutions = resolvePlugins(requested, available);
  const invalid = resolutions.find((resolution) => !resolution.canonical);
  if (invalid) {
    if (invalid.suggestion) {
      throw new Error(`Plugin not found with the name "${invalid.requested}". Did you mean "${invalid.suggestion}"?`);
    }
    throw new Error(`No Plugin found with the name "${invalid.requested}"`);
  }
  return resolutions.map((resolution) => resolution.canonical as string);
}
