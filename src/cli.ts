#!/usr/bin/env node

import path from "pathe";
import fs from "node:fs";
import { Command } from "commander";
const program = new Command();

// Using @ts-ignore for core imports as CI environments sometimes struggle 
// with subpath exports resolution in strict NodeNext mode.
// @ts-ignore
import { analyze, shouldFail, exportCache, importCache } from "@optiprune/core";
// @ts-ignore
import { formatTerminal, formatSarif } from "@optiprune/core/reporters";
// @ts-ignore
import type { AnalyzerOptions, AnalysisReport, Finding } from "@optiprune/core/types";

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

/**
 * Custom Terminal Formatter that includes the new dependency findings.
 */
function formatTerminalExtended(report: AnalysisReport): string {
  const output = formatTerminal(report);

  const unusedDevDeps = report.findings.filter((f: Finding) => f.rule === ("unused-dev-dependency" as any));
  const missingDeps = report.findings.filter((f: Finding) => f.rule === ("missing-dependency" as any));

  if (unusedDevDeps.length === 0 && missingDeps.length === 0) {
    return output;
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(bold("── Dependency Audit ─────────────────────────────────────────────"));

  if (unusedDevDeps.length > 0) {
    lines.push("");
    lines.push(bold(`  Unused devDependencies  (${unusedDevDeps.length})`));
    lines.push(dim("  These packages are listed in devDependencies but never imported in source code."));
    lines.push("");
    for (const f of unusedDevDeps) {
      const evidence = f.evidence as Record<string, any> | undefined;
      const pkg = evidence?.package || "unknown package";
      lines.push(`  ${yellow("▲")} ${bold(pkg)}${dim(" (package.json)")}`);
    }
  }

  if (missingDeps.length > 0) {
    lines.push("");
    lines.push(bold(`  Used in code but missing from package.json  (${missingDeps.length})`));
    lines.push(dim("  These packages are imported in source files but not declared as any dependency."));
    lines.push("");
    for (const f of missingDeps) {
      const evidence = f.evidence as Record<string, any> | undefined;
      const pkg = evidence?.package || "unknown package";
      lines.push(`  ${red("✖")} ${bold(pkg)}`);
    }
  }

  return output + "\n" + lines.join("\n");
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
  .option("--fix", "Automatically remove unused exports, dependencies, and unreachable files")
  .option("--cache-from <path>", "Path to a JSON file to import cache from before analysis")
  .option("--cache-to <path>", "Path to export the resulting cache to after analysis")
  .action(async (options) => {
    try {
      const rootDir: string = options.rootDir ?? process.cwd();
      
      // We cast to any here because the locally resolved @optiprune/core/types might 
      // be out of sync with the actual HeadLess API implementation during development.
      const analyzerOptions = {
        rootDir: rootDir,
        entry: options.entry ?? [],
        extensions: options.extensions ?? [".ts", ".tsx", ".js", ".jsx"],
        ignore: options.ignore ?? [],
        reportUnusedExports: options.reportUnusedExports,
        includeConventionalEntries: options.conventionalEntries,
        failOn: options.failOn ?? "high",
        json: options.json || options.sarif,
        skip3: options.skip3,
        skip4: options.skip4,
        verbose: options.verbose,
        fix: options.fix,
        cacheFrom: options.cacheFrom,
        cacheTo: options.cacheTo,
      } as any as AnalyzerOptions;

      const report: AnalysisReport = await analyze(analyzerOptions);

      if (options.sarif) {
        console.log(formatSarif(report));
      } else if (options.json) {
        console.log(JSON.stringify(report, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
      } else {
        console.log(formatTerminalExtended(report));
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
