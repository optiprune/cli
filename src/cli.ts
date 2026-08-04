#!/usr/bin/env node

import path from "pathe";
import { Command } from "commander";
const program = new Command();
import { analyze, shouldFail } from "@optiprune/core";

import { formatTerminal, formatSarif } from "@optiprune/core/reporters";
import type { AnalyzerOptions } from "@optiprune/core/types";

import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "2.1.5"; // Assuming same version as core for now

program
  .name("optiprune")
  .version(VERSION)
  .description("Finds dead code in TypeScript/JavaScript projects.")
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
  .action(async (options) => {
    try {
      const analyzerOptions: AnalyzerOptions = {
        rootDir: options.rootDir,
        entry: options.entry,
        extensions: options.extensions,
        ignore: options.ignore,
        reportUnusedExports: options.reportUnusedExports,
        includeConventionalEntries: options.conventionalEntries,
        failOn: options.failOn,
        json: options.json || options.sarif,
        skip3: options.skip3,
        skip4: options.skip4,
      };

      const report = await analyze(analyzerOptions);

      if (options.sarif) {
        console.log(formatSarif(report));
      } else if (options.json) {
        try {
          // Use a replacer to handle potential BigInt or other non-serializable types if any
          const json = JSON.stringify(report, (key, value) => 
            typeof value === 'bigint' ? value.toString() : value, 
            2
          );
          console.log(json);
        } catch (jsonError) {
          console.error("Failed to generate JSON output:", jsonError);
          process.exit(1);
        }
      } else {
        console.log(formatTerminal(report));
      }

      if (shouldFail(report, options.failOn as any)) {
        process.exit(1);
      }
    } catch (error) {
      console.error("An unexpected error occurred:", error);
      process.exit(1);
    }
  });

program.parse(process.argv);
