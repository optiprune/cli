#!/usr/bin/env node

import path from "pathe";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { assertPluginsExist } from "./plugin-resolution.js";
const program = new Command();
const FIX_TARGETS = new Set(["files", "exports", "dependencies", "devDependencies", "conditions", "json"]);

// Test and fixture patterns defined directly in the CLI
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

// Using @ts-ignore for core imports as CI environments sometimes struggle 
// with subpath exports resolution in strict NodeNext mode.
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

// Helper to find the CLI package version
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

// Helper to find the core version safely
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

const cliVersion = getCliVersion();
const coreVersion = getCoreVersion(process.cwd());

program
  .name("optiprune")
  .description("Finds dead code in TypeScript/JavaScript projects.")
  .version(
    `CLI: ${cliVersion}, Core: ${coreVersion}`,
    "-V, --version",
    "output the version number"
  );

program
  .command("analyze", { isDefault: true })
  .description("Perform full analysis of the project")
  .option("-r, --rootDir <path>", "Root directory of the project", process.cwd())
  .option("-e, --entry <patterns...>", "Entry point patterns (glob or file paths)", undefined)
  .option("-x, --extensions <exts...>", "File extensions to analyze", [".ts", ".tsx", ".js", ".jsx", ".vue"])
  .option("-i, --ignore <patterns...>", "Ignore patterns (glob)", undefined)
  .option("--no-report-unused-exports", "Do not report unused exports")
  .option("--no-conventional-entries", "Do not include conventional entry points (e.g., src/index.ts)")
  .option("--include-entry-exports", "Report unused exports declared directly in entry files")
  .option("--include-entry-members", "Report unused members declared in objects exported directly from entry files")
  .option("--cycles", "Print detected dependency cycles")
  .option("--ignore-tests", "Ignore test files such as test.ts, *.test.ts, fixtures, and __tests__ files")
  .option("--ignore-unknown-import", "Ignore dynamic and unknown import patterns for reachability")
  .option("--fail-on <confidence>", "Fail on findings with confidence level (high, medium, low, none)", "high")
  .option("--json", "Output results as JSON")
  .option("--sarif", "Output results in SARIF format")
  .option("--skip <layers...>", "Skip analysis layers (3, 4, or smt)")
  .option("-v, --verbose", "Show verbose output and internal graph state; with --json includes structured debug diagnostics")
  .option("--fix <rules...>", "Fix selected targets: files, exports, dependencies, devDependencies, conditions, json")
  .option("--fix-json", "Safely repair recoverable package.json JSON errors (equivalent to --fix json)")
  .option("--plugins <names...>", "Force-enable built-in plugins by name (for example: astro vite vitest)")
  .option("--confidence <level>", "Minimum confidence to fix (high, medium+, low+, all)", "high")
  .option("--force", "Allow fixes when the source edit is otherwise considered unsafe")
  .option("--dry-run", "Log what would be fixed without changing files")
  .option("--cache-from <path>", "Path to a JSON file to import cache from before analysis")
  .option("--cache-to <path>", "Path to export the resulting cache to after analysis")
  .action(async (options, command) => {
    try {
      const isCliOverride = (name: string) => command.getOptionValueSource(name) === "cli";
      const targetRootDir = path.resolve(options.rootDir ?? process.cwd());

      // 1. Read project config via core's loadConfig
      const fileConfig: Config = typeof loadConfig === "function" ? await loadConfig(targetRootDir) : {};

      // 2. Resolve fix configurations
      let fixOption: boolean | FixConfig | undefined = undefined;
      const hasExplicitFix = isCliOverride("fix");
      const hasJsonFix = isCliOverride("fixJson") && !!options.fixJson;
      const hasFixFlags = hasExplicitFix || hasJsonFix || isCliOverride("confidence") || isCliOverride("force") || isCliOverride("dryRun");
      if (hasFixFlags) {
        if (!hasExplicitFix && !hasJsonFix) {
          throw new Error("--confidence, --force, and --dry-run require --fix <target...> or --fix-json");
        }
        const requestedTargets = [
          ...(hasExplicitFix ? (options.fix as string[]) : []),
          ...(hasJsonFix ? ["json"] : []),
        ];
        const invalidTargets = requestedTargets.filter((target) => !FIX_TARGETS.has(target));
        if (invalidTargets.length > 0) {
          throw new Error(`Unknown --fix target(s): ${invalidTargets.join(", ")}. Choose files, exports, dependencies, devDependencies, conditions, or json.`);
        }
        fixOption = {
          confidence: options.confidence as any,
          rules: [...new Set(requestedTargets)],
          force: !!options.force,
          dryRun: !!options.dryRun,
        } as FixConfig;
      }

      // 3. Determine if test ignoring is active (CLI flag OR config file setting)
      const shouldIgnoreTests = isCliOverride("ignoreTests")
        ? !!options.ignoreTests
        : !!fileConfig.ignoreTests;

      // 4. Resolve ignore patterns directly in the CLI
      let mergedIgnore: string[] | undefined = undefined;
      const cliIgnore = isCliOverride("ignore") ? (options.ignore as string[]) : undefined;
      const baseIgnore = cliIgnore ?? (Array.isArray(fileConfig.ignore) ? fileConfig.ignore : []);

      if (shouldIgnoreTests || baseIgnore.length > 0) {
        const testGlobs = shouldIgnoreTests ? TEST_IGNORE_PATTERNS : [];
        mergedIgnore = Array.from(new Set([...testGlobs, ...baseIgnore]));
      }

      // 5. Resolve explicitly requested plugins before building overrides.
      const requestedPlugins = isCliOverride("plugins") ? (options.plugins as string[]) : [];
      const resolvedPlugins = requestedPlugins.length > 0 ? assertPluginsExist(requestedPlugins) : [];

      // 6. Build CLI overrides
      const skipValues = isCliOverride("skip") ? (options.skip as string[]) : [];
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
      const cliOverrides: Partial<Config> = {
        ...(isCliOverride("rootDir") && { rootDir: targetRootDir }),
        ...(isCliOverride("entry") && { entry: options.entry }),
        ...(isCliOverride("extensions") && { extensions: options.extensions }),
        ...(mergedIgnore !== undefined && { ignore: mergedIgnore }),
        ...(shouldIgnoreTests && { ignoreTests: true }),
        ...(isCliOverride("reportUnusedExports") && {
          reportUnusedExports: options.reportUnusedExports,
        }),
        ...(isCliOverride("conventionalEntries") && {
          includeConventionalEntries: options.conventionalEntries,
        }),
        ...(isCliOverride("includeEntryExports") && { includeEntryExports: options.includeEntryExports }),
        ...(isCliOverride("includeEntryMembers") && { includeEntryMembers: options.includeEntryMembers }),
        ...(isCliOverride("cycles") && { cycles: options.cycles }),
        ...(isCliOverride("ignoreUnknownImport") && { ignoreUnknownImport: options.ignoreUnknownImport }),
        ...(isCliOverride("failOn") && { failOn: options.failOn }),
        ...(isCliOverride("json") && { json: options.json }),
        ...(isCliOverride("skip") && { layers: skipLayers as any }),
        ...(isCliOverride("verbose") && { verbose: options.verbose }),
        ...(isCliOverride("plugins") && {
          plugins: {
            ...(fileConfig.plugins ?? {}),
            ...Object.fromEntries(resolvedPlugins.map((plugin) => [plugin, true])),
          },
        }),
        ...(fixOption !== undefined && { fix: fixOption }),
        ...(isCliOverride("cacheFrom") && { cacheFrom: options.cacheFrom }),
        ...(isCliOverride("cacheTo") && { cacheTo: options.cacheTo }),
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

      if (options.sarif) {
        console.log(formatSarif(report));
      } else if (finalConfig.json || options.json) {
        console.log(JSON.stringify(report, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
      } else {
        const terminal = formatTerminal(report, { showCycles: !!finalConfig.cycles });
        console.log(terminal);
      }

      if (shouldFail(report, (finalConfig.failOn ?? options.failOn) as any)) process.exit(1);
    } catch (error) {
      console.error("An unexpected error occurred during analysis:", error);
      process.exit(1);
    }
  });

program
  .command("export-cache <targetPath>")
  .description("Export the current analysis cache to a JSON file")
  .option("-r, --rootDir <path>", "Root directory of the project", process.cwd())
  .action(async (targetPath, options) => {
    try {
      const rootDir = options.rootDir ?? process.cwd();
      await exportCache(rootDir, targetPath);
      console.log(`${yellow("✔")} Cache exported to ${bold(targetPath)}`);
    } catch (error) {
      console.error("Failed to export cache:", error);
      process.exit(1);
    }
  });

program
  .command("import-cache <sourcePath>")
  .description("Import an external cache JSON file into the local directory")
  .option("-r, --rootDir <path>", "Root directory of the project", process.cwd())
  .action(async (sourcePath, options) => {
    try {
      const rootDir = options.rootDir ?? process.cwd();
      await importCache(rootDir, sourcePath);
      console.log(`${yellow("✔")} Cache imported from ${bold(sourcePath)}`);
    } catch (error) {
      console.error("Failed to import cache:", error);
      process.exit(1);
    }
  });

program.parse(process.argv);