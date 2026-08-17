![OptiPrune analyzer animation](https://raw.githubusercontent.com/optiprune/core/main/animation.svg)

[![CLI npm version](https://img.shields.io/npm/v/%40optiprune%2Fcli?label=%40optiprune%2Fcli)](https://www.npmjs.com/package/@optiprune/cli)[![Core npm version](https://img.shields.io/npm/v/%40optiprune%2Fcore?label=%40optiprune%2Fcore)](https://www.npmjs.com/package/@optiprune/core)[![CLI package](https://img.shields.io/github/package-json/v/optiprune/cli?label=CLI%20package)](https://github.com/optiprune/cli)[![Core tests](https://img.shields.io/github/actions/workflow/status/optiprune/core/tests.yml?branch=main&label=core%20tests)](https://github.com/optiprune/core/actions/workflows/tests.yml)[![License](https://img.shields.io/github/license/optiprune/cli)](./LICENSE)[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D21-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

# OptiPrune

OptiPrune is a static dead-code analyzer for TypeScript and JavaScript projects. It combines parser-backed module graphs, export and member reachability, dependency and workspace inspection, dynamic-import analysis, semantic contracts, optional symbolic/concolic checks, and source-aware plugins.

The CLI package is `@optiprune/cli`. The analysis engine is available separately as the headless package `@optiprune/core`.

## Features

| Area | What is included |
| --- | --- |
| Project analysis | Entry discovery, module graphs, export/member reachability, dependency edges, strongly connected components, and cycle reporting. |
| TypeScript and JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, and `.vue` extensions by default, with custom extension lists available from the CLI or config. |
| Dynamic paths | Literal and pattern-based dynamic imports, unresolved-path findings, recovery information, and isolated execution checks. |
| Logic analysis | Constant conditions, contradictory guards, unreachable statements, and schema-impossible guards. |
| Dependencies | `package.json`, scripts, dependency/devDependency usage, package exports, bins, workspace packages, and lockfile-aware context. |
| Contracts and entries | Public API contracts, schema-aware protection, conventional entries, entry-file exports, test-file handling, and framework/plugin entry points. |
| Fixes | Opt-in fixes for unreachable files, unused exports and members, dependencies, development dependencies, and verified conditions. Every fix is confidence-gated and supports dry runs. |
| Output | Human-readable terminal output, JSON reports, and SARIF output for CI/code-scanning workflows. |
| Headless usage | `analyze`, `shouldFail`, cache helpers, fix helpers, reporters, and public TypeScript types from `@optiprune/core`. |
| Plugins | Source-aware adapters for frameworks, build tools, test tools, runtimes, package managers, and workspace conventions. |

## Installation

Install the CLI as a development dependency:

```bash
npm install --save-dev @optiprune/cli
# or
pnpm add -D @optiprune/cli
# or
yarn add -D @optiprune/cli
```

The Core package currently requires Node.js 21 or newer.

## Quick start

Run an analysis from the project root:

```bash
npx @optiprune/cli analyze
```

The default command is `analyze`, so this is equivalent:

```bash
npx @optiprune/cli
```

Select a machine-readable output format when integrating with tooling:

```bash
npx @optiprune/cli analyze --json
npx @optiprune/cli analyze --sarif > optiprune.sarif
```

## Commands

| Command | Purpose |
| --- | --- |
| `analyze [options]` | Analyze the project. This is the default command. |
| `export-cache <targetPath>` | Export the current analysis cache to a JSON file. |
| `import-cache <sourcePath>` | Import an external cache JSON file into the local project cache. |
| `optiprune --help` | Print command and option help. |
| `optiprune --version` | Print the CLI and detected Core versions. |

## Analyze flags

| Flag | Description | Default |
| --- | --- | --- |
| `-r, --rootDir <path>` | Root directory of the project. | Current working directory |
| `-e, --entry <patterns...>` | Entry-point patterns, globs, or file paths. | `[]` |
| `-x, --extensions <exts...>` | File extensions to analyze. | `.ts .tsx .js .jsx .vue` |
| `-i, --ignore <patterns...>` | Glob patterns to ignore. | `[]` |
| `--no-report-unused-exports` | Disable unused-export reporting. | Enabled |
| `--no-conventional-entries` | Exclude conventional entries such as `src/index.ts`. | Included |
| `--include-entry-exports` | Report unused exports declared directly in entry files. | Disabled |
| `--cycles` | Print detected dependency cycles. | Disabled |
| `--ignore-tests` | Ignore test files such as `test.ts`, `*.test.ts`, and `__tests__`. | Disabled |
| `--fail-on <confidence>` | Exit non-zero when findings meet the selected confidence level: `high`, `medium`, `low`, or `none`. | `high` |
| `--json` | Print the structured analysis report as JSON. | Disabled |
| `--sarif` | Print SARIF output. | Disabled |
| `--skip-3` | Skip the SMT constraint-analysis layer. | Disabled |
| `--skip-4` | Skip the concolic execution-proof layer. | Disabled |
| `-v, --verbose` | Print verbose output and internal graph state. | Disabled |
| `--fix <rules...>` | Select fix targets: `files`, `exports`, `dependencies`, `devDependencies`, or `conditions`. | None |
| `--confidence <level>` | Minimum fix confidence: `high`, `medium+`, or `low+`. | `high` |
| `--force` | Allow a selected fix when the source edit is otherwise considered unsafe. | Disabled |
| `--dry-run` | Log planned fixes without changing files. | Disabled |
| `--cache-from <path>` | Import a JSON cache before analysis. | None |
| `--cache-to <path>` | Export the resulting cache after analysis. | None |

`--confidence`, `--force`, and `--dry-run` require `--fix`. Unknown fix targets are rejected before analysis begins.

## Fixes

Fixes are explicit rather than implicit. Start with a dry run, inspect the output, then omit `--dry-run` when the proposed changes are acceptable.

```bash
npx @optiprune/cli analyze \
  --fix files exports dependencies devDependencies conditions \
  --confidence medium+ \
  --dry-run
```

| Target | Applies to |
| --- | --- |
| `files` | Verified unreachable files. |
| `exports` | Verified unused exports and members. |
| `dependencies` | Unused runtime dependencies. |
| `devDependencies` | Unused development dependencies. |
| `conditions` | Verified constant conditions. |

`--force` changes the safety decision for the selected fix operation; it does not make an unverified finding correct. Use it only when the source edit has been reviewed.

## Cache

Use cache files to reuse analysis state in local workflows or CI:

```bash
npx @optiprune/cli analyze \
  --cache-from .optiprune/cache.json \
  --cache-to .optiprune/cache.json

npx @optiprune/cli export-cache .optiprune/cache.json
npx @optiprune/cli import-cache .optiprune/cache.json
```

`export-cache` and `import-cache` accept `-r, --rootDir <path>` when the cache belongs to a directory other than the current working directory.

## Configuration

OptiPrune reads configuration through the Core loader. Supported sources include:

| Source | Notes |
| --- | --- |
| `optiprune.json` | Standard JSON configuration. |
| `optiprune.jsonc` | JSON with comments and trailing commas. |
| `optiprune.config.ts` | TypeScript configuration with a default export. |
| `optiprune.config.js` | JavaScript ESM configuration with a default export. |
| `optiprune.config.mjs` | JavaScript ESM configuration with a default export. |
| `package.json#optiprune` | Package field configuration. |

See [`config.md`](./config.md) for the configuration reference and [`schema.json`](https://github.com/optiprune/core/blob/main/schema.json) for the authoritative schema.

## Headless Core API

Use `@optiprune/core` directly when the CLI is not the right integration boundary:

```bash
npm install @optiprune/core
```

```
import { analyze, shouldFail } from "@optiprune/core";

const report = await analyze({
  rootDir: process.cwd(),
  entry: ["src/index.ts"],
  output: "json",
});

console.log(report.summary);

if (shouldFail(report, "high")) {
  process.exitCode = 1;
}
```

The Core package also exposes cache helpers, `applyFixes`, reporters, and public types:

```
import { applyFixes, exportCache, importCache } from "@optiprune/core";
import { formatSarif, formatTerminal } from "@optiprune/core/reporters";
import type { AnalysisReport, AnalyzerOptions, Finding } from "@optiprune/core/types";
```

An `AnalysisReport` contains summary counts, findings, entry points, module records, exports, dependency edges, and strongly connected components.

## Plugin model

Plugins provide source-aware context for frameworks, build tools, test runners, runtimes, package managers, and workspace conventions. They can contribute entry patterns, mark files or packages as used, interpret project metadata, and participate in analysis lifecycle hooks.

Browse the [Core plugin directory](https://github.com/optiprune/core/tree/main/src/plugins) to inspect the current source-backed set and the `AnalyzerPlugin`/`PluginAdapter` contracts.

## Development

Build the package from this repository:

```bash
npm run build
npm test
```

The Core repository uses Vitest for its test suite. The workflow badges above reflect the status reported by GitHub Actions rather than a hard-coded claim in this README.

## Links

| Resource | Link |
| --- | --- |
| CLI repository | [github.com/optiprune/cli](https://github.com/optiprune/cli) |
| Core repository | [github.com/optiprune/core](https://github.com/optiprune/core) |
| CLI package | [npmjs.com/package/@optiprune/cli](https://www.npmjs.com/package/@optiprune/cli) |
| Core package | [npmjs.com/package/@optiprune/core](https://www.npmjs.com/package/@optiprune/core) |
| Documentation site | [opti.drml.int.yt](https://opti.drml.int.yt/) |
| License | [MIT](./LICENSE) |