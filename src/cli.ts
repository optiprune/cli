#!/usr/bin/env node

import path from "pathe";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertPluginsExist } from "./plugin-resolution.js";

const FIX_TARGETS = new Set(["files", "exports", "dependencies", "devDependencies", "conditions", "json"]);

const TEST_IGNORE_PATTERNS = [
  "**/test/**",
  "**/tests/**",
  "**/fixtures/**",
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.test.tsx",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.spec.tsx",
  "**/*.spec.jsx",
];

// @ts-ignore
import { analyze, shouldFail, exportCache, importCache, loadConfig, mergeConfig, DEFAULT_CONFIG } from "@optiprune/core";
// @ts-ignore
import { formatTerminal, formatSarif } from "@optiprune/core/reporters";
// @ts-ignore
import type { AnalyzerOptions, AnalysisReport, Finding, FixConfig, Config, ResolvedOptions } from "@optiprune/core/types";

/** ANSI colour helpers */
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim    = (s: string) => `\x1b[2m${s}\x1b[0m`;

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
  } catch (e) {}
  return "unknown";
}

function getCoreVersion(rootDir: string): string {
  try {
    const localCore = path.join(rootDir, "node_modules/@optiprune/core/package.json");
    if (fs.existsSync(localCore)) {
      const content = fs.readFileSync(localCore, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.version) return pkg.version;
    }

    const cliDir = path.dirname(fileURLToPath(import.meta.url));
    const siblingCore = path.join(cliDir, "../core/package.json");
    if (fs.existsSync(siblingCore)) {
      const content = fs.readFileSync(siblingCore, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.version) return pkg.version;
    }
  } catch (e) {}
  return "1.12.1";
}

function printHelp(): void {
  console.log(`
Usage: optiprune [command] [options]

Finds dead code in TypeScript/JavaScript projects.

Commands:
  analyze [options]                 Perform full analysis of the project (default)
  export-cache <targetPath>         Export current analysis cache to a JSON file
  import-cache <sourcePath>         Import cache JSON file into local directory

Options:
  -V, --version                     Output the version number
  -h, --help                        Display this help text

Analyze Options:
  -r, --rootDir <path>              Root directory of project (default: cwd)
  -e, --entry <patterns...>         Entry point patterns
  -x, --extensions <exts...>        Extensions to analyze (default: .ts .tsx .js .jsx .vue)
  -i, --ignore <patterns...>        Ignore patterns (glob)
  --no-report-unused-exports        Do not report unused exports
  --no-conventional-entries         Do not include conventional entry points
  --include-entry-exports           Report unused exports in entry files
  --include-entry-members           Report unused members in entry files
  --cycles                          Print detected dependency cycles
  --ignore-tests                    Ignore test files and fixtures
  --ignore-unknown-import           Ignore dynamic/unknown import reachability
  --fail-on <confidence>            Fail confidence: high, medium, low, none (default: high)
  --json                            Output results as JSON
  --sarif                           Output results in SARIF format
  --skip <layers...>                Skip analysis layers: 3, 4, smt
  -v, --verbose                     Show verbose output and internal graph state
  --fix <rules...>                  Fix targets: files, exports, dependencies, etc.
  --fix-json                        Safely repair recoverable package.json JSON errors
  --plugins <names...>              Force-enable plugins by name (e.g. astro vite vitest)
  --confidence <level>              Min fix confidence: high, medium+, low+, all (default: high)
  --force                           Allow unsafe fixes
  --dry-run                         Log fixes without writing files
  --cache-from <path>               Import cache JSON prior to analysis
  --cache-to <path>                 Export resulting cache to JSON after analysis
`);
}

/** Preprocesses arguments so variadic flags work like Commander (e.g., `--extensions .ts .tsx`) */
function normalizeVariadicFlags(args: string[], variadicNames: string[]): string[] {
  const result: string[] = [];
  const variadicSet = new Set(variadicNames);
  let currentFlag: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      const flagName = arg.split("=")[0]!.replace(/^-+/, "");
      currentFlag = variadicSet.has(flagName) ? arg.split("=")[0]! : null;
      result.push(arg);
    } else if (currentFlag && !arg.startsWith("-")) {
      result.push(currentFlag, arg);
    } else {
      currentFlag = null;
      result.push(arg);
    }
  }
  return result;
}

