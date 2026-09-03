import fs from "node:fs";
import path from "pathe";
import { createRequire } from "node:module";

export interface PluginResolution {
  requested: string;
  canonical?: string;
  suggestion?: string;
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

export function resolvePlugins(requested: string[], available = discoverPluginNames()): PluginResolution[] {
  const byNormalized = new Map(available.map((name) => [normalize(name), name]));
  return requested.map((value) => {
    const key = normalize(value);
    const canonical = byNormalized.get(key);
    if (canonical) return { requested: value, canonical };

    let suggestion: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of available) {
      const candidateKey = normalize(candidate);
      const score = distance(key, candidateKey);
      const threshold = Math.max(2, Math.floor(Math.max(key.length, candidateKey.length) * 0.4));
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
