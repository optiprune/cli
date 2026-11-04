#!/usr/bin/env node

import path from "pathe";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import semver from "semver";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractTarGz } from "./safe-tar-extract.js";
import { selectHighestCompatibleVersion } from "./version-range.js";
import { assertPluginsExist } from "./plugin-resolution.js";

// @ts-ignore
import { analyze, shouldFail, exportCache, importCache, loadConfig, mergeConfig, DEFAULT_CONFIG } from "@optiprune/core";
// @ts-ignore
import { formatTerminal, formatSarif } from "@optiprune/core/reporters";
// @ts-ignore
import type { AnalyzerOptions, AnalysisReport, FixConfig, Config, ResolvedOptions } from "@optiprune/core/types";

/* --- ANSI Colors --- */
const bold    = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green   = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow  = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan    = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim     = (s: string) => `\x1b[2m${s}\x1b[0m`;
const inverse = (s: string) => `\x1b[7m${s}\x1b[0m`;

/* --- Paths & Config Resolution --- */
function getCliVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = currentDir;
    while (dir !== path.dirname(dir)) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {}
  return "unknown";
}

function getCoreVersion(rootDir: string): string {
  try {
    const localCore = path.join(rootDir, "node_modules/@optiprune/core/package.json");
    if (fs.existsSync(localCore)) {
      const pkg = JSON.parse(fs.readFileSync(localCore, "utf-8"));
      if (pkg.version) return pkg.version;
    }
    const cliDir = path.dirname(fileURLToPath(import.meta.url));
    const siblingCore = path.join(cliDir, "../core/package.json");
    if (fs.existsSync(siblingCore)) {
      const pkg = JSON.parse(fs.readFileSync(siblingCore, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return "2.0.0-alpha.1";
}

function getGlobalConfigDir(): string {
  const home = os.homedir();
  const dir = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "optiprune")
    : path.join(home, ".config", "optiprune");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getGlobalConfigPath(): string {
  return path.join(getGlobalConfigDir(), "config.json");
}

function getLocalConfigPath(rootDir: string): string {
  for (const name of ["optiprune.json", "optiprune.jsonc", "optiprune.config.json"]) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(rootDir, "optiprune.json");
}

/* --- HTTP Helpers --- */
function httpsGetBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "optiprune" } }, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        return resolve(httpsGetBuffer(res.headers.location));
      }
      if (statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} from ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function getDeclaredVersionRange(target: "core" | "cli", rootDir: string, currentVersion: string): string {
  const fieldRange = (filePath: string, name: string): string | undefined => {
    try {
      const pkg = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.optionalDependencies?.[name];
    } catch { return undefined; }
  };
  const pkgName = target === "core" ? "@optiprune/core" : "@optiprune/cli";
  const projectRange = fieldRange(path.join(rootDir, "package.json"), pkgName);
  if (projectRange) return projectRange;
  if (target === "core") {
    const cliPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    const cliRange = fieldRange(cliPackage, pkgName);
    if (cliRange) return cliRange;
  }
  return `^${currentVersion}`;
}

async function fetchLatestPackageMeta(packageName: string, versionRange: string): Promise<{ version: string; tarball: string }> {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const raw = await httpsGetBuffer(registryUrl);
  const packument = JSON.parse(raw.toString("utf-8"));
  const version = selectHighestCompatibleVersion(Object.keys(packument.versions ?? {}), versionRange);
  if (!version) throw new Error(`No published ${packageName} version matches ${versionRange}`);
  const packageVersion = packument.versions[version];
  if (!packageVersion?.dist?.tarball) throw new Error(`Registry metadata for ${packageName}@${version} has no tarball URL`);
  return { version: packageVersion.version ?? version, tarball: packageVersion.dist.tarball };
}

async function handleUpdate(target: "core" | "cli", rootDir: string) {
  const pkgName = target === "core" ? "@optiprune/core" : "@optiprune/cli";
  const currentVersion = target === "core" ? getCoreVersion(rootDir) : getCliVersion();
  const versionRange = getDeclaredVersionRange(target, rootDir, currentVersion);
  console.log(`\nChecking ${bold(pkgName)} updates allowed by ${bold(versionRange)}...`);
  try {
    const meta = await fetchLatestPackageMeta(pkgName, versionRange);
    if (!semver.gt(meta.version, currentVersion)) {
      console.log(`${green("✔")} installed version ${currentVersion} is already the newest matching version\n`);
      return;
    }

    console.log(`${yellow("!")} Compatible update available: ${dim(currentVersion)} → ${green(meta.version)}`);
    console.log(`Downloading and installing ${bold(pkgName)}...`);
    const tarball = await httpsGetBuffer(meta.tarball);
    let installTarget = path.join(rootDir, "node_modules", ...pkgName.split("/"));
    if (target === "cli") {
      const cliRoot = path.dirname(fileURLToPath(import.meta.url));
      installTarget = path.resolve(cliRoot, "..");
    }
    await extractTarGz(tarball, installTarget);
    console.log(`${green("✔")} Successfully updated ${bold(pkgName)} to version ${meta.version}\n`);
  } catch (err: any) {
    const message = err?.code === "ENOENT"
      ? "pnpm is required for updates but was not found in PATH. Install pnpm and retry."
      : (err?.message ?? err);
    console.error(`${yellow("!")} Update failed: ${message}\n`);
  }
}

/* --- Schema Fetcher (Offline Priority) --- */
async function loadSchema(rootDir: string): Promise<Record<string, any>> {
  // 1. Try directly from @optiprune/core in node_modules or ESM resolution
  const candidateLocalPaths = [
    path.join(rootDir, "node_modules/@optiprune/core/schema.json"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/@optiprune/core/schema.json"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../core/schema.json"),
  ];

  for (const candidate of candidateLocalPaths) {
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf-8"));
      } catch {}
    }
  }

  // 2. Try global cached schema
  const cachedSchemaPath = path.join(getGlobalConfigDir(), "schema.json");
  if (fs.existsSync(cachedSchemaPath)) {
    try {
      return JSON.parse(fs.readFileSync(cachedSchemaPath, "utf-8"));
    } catch {}
  }

  // 3. Fallback: Remote fetch (only if local files are missing)
  try {
    const remote = await httpsGetBuffer("https://raw.githubusercontent.com/optiprune/core/refs/heads/main/schema.json");
    const json = JSON.parse(remote.toString("utf-8"));
    fs.writeFileSync(cachedSchemaPath, JSON.stringify(json, null, 2), "utf-8");
    return json;
  } catch {}

  // 4. Default fallback
  return { properties: DEFAULT_CONFIG ?? {} };
}