async function runAnalyze(args: string[]) {
  const normalizedArgs = normalizeVariadicFlags(args, ["entry", "e", "extensions", "x", "ignore", "i", "skip", "fix", "plugins"]);

  const optionsConfig = {
    help: { type: "boolean" as const, short: "h" },
    rootDir: { type: "string" as const, short: "r" },
    entry: { type: "string" as const, short: "e", multiple: true },
    extensions: { type: "string" as const, short: "x", multiple: true },
    ignore: { type: "string" as const, short: "i", multiple: true },
    "report-unused-exports": { type: "boolean" as const, default: true },
    "no-report-unused-exports": { type: "boolean" as const },
    "conventional-entries": { type: "boolean" as const, default: true },
    "no-conventional-entries": { type: "boolean" as const },
    "include-entry-exports": { type: "boolean" as const },
    "include-entry-members": { type: "boolean" as const },
    cycles: { type: "boolean" as const },
    "ignore-tests": { type: "boolean" as const },
    "ignore-unknown-import": { type: "boolean" as const },
    "fail-on": { type: "string" as const, default: "high" },
    json: { type: "boolean" as const },
    sarif: { type: "boolean" as const },
    skip: { type: "string" as const, multiple: true },
    verbose: { type: "boolean" as const, short: "v" },
    fix: { type: "string" as const, multiple: true },
    "fix-json": { type: "boolean" as const },
    plugins: { type: "string" as const, multiple: true },
    confidence: { type: "string" as const, default: "high" },
    force: { type: "boolean" as const },
    "dry-run": { type: "boolean" as const },
    "cache-from": { type: "string" as const },
    "cache-to": { type: "string" as const },
  };

  const { values } = parseArgs({
    args: normalizedArgs,
    options: optionsConfig,
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return;
  }

  // Checks both long form (--rootDir) and short alias (-r)
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

  // 1. Read project config via core's loadConfig
  const fileConfig: Config = typeof loadConfig === "function" ? await loadConfig(targetRootDir) : {};

  // 2. Resolve fix configurations
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

  // 3. Determine if test ignoring is active
  const shouldIgnoreTests = isCliOverride("ignore-tests")
    ? Boolean(values["ignore-tests"])
    : Boolean(fileConfig.ignoreTests);

  // 4. Resolve ignore patterns
  let mergedIgnore: string[] | undefined = undefined;
  const cliIgnore = isCliOverride("ignore", "i") ? (values.ignore as string[] | undefined) : undefined;
  const baseIgnore = cliIgnore ?? (Array.isArray(fileConfig.ignore) ? fileConfig.ignore : []);

  if (shouldIgnoreTests || baseIgnore.length > 0) {
    const testGlobs = shouldIgnoreTests ? TEST_IGNORE_PATTERNS : [];
    mergedIgnore = Array.from(new Set([...testGlobs, ...baseIgnore]));
  }

  // 5. Resolve explicitly requested plugins
  const requestedPlugins = isCliOverride("plugins") ? ((values.plugins as string[] | undefined) ?? []) : [];
  const resolvedPlugins = requestedPlugins.length > 0 ? assertPluginsExist(requestedPlugins) : [];

  // 6. Build CLI overrides
  const skipValues = isCliOverride("skip") ? ((values.skip as string[] | undefined) ?? []) : [];
  const invalidSkipValues = skipValues.filter((value) => !["3", "4", "smt"].includes(value.toLowerCase()));
  if (invalidSkipValues.length > 0) {
    throw new Error(`Unknown --skip value(s): ${invalidSkipValues.join(", ")}. Choose 3, 4, or smt.`);
  }

  const skipLayers = {
    ...(fileConfig.layers ?? {}),
    ...(skipValues.some((value) => value === "3") && { skip3: true }),
    ...(skipValues.some((value) => value === "4") && { skip4: true }),
    ...(skipValues.some((value) => value.toLowerCase() === "smt") && { skipSmt: true, skip3: true }),
  };

  const reportUnusedExports = values["no-report-unused-exports"] ? false : Boolean(values["report-unused-exports"]);
  const conventionalEntries = values["no-conventional-entries"] ? false : Boolean(values["conventional-entries"]);

  const cliOverrides: Partial<Config> = {
    ...(isCliOverride("rootDir", "r") && { rootDir: targetRootDir }),
    ...(isCliOverride("entry", "e") && values.entry && { entry: values.entry as string[] }),
    ...(isCliOverride("extensions", "x")
      ? values.extensions ? { extensions: values.extensions as string[] } : {}
      : { extensions: [".ts", ".tsx", ".js", ".jsx", ".vue"] }),
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
        ...(fileConfig.plugins ?? {}),
        ...Object.fromEntries(resolvedPlugins.map((plugin) => [plugin, true])),
      },
    }),
    ...(fixOption !== undefined && { fix: fixOption }),
    ...(isCliOverride("cache-from") && values["cache-from"] && { cacheFrom: values["cache-from"] as string }),
    ...(isCliOverride("cache-to") && values["cache-to"] && { cacheTo: values["cache-to"] as string }),
  };

  // 7. Merge DEFAULT_CONFIG -> fileConfig -> cliOverrides
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

  const resolvedWithFile = mergeConfig(baseConfig, fileConfig);
  const finalConfig = mergeConfig(resolvedWithFile, cliOverrides);

  const report: AnalysisReport = await analyze(finalConfig as AnalyzerOptions);

  if (values.sarif) {
    console.log(formatSarif(report));
  } else if (finalConfig.json || values.json) {
    console.log(JSON.stringify(report, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  } else {
    const terminal = formatTerminal(report, { showCycles: Boolean(finalConfig.cycles) });
    console.log(terminal);
  }

  const failTarget = (finalConfig.failOn ?? (values["fail-on"] as string | undefined) ?? "high") as any;
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

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes("-V") || rawArgs.includes("--version")) {
    const cliVersion = getCliVersion();
    const coreVersion = getCoreVersion(process.cwd());
    console.log(`CLI: ${cliVersion}, Core: ${coreVersion}`);
    return;
  }

  if (rawArgs.includes("-h") || rawArgs.includes("--help")) {
    printHelp();
    return;
  }

  const firstArg: string | undefined = rawArgs[0];
  const subcommands = new Set(["analyze", "export-cache", "import-cache"]);

  let command = "analyze";
  let commandArgs: string[] = rawArgs;

  if (firstArg !== undefined && subcommands.has(firstArg)) {
    command = firstArg;
    commandArgs = rawArgs.slice(1);
  }

  try {
    switch (command) {
      case "analyze":
        await runAnalyze(commandArgs);
        break;
      case "export-cache":
        await runExportCache(commandArgs);
        break;
      case "import-cache":
        await runImportCache(commandArgs);
        break;
    }
  } catch (error: any) {
    if (command === "analyze") {
      console.error("An unexpected error occurred during analysis:", error);
    } else {
      console.error(error?.message ?? error);
    }
    process.exit(1);
  }
}

main();