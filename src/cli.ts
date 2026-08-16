#!/usr/bin/env node

import path from "pathe";
import fs from "node:fs";
import { Command } from "commander";
const program = new Command();
const FIX_TARGETS = new Set(["files", "exports", "dependencies", "devDependencies", "conditions"]);

// Using @ts-ignore for core imports as CI environments sometimes struggle 
// with subpath exports resolution in strict NodeNext mode.
// @ts-ignore
import { analyze, shouldFail, exportCache, importCache } from "@optiprune/core";
// @ts-ignore
import { formatTerminal, formatSarif } from "@optiprune/core/reporters";
// @ts-ignore
import type { AnalyzerOptions, AnalysisReport, Finding, FixConfig } from "@optiprune/core/types";

/** ANSI colour helpers */
const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow= (s: string) => `\x1b[33m${s}\x1b[0m`;
const red   = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim   = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Helper to find the core version safely
function getCoreVersion(rootDir: string): string {
  try {
    const localCore = path.join(rootDir, "node_modules/@optiprune/core/package.json");
    if (fs.existsSync(localCore)) {
      const content = fs.readFileSync(localCore, "utf-8");
      const pkg = JSON.parse(content);
      return pkg.version || "2.1.5";
    }
  } catch (e) {}
  return "2.1.5"; 
}

program
  .name("optiprune")
  .description("Finds dead code in TypeScript/JavaScript projects.")
  .version(getCoreVersion(process.cwd()));

program
  .command("analyze", { isDefault: true })
  .description("Perform full analysis of the project")
  .option("-r, --rootDir <path>", "Root directory of the project", process.cwd())
  .option("-e, --entry <patterns...>", "Entry point patterns (glob or file paths)", [])
  .option("-x, --extensions <exts...>", "File extensions to analyze", [".ts", ".tsx", ".js", ".jsx"])
  .option("-i, --ignore <patterns...>", "Ignore patterns (glob)", [])
  .option("--no-report-unused-exports", "Do not report unused exports")
  .option("--no-conventional-entries", "Do not include conventional entry points (e.g., src/index.ts)")
  .option("--fail-on <confidence>", "Fail on findings with confidence level (high, medium, low, none)", "high")
  .option("--json", "Output results as JSON")
  .option("--sarif", "Output results in SARIF format")
  .option("--skip-3", "Skip Layer 3 (SMT Constraint Solver)")
  .option("--skip-4", "Skip Layer 4 (Concolic Execution Proofs)")
  .option("-v, --verbose", "Show verbose output and internal graph state")
  .option("--fix <rules...>", "Fix selected targets: files, exports, dependencies, devDependencies")
  .option("--confidence <level>", "Minimum confidence to fix (high, medium+, low/low+, all)", "high")
  .option("--force", "Allow fixes below the configured confidence threshold")
  .option("--dry-run", "Log what would be fixed without changing files")
  .option("--cache-from <path>", "Path to a JSON file to import cache from before analysis")
  .option("--cache-to <path>", "Path to export the resulting cache to after analysis")
  .action(async (options, command) => {
    try {
      // Commander materializes defaults in `options`. Forwarding those values
      // would make them override optiprune.json/jsonc/package.json settings.
      // Only an option explicitly supplied on the command line wins over config.
      const isCliOverride = (name: string) => command.getOptionValueSource(name) === "cli";

      // Build FixConfig only from explicitly supplied fix-related CLI values.
      let fixOption: boolean | FixConfig | undefined = undefined;
      const hasFixFlags = isCliOverride("fix") || isCliOverride("confidence") || isCliOverride("force") || isCliOverride("dryRun");
      if (hasFixFlags) {
        if (!isCliOverride("fix")) {
          throw new Error("--confidence, --force, and --dry-run require --fix <target...>");
        }
        const invalidTargets = (options.fix as string[]).filter((target) => !FIX_TARGETS.has(target));
        if (invalidTargets.length > 0) {
          throw new Error(`Unknown --fix target(s): ${invalidTargets.join(", ")}. Choose files, exports, dependencies, devDependencies, or conditions.`);
        }
        fixOption = {
          confidence: options.confidence as any,
          rules: options.fix,
          force: !!options.force,
          dryRun: !!options.dryRun,
        } as FixConfig;
      }

      // The core resolves defaults and file configuration. The CLI deliberately
      // provides only explicit user overrides so the documented precedence is:
      // CLI flag > config file > core default.

      const analyzerOptions = {
        ...(isCliOverride("rootDir") && { rootDir: options.rootDir }),
        ...(isCliOverride("entry") && { entry: options.entry }),
        ...(isCliOverride("extensions") && { extensions: options.extensions }),
        ...(isCliOverride("ignore") && { ignore: options.ignore }),
        ...(isCliOverride("reportUnusedExports") && {
          reportUnusedExports: options.reportUnusedExports,
        }),
        ...(isCliOverride("conventionalEntries") && {
          includeConventionalEntries: options.conventionalEntries,
        }),
        ...(isCliOverride("failOn") && { failOn: options.failOn }),
        ...(isCliOverride("json") && { json: options.json }),
        ...(isCliOverride("skip3") && { skip3: options.skip3 }),
        ...(isCliOverride("skip4") && { skip4: options.skip4 }),
        ...(isCliOverride("verbose") && { verbose: options.verbose }),
        ...(fixOption !== undefined && { fix: fixOption }),
        ...(isCliOverride("cacheFrom") && { cacheFrom: options.cacheFrom }),
        ...(isCliOverride("cacheTo") && { cacheTo: options.cacheTo }),
      } as AnalyzerOptions;

      const report: AnalysisReport = await analyze(analyzerOptions);

      if (options.sarif) {
        console.log(formatSarif(report));
      } else if (options.json) {
        console.log(JSON.stringify(report, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
      } else {
        console.log(formatTerminal(report));
      }

      if (shouldFail(report, options.failOn as any)) process.exit(1);
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