/* --- Prompt Input Helper --- */
function promptUser(promptText: string, initialValue: string = ""): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() || initialValue);
    });
  });
}

/* --- Hierarchical Tree CLI Navigation UI --- */
interface MenuItem {
  name: string;
  action?: () => Promise<void> | void;
  children?: MenuItem[];
}

function renderTreeBranch(prefix: string, isLast: boolean, label: string, isSelected: boolean): string {
  const marker = isLast ? "└─ " : "├─ ";
  const text = isSelected ? inverse(` ${label} `) : label;
  const cursor = isSelected ? cyan("❯ ") : "  ";
  return `${cursor}${dim(prefix + marker)}${text}`;
}

async function runInteractiveMenu(rootName: string, items: MenuItem[]): Promise<void> {
  const breadcrumbs: { name: string; items: MenuItem[]; selectedIndex: number }[] = [];
  let currentItems = items;
  let selectedIndex = 0;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<void>((resolve) => {
    function render() {
      process.stdout.write("\x1b[2J\x1b[0f");
      console.log(bold(cyan(rootName)));

      let indent = "  ";
      for (let i = 0; i < breadcrumbs.length; i++) {
        const crumb = breadcrumbs[i]!;
        const isLastAncestor = i === breadcrumbs.length - 1;
        console.log(`${"  ".repeat(i + 1)}${dim(isLastAncestor ? "└─ " : "├─ ")}${bold(crumb.name)}`);
        indent += "     ";
      }

      currentItems.forEach((item, idx) => {
        const isLast = idx === currentItems.length - 1;
        console.log(renderTreeBranch(indent, isLast, item.name, idx === selectedIndex));
      });

      console.log(dim("\n[↑/↓] Navigate  •  [→/Enter] Select  •  [←/Esc] Back  •  [Ctrl+C] Exit"));
    }

    async function onKeypress(_: any, key: any) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(0);
      }

      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
        render();
      } else if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % currentItems.length;
        render();
      } else if (key.name === "right" || key.name === "return") {
        const item = currentItems[selectedIndex];
        if (item?.children) {
          breadcrumbs.push({ name: item.name, items: currentItems, selectedIndex });
          currentItems = item.children;
          selectedIndex = 0;
          render();
        } else if (item?.action) {
          cleanup();
          try {
            await item.action();
          } finally {
            process.stdin.pause();
            resolve();
          }
        }
      } else if (key.name === "left" || key.name === "escape") {
        if (breadcrumbs.length > 0) {
          const parent = breadcrumbs.pop()!;
          currentItems = parent.items;
          selectedIndex = parent.selectedIndex;
          render();
        } else {
          cleanup();
          resolve();
        }
      }
    }

    function cleanup() {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

/* --- Schema-Driven Config Editor --- */
/* --- Schema-Driven Config Editor --- */
async function runConfigViewer(scope: "global" | "local", rootDir: string) {
  const schema = await loadSchema(rootDir);
  const properties = schema.properties || DEFAULT_CONFIG || {};
  const keys = Object.keys(properties).filter((k) => k !== "$schema");
  const filePath = scope === "global" ? getGlobalConfigPath() : getLocalConfigPath(rootDir);

  let currentConfig: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try {
      currentConfig = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {}
  }

  // Reduced page size from 8 to 6 so everything stays well within terminal height
  const PAGE_SIZE = 6;
  let currentPage = 0;
  let selectedIndex = 0;
  const totalPages = Math.ceil(keys.length / PAGE_SIZE);

  return new Promise<void>((resolve) => {
    function setupRawMode() {
      readline.emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
    }

    function teardownRawMode() {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    function render() {
      // \x1b[2J clears screen, \x1b[3J clears scrollback, \x1b[H resets cursor to top-left
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

      console.log(bold(cyan(`optiprune > config > ${scope}`)));
      console.log(dim(`File: ${filePath}`));
      console.log(dim(`Page ${currentPage + 1}/${totalPages} — [↑/↓] Select • [←/→] Page • [Enter] Toggle • [d] Reset • [Esc] Back\n`));

      const pageKeys = keys.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
      const activeKey = pageKeys[selectedIndex];
      const activeDef = activeKey ? properties[activeKey] : null;

      pageKeys.forEach((keyName, idx) => {
        const isSelected = idx === selectedIndex;
        const val = currentConfig[keyName];
        const valDisplay = val !== undefined ? JSON.stringify(val) : dim("(not set)");
        const line = `  ${keyName.padEnd(26)} : ${valDisplay}`;
        console.log(isSelected ? inverse(line) : line);
      });

      // Compact info section (prevents pushing menu off-screen)
      if (activeKey && activeDef) {
        console.log("\n" + dim("─".repeat(60)));
        const typeStr = activeDef.type || (activeDef.oneOf ? "union" : "mixed");
        console.log(`${bold(activeKey)} ${dim(`[${typeStr}]`)}`);
        
        if (activeDef.description) {
          // Truncate long descriptions to 1-2 concise lines
          const shortDesc = activeDef.description.length > 120 
            ? activeDef.description.slice(0, 117) + "..." 
            : activeDef.description;
          console.log(cyan("Info: ") + shortDesc);
        }
        if (activeDef.enum) {
          console.log(yellow("Values: ") + activeDef.enum.map((e: any) => JSON.stringify(e)).join(", "));
        }
        if (activeDef.default !== undefined) {
          console.log(dim("Default: ") + JSON.stringify(activeDef.default));
        }
        console.log(dim("─".repeat(60)));
      }
    }

    async function onKeypress(_: any, key: any) {
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        teardownRawMode();
        resolve();
        return;
      }

      const pageCount = keys.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).length;

      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + pageCount) % pageCount;
        render();
      } else if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % pageCount;
        render();
      } else if (key.name === "right") {
        if (currentPage < totalPages - 1) {
          currentPage++;
          selectedIndex = 0;
          render();
        }
      } else if (key.name === "left") {
        if (currentPage > 0) {
          currentPage--;
          selectedIndex = 0;
          render();
        }
      } else if (key.name === "d") {
        const pageKeys = keys.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
        const activeKey = pageKeys[selectedIndex];
        if (activeKey) {
          delete currentConfig[activeKey];
          fs.writeFileSync(filePath, JSON.stringify(currentConfig, null, 2), "utf-8");
          render();
        }
      } else if (key.name === "return") {
        const pageKeys = keys.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
        const activeKey = pageKeys[selectedIndex];
        if (!activeKey) return;

        const propSchema = properties[activeKey] ?? {};

        // Case 1: Enum property (cycle options)
        if (Array.isArray(propSchema.enum)) {
          const options = propSchema.enum;
          const current = currentConfig[activeKey] ?? propSchema.default ?? options[0];
          const nextIndex = (options.indexOf(current) + 1) % options.length;
          currentConfig[activeKey] = options[nextIndex];
          fs.writeFileSync(filePath, JSON.stringify(currentConfig, null, 2), "utf-8");
          render();
          return;
        }

        // Case 2: Boolean property (toggle)
        if (propSchema.type === "boolean") {
          const current = currentConfig[activeKey] ?? propSchema.default ?? false;
          currentConfig[activeKey] = !current;
          fs.writeFileSync(filePath, JSON.stringify(currentConfig, null, 2), "utf-8");
          render();
          return;
        }

        // Case 3: Prompt interactive text for arrays, objects, numbers, and strings
        teardownRawMode();
        console.log(`\nEnter new value for ${bold(activeKey)}:`);
        console.log(dim(`(Leave empty to cancel, or type 'undefined' to remove)`));

        const rawInput = await promptUser(`> `);
        if (rawInput === "undefined") {
          delete currentConfig[activeKey];
        } else if (rawInput.trim().length > 0) {
          const parsed = parseEditorValue(rawInput, propSchema);
          if (!parsed.ok) {
            console.error(`Invalid value: ${parsed.error}`);
            setupRawMode();
            render();
            return;
          }
          currentConfig[activeKey] = parsed.value;
        }

        fs.writeFileSync(filePath, JSON.stringify(currentConfig, null, 2), "utf-8");
        setupRawMode();
        render();
      }
    }

    setupRawMode();
    render();
  });
}

