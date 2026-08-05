#!/usr/bin/env node

import path from "pathe";
import fs from "node:fs";
import { Command } from "commander";
const program = new Command();
import { analyze, shouldFail } from "@optiprune/core";
import { formatTerminal, formatSarif } from "@optiprune/core/reporters";
import type { AnalyzerOptions } from "@optiprune/core/types";
import { fileURLToPath } from "node:url";

// Helper to find the core version safely
function getCoreVersion(rootDir: string): string {
  try {
    const localCore = path.join(rootDir, "node_modules/@optiprune/core/package.json");
    if (fs.existsSync(localCore)) {
      const content = fs.readFileSync(localCore, "utf-8");
      return JSON.parse(content).version || "2.1.5";
    }
  } catch (e) {}
  return "2.1.5"; 
}

program
  .name("optiprune")
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
      // Ensure rootDir is a string for TS
      const rootDir: string = options.rootDir ?? process.cwd();
      
      program.version(getCoreVersion(rootDir));

      const analyzerOptions: AnalyzerOptions = {
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
      };

      const report = await analyze(analyzerOptions);

      // --- DEPENDENCY AUDIT INJECTION ---
      try {
        const pkgPath = path.join(rootDir, "package.json");
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const deps = pkg.dependencies || {};
          const devDeps = pkg.devDependencies || {};
          const allDeclared = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);
          
          const builtinModules = new Set(['fs', 'path', 'os', 'http', 'https', 'crypto', 'stream', 'util', 'events', 'node:url', 'node:fs', 'node:path', 'node:process', 'node:module']);
          const usedExternals = new Set<string>();

          for (const module of report.modules) {
            for (const edge of module.edges) {
              if (edge.resolution === 'external') {
                const specifier = edge.specifier;
                if (!specifier) continue;

                let pkgName = specifier.startsWith('@') 
                  ? specifier.split('/').slice(0, 2).join('/') 
                  : specifier.split('/')[0];
                
                if (pkgName && !builtinModules.has(pkgName)) {
                  usedExternals.add(pkgName);
                  
                  if (!allDeclared.has(pkgName)) {
                    const alreadyReported = report.findings.some(f => f.rule === ("missing-dependency" as any) && f.evidence?.package === pkgName);
                    if (!alreadyReported) {
                      report.findings.push({
                        rule: "missing-dependency" as any,
                        severity: "error",
                        confidence: "high",
                        message: `Package '${pkgName}' is used in '${module.path}' but not declared in package.json.`,
                        file: "package.json",
                        evidence: { package: pkgName, type: "missing" } as any
                      });
                      report.summary.findings++;
                      report.summary.errors++;
                    }
                  }
                }
              }
            }
          }

          for (const depName of Object.keys(deps)) {
            if (!usedExternals.has(depName)) {
              report.findings.push({
                rule: "unused-dependency" as any,
                severity: "warning",
                confidence: "high",
                message: `Package '${depName}' is declared as a dependency but never imported.`,
                file: "package.json",
                evidence: { package: depName, type: "dependency" } as any
              });
              report.summary.findings++;
              report.summary.warnings++;
            }
          }

          const skipList = new Set(['knip', '@optiprune/cli', '@optiprune/core', 'typescript', 'vite', 'vitest', 'jest', 'eslint', 'prettier']);
          for (const devDepName of Object.keys(devDeps)) {
            if (!usedExternals.has(devDepName) && !skipList.has(devDepName)) {
              const alreadyReported = report.findings.some(f => f.rule === ("unused-dev-dependency" as any) && f.evidence?.package === devDepName);
              if (!alreadyReported) {
                report.findings.push({
                  rule: "unused-dev-dependency" as any,
                  severity: "info",
                  confidence: "medium",
                  message: `DevDependency '${devDepName}' appears unused.`,
                  file: "package.json",
                  evidence: { package: devDepName, type: "devDependency" } as any
                });
                report.summary.findings++;
              }
            }
          }
        }
      } catch (e) {}
      // --- END OF INJECTION ---

      if (options.sarif) {
        console.log(formatSarif(report));
      } else if (options.json) {
        console.log(JSON.stringify(report, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
      } else {
        console.log(formatTerminal(report));
      }

      if (shouldFail(report, options.failOn as any)) process.exit(1);
    } catch (error) {
      console.error("An unexpected error occurred:", error);
      process.exit(1);
    }
  });

program.parse(process.argv);