function parseEditorValue(raw: string, schema: Record<string, any>): { ok: true; value: unknown } | { ok: false; error: string } {
  let value: unknown;
  if (schema.type === "string" && !raw.trim().startsWith('"')) value = raw;
  else {
    try { value = JSON.parse(raw); }
    catch { return { ok: false, error: "enter a value of the type shown, using JSON syntax where needed" }; }
  }
  return matchesSchema(value, schema)
    ? { ok: true, value }
    : { ok: false, error: "value does not match the property's schema" };
}

function matchesSchema(value: unknown, schema: Record<string, any>): boolean {
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((choice: Record<string, any>) => matchesSchema(value, choice))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((choice: unknown) => Object.is(choice, value))) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return false;
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) return false;
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) return false;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.items && !value.every((item) => matchesSchema(item, schema.items))) return false;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childSchema = properties[key] ?? schema.additionalProperties;
      if (childSchema === false || (childSchema && typeof childSchema === "object" && !matchesSchema(child, childSchema))) return false;
    }
  }
  return true;
}

/* --- Analysis Logic --- */
const FIX_TARGETS = new Set(["files", "exports", "dependencies", "devDependencies", "conditions", "json"]);
const TEST_IGNORE_PATTERNS = ["**/test/**", "**/tests/**", "**/fixtures/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"];

function normalizeVariadicFlags(args: string[], variadicNames: string[]): string[] {
  const result: string[] = [];
  const variadicSet = new Set(variadicNames);
  let currentFlag: string | null = null;
  let currentFlagHasValue = false;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (currentFlag && !currentFlagHasValue) result.push(currentFlag);
      const hasEquals = arg.includes("=");
      const flagName = arg.split("=")[0]!.replace(/^-+/, "");
      if (!hasEquals && variadicSet.has(flagName)) {
        currentFlag = arg;
        currentFlagHasValue = false;
      } else {
        currentFlag = null;
        currentFlagHasValue = false;
        result.push(arg);
      }
    } else if (currentFlag) {
      result.push(`${currentFlag}=${arg}`);
      currentFlagHasValue = true;
    } else {
      result.push(arg);
    }
  }
  if (currentFlag && !currentFlagHasValue) result.push(currentFlag);
  return result;
}

async function runAnalyze(args: string[]) {
  const normalizedArgs = normalizeVariadicFlags(args, ["entry", "e", "extensions", "x", "ignore", "i", "skip", "fix", "plugins"]);
  const { values } = parseArgs({
    args: normalizedArgs,
    options: {
      rootDir: { type: "string", short: "r" },
      entry: { type: "string", short: "e", multiple: true },
      extensions: { type: "string", short: "x", multiple: true },
      ignore: { type: "string", short: "i", multiple: true },
      "report-unused-exports": { type: "boolean", default: true },
      "no-report-unused-exports": { type: "boolean" },
      "conventional-entries": { type: "boolean", default: true },
      "no-conventional-entries": { type: "boolean" },
      "include-entry-exports": { type: "boolean" },
      "include-entry-members": { type: "boolean" },
      cycles: { type: "boolean" },
      "ignore-tests": { type: "boolean" },
      "ignore-unknown-import": { type: "boolean" },
      "fail-on": { type: "string", default: "high" },
      json: { type: "boolean" },
      sarif: { type: "boolean" },
      skip: { type: "string", multiple: true },
      verbose: { type: "boolean", short: "v" },
      fix: { type: "string", multiple: true },
      "fix-json": { type: "boolean" },
      plugins: { type: "string", multiple: true },
      confidence: { type: "string", default: "high" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "cache-from": { type: "string" },
      "cache-to": { type: "string" },
      "stop-new-cache-on-update": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  const isCliOverride = (longFlag: string, shortFlag?: string) => {
    return args.some((arg) => {
      const base = arg.split("=")[0];
      return (
        base === `--${longFlag}` ||
        base === `--no-${longFlag}` ||
        (shortFlag ? base === `-${shortFlag}` : false)
      );
    });
  };

  const targetRootDir = path.resolve((values.rootDir as string | undefined) ?? process.cwd());
  const globalConfig = fs.existsSync(getGlobalConfigPath()) ? JSON.parse(fs.readFileSync(getGlobalConfigPath(), "utf-8")) : {};
  const fileConfig: Config = typeof loadConfig === "function" ? await loadConfig(targetRootDir) : {};
  
  let fixOption: boolean | FixConfig | undefined = undefined;
  const hasExplicitFix = isCliOverride("fix");
  const hasJsonFix = isCliOverride("fix-json") && Boolean(values["fix-json"]);
  const hasFixFlags = hasExplicitFix || hasJsonFix || isCliOverride("confidence") || isCliOverride("force") || isCliOverride("dry-run");

  if (hasFixFlags) {
    if (!hasExplicitFix && !hasJsonFix) {
      throw new Error("--confidence, --force, and --dry-run require --fix <target...> or --fix-json");
    }
    const requestedTargets: string[] = [
      ...(hasExplicitFix && Array.isArray(values.fix) ? (values.fix as string[]) : []),
      ...(hasJsonFix ? ["json"] : []),
    ];
    if (requestedTargets.length === 0) {
      throw new Error("--fix requires at least one target: files, exports, dependencies, devDependencies, conditions, or json.");
    }
    const invalidTargets = requestedTargets.filter((target) => !FIX_TARGETS.has(target));
    if (invalidTargets.length > 0) {
      throw new Error(`Unknown --fix target(s): ${invalidTargets.join(", ")}. Choose files, exports, dependencies, devDependencies, conditions, or json.`);
    }
    fixOption = {
      confidence: (values.confidence as string | undefined) ?? "high",
      rules: [...new Set(requestedTargets)],
      force: Boolean(values.force),
      dryRun: Boolean(values["dry-run"]),
    } as unknown as FixConfig;
  }

  const shouldIgnoreTests = isCliOverride("ignore-tests")
    ? Boolean(values["ignore-tests"])
    : Boolean(fileConfig.ignoreTests ?? globalConfig.ignoreTests);

  let mergedIgnore: string[] | undefined = undefined;
  const cliIgnore = isCliOverride("ignore", "i") ? (values.ignore as string[] | undefined) : undefined;
  const baseIgnore = cliIgnore ?? (Array.isArray(fileConfig.ignore) ? fileConfig.ignore : (Array.isArray(globalConfig.ignore) ? globalConfig.ignore : []));

  if (shouldIgnoreTests || baseIgnore.length > 0) {
    const testGlobs = shouldIgnoreTests ? TEST_IGNORE_PATTERNS : [];
    mergedIgnore = Array.from(new Set([...testGlobs, ...baseIgnore]));
  }

  const requestedPlugins = isCliOverride("plugins") ? ((values.plugins as string[] | undefined) ?? []) : [];
  const resolvedPlugins = requestedPlugins.length > 0 ? assertPluginsExist(requestedPlugins) : [];

  const skipValues = isCliOverride("skip") ? ((values.skip as string[] | undefined) ?? []) : [];
  const normalizedSkipValues = skipValues.map((v) => v.toLowerCase());
  const invalidSkipValues = normalizedSkipValues.filter((value) => !["3", "4", "smt"].includes(value));
  if (invalidSkipValues.length > 0) {
    throw new Error(`Unknown --skip value(s): ${invalidSkipValues.join(", ")}. Choose 3, 4, or smt.`);
  }

  const skipLayers = {
    ...(globalConfig.layers ?? {}),
    ...(fileConfig.layers ?? {}),
    ...(normalizedSkipValues.includes("3") && { skip3: true }),
    ...(normalizedSkipValues.includes("4") && { skip4: true }),
    ...(normalizedSkipValues.includes("smt") && { skipSmt: true, skip3: true }),
  };

  const reportUnusedExports = values["no-report-unused-exports"] ? false : Boolean(values["report-unused-exports"]);
  const conventionalEntries = values["no-conventional-entries"] ? false : Boolean(values["conventional-entries"]);

  const cliOverrides: Partial<Config> = {
    ...(isCliOverride("rootDir", "r") && { rootDir: targetRootDir }),
    ...(isCliOverride("entry", "e") && values.entry && { entry: values.entry as string[] }),
    ...(isCliOverride("extensions", "x") && values.extensions && { extensions: values.extensions as string[] }),
    ...(mergedIgnore !== undefined && { ignore: mergedIgnore }),
    ...(shouldIgnoreTests && { ignoreTests: true }),
    ...(isCliOverride("report-unused-exports") && { reportUnusedExports }),
    ...(isCliOverride("conventional-entries") && { includeConventionalEntries: conventionalEntries }),
    ...(isCliOverride("include-entry-exports") && { includeEntryExports: Boolean(values["include-entry-exports"]) }),
    ...(isCliOverride("include-entry-members") && { includeEntryMembers: Boolean(values["include-entry-members"]) }),
    ...(isCliOverride("cycles") && { cycles: Boolean(values.cycles) }),
    ...(isCliOverride("ignore-unknown-import") && { ignoreUnknownImport: Boolean(values["ignore-unknown-import"]) }),
    ...(isCliOverride("fail-on") && values["fail-on"] && { failOn: values["fail-on"] as any }),
    ...(isCliOverride("json") && { json: Boolean(values.json) }),
    ...(isCliOverride("skip") && { layers: skipLayers as any }),
    ...(isCliOverride("verbose", "v") && { verbose: Boolean(values.verbose) }),
    ...(isCliOverride("plugins") && {
      plugins: {
        ...(globalConfig.plugins ?? {}),
        ...(fileConfig.plugins ?? {}),
        ...Object.fromEntries(resolvedPlugins.map((plugin) => [plugin, true])),
      },
    }),
    ...(fixOption !== undefined && { fix: fixOption }),
    ...(isCliOverride("cache-from") && values["cache-from"] && { cacheFrom: values["cache-from"] as string }),
    ...(isCliOverride("cache-to") && values["cache-to"] && { cacheTo: values["cache-to"] as string }),
    ...(isCliOverride("stop-new-cache-on-update") && { stopNewCacheOnUpdate: Boolean(values["stop-new-cache-on-update"]) }),
  };

  const baseConfig: ResolvedOptions = {
    ...DEFAULT_CONFIG,
    rootDir: targetRootDir,
    entry: [...DEFAULT_CONFIG.entry],
    extensions: [...DEFAULT_CONFIG.extensions],
    ignore: [...DEFAULT_CONFIG.ignore],
    ignoreDependencies: [...DEFAULT_CONFIG.ignoreDependencies],
    packageIgnoreDependencies: new Map(DEFAULT_CONFIG.packageIgnoreDependencies),
    externalContracts: [...DEFAULT_CONFIG.externalContracts],
    pathAliases: new Map(DEFAULT_CONFIG.pathAliases),
    packageImports: new Map(DEFAULT_CONFIG.packageImports),
    layers: { ...DEFAULT_CONFIG.layers },
    rules: { ...DEFAULT_CONFIG.rules },
    plugins: { ...DEFAULT_CONFIG.plugins },
    workspaceGlobs: [...DEFAULT_CONFIG.workspaceGlobs],
    projectPatterns: [...DEFAULT_CONFIG.projectPatterns],
    unreachableFileIgnorePatterns: [...DEFAULT_CONFIG.unreachableFileIgnorePatterns],
    protectedExportPatterns: [...DEFAULT_CONFIG.protectedExportPatterns],
    frameworks: [...DEFAULT_CONFIG.frameworks],
  };

  const resolvedWithGlobal = mergeConfig(baseConfig, globalConfig);
  const resolvedWithFile = mergeConfig(resolvedWithGlobal, fileConfig);
  const finalConfig = mergeConfig(resolvedWithFile, cliOverrides);

  const report: AnalysisReport = await analyze(finalConfig as AnalyzerOptions);

  if (values.sarif || finalConfig.output === "sarif") {
    console.log(formatSarif(report));
  } else if (finalConfig.output === "json" || finalConfig.json || values.json) {
    console.log(JSON.stringify(report, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  } else {
    console.log(formatTerminal(report, { showCycles: Boolean(finalConfig.cycles) }));
  }

  const failTarget = ((finalConfig.failOn ?? (values["fail-on"] as string | undefined) ?? "high")) as any;
  if (shouldFail(report, failTarget)) {
    process.exit(1);
  }
}

async function runExportCache(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      rootDir: { type: "string", short: "r" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const targetPath: string | undefined = positionals[0];
  if (values.help || !targetPath) {
    console.log("Usage: optiprune export-cache <targetPath> [-r, --rootDir <path>]");
    if (!targetPath && !values.help) process.exit(1);
    return;
  }

  const rootDir: string = (values.rootDir as string | undefined) ?? process.cwd();
  await exportCache(rootDir, targetPath);
  console.log(`${yellow("✔")} Cache exported to ${bold(targetPath)}`);
}

async function runImportCache(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      rootDir: { type: "string", short: "r" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const sourcePath: string | undefined = positionals[0];
  if (values.help || !sourcePath) {
    console.log("Usage: optiprune import-cache <sourcePath> [-r, --rootDir <path>]");
    if (!sourcePath && !values.help) process.exit(1);
    return;
  }

  const rootDir: string = (values.rootDir as string | undefined) ?? process.cwd();
  await importCache(rootDir, sourcePath);
  console.log(`${yellow("✔")} Cache imported from ${bold(sourcePath)}`);
}

/* --- Entrypoint --- */
async function main() {
  const rawArgs = process.argv.slice(2);
  const rootDir = process.cwd();

  if (rawArgs.includes("-V") || rawArgs.includes("--version")) {
    console.log(`CLI: ${getCliVersion()}, Core: ${getCoreVersion(rootDir)}`);
    return;
  }

  if (rawArgs.includes("-h") || rawArgs.includes("--help")) {
    console.log("OptiPrune — choose an action from the menu.\n\n  prune       Analyze this project\n  config      Edit global or local configuration\n  update      Install the newest version allowed by package.json\n  help        Show this help\n\nUse `optiprune analyze --help` for analysis options. In CI, use `optiprune analyze` explicitly.");
    return;
  }

  if (rawArgs.length > 0) {
    const firstArg = rawArgs[0];
    if (firstArg === "analyze" || firstArg === "prune") {
      await runAnalyze(rawArgs.slice(1));
      return;
    }
    if (firstArg === "export-cache") {
      await runExportCache(rawArgs.slice(1));
      return;
    }
    if (firstArg === "import-cache") {
      await runImportCache(rawArgs.slice(1));
      return;
    }
    if (!["analyze", "prune", "export-cache", "import-cache"].includes(firstArg ?? "") && !firstArg?.startsWith("-")) {
      console.error(`Unknown command: ${firstArg}. Choose analyze, prune, export-cache, or import-cache.`);
      process.exitCode = 1;
      return;
    }
    if (firstArg?.startsWith("-")) {
      await runAnalyze(rawArgs);
      return;
    }
  }

  const menu: MenuItem[] = [
    {
      name: "prune",
      action: async () => {
        await runAnalyze([]);
      },
    },
    {
      name: "config",
      children: [
        {
          name: "global",
          action: async () => {
            await runConfigViewer("global", rootDir);
          },
        },
        {
          name: "local",
          action: async () => {
            await runConfigViewer("local", rootDir);
          },
        },
      ],
    },
    {
      name: "help",
      action: () => {
        console.log("OptiPrune analyzes JavaScript and TypeScript projects for unreachable code.\n\nChoose prune to analyze, config to edit settings, or update to install the newest compatible package version.\n\nFor automation, run `optiprune analyze`; help never runs analysis or fixes.");
      },
    },
    {
      name: "update",
      children: [
        {
          name: "core",
          action: async () => {
            await handleUpdate("core", rootDir);
          },
        },
        {
          name: "cli",
          action: async () => {
            await handleUpdate("cli", rootDir);
          },
        },
      ],
    },
  ];

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await runAnalyze([]);
    return;
  }
  await runInteractiveMenu("optiprune", menu);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
