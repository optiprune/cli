# OptiPrune Configuration Guide (`config.md`)

OptiPrune uses a structured configuration file to define entry points, rule behavior, ignore patterns, and core analysis engine mechanics.

---

## Quick Start

Create an `optiprune.json` or `optiprune.jsonc` file in the root directory of your project:

```
{
  "$schema": "https://raw.githubusercontent.com/optiprune/core/refs/heads/main/schema.json",
  "rootDir": "src",
  "entry": ["src/index.ts", "src/cli.ts"],
  "ignore": ["**/*.test.ts", "**/dist/**"],
  "externalContracts": ["PluginAdapter", "AnalyzerPlugin"],
  "failOn": "high",
  "rules": {
    "unused-variable": "warning",
    "dead-code": "error"
  }
}
```

---

## How OptiPrune Loads Configuration

OptiPrune resolves configuration from the directory passed to `--rootDir` (or the current working directory when `--rootDir` is omitted). It checks these sources in order; the first valid source wins:

| Priority | Source | Evaluation |
| --- | --- | --- |
| 1 | `optiprune.json` | Strict JSON; highest priority. |
| 2 | `optiprune.jsonc` | JSONC with comments and trailing commas. |
| 3 | `optiprune.config.ts` | Loaded through Jiti; use a default export. |
| 4 | `optiprune.config.js` | Loaded as JavaScript with a default export. |
| 5 | `optiprune.config.mjs` | Loaded as ESM JavaScript with a default export. |
| 6 | `package.json` | Uses the top-level `optiprune` object as a fallback. |

### Recommended `optiprune.config.ts`

```ts
import { defineConfig } from '@optiprune/core';

export default defineConfig({
  rootDir: '.',
  entry: ['src/index.ts'],
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  ignore: ['**/dist/**', '**/*.generated.ts'],
  ignoreTests: true,
  failOn: 'high',
  output: 'terminal',
  layers: { skip3: false, skip4: false },
});
```

The config file must use a default export. `defineConfig` is a typed identity helper exported by `@optiprune/core`; it does not alter the object. Relative paths are resolved from the analyzed project root, and CLI options override loaded configuration values.

---

## Configuration Reference

**1. File & Workspace Discovery**rootDir (string, default: ".")

Specifies the base directory for source files relative to the project workspace root.

entry (string[], default: [])

Defines root entry files. Any code reachable from these files (and their dependency trees) is marked as used and protected from unused-code reports.

extensions (string[], default: [".ts", ".tsx", ".js", ".jsx"])

File extensions that OptiPrune will parse and analyze.

ignore (string[], default: [])

Glob patterns or directory paths to skip entirely during analysis (e.g., test fixtures, output directories).

**2. Export & Contract Safeguards**externalContracts (string[], default: [])

List of public API symbol or interface names. Marks these exports as globally used across all execution layers, preventing OptiPrune from flagging them as dead code when building public libraries or plugins.

reportUnusedExports (boolean, default: true)

When set to true, OptiPrune reports exported functions, types, or variables that have no internal or external references.

includeConventionalEntries (boolean, default: true)

Automatically treats framework conventions (e.g., index.ts, main.ts, App.tsx) as entry points without needing manual listing in entry.

**3. CLI & Execution Controls**failOn ("high" | "medium" | "low" | "info" | "none", default: "high")

Determines the minimum issue severity level required to exit the process with a non-zero exit code in CI/CD pipelines.

verbose (boolean, default: false)

Prints step-by-step diagnostic information. When combined with `json: true` or `output: "json"`, Core embeds machine-readable parser and JSON-recovery diagnostics in `report.debug` instead of mixing them into JSON stdout.

json (boolean, default: false)

Formats output directly as raw JSON for external tool ingestion.

**4. Automated Fixes (fix)**

Configures the automatic removal of dead code. Can be a boolean or an object for granular control.

```
{
  "fix": {
    "confidence": "medium+",
    "rules": ["exports", "files", "dependencies", "devDependencies", "json"],
    "dryRun": false
  }
}
```

- **confidence**: Minimum confidence to apply a fix (`high`, `medium+`, `low+`, `all`).

- **rules**: Specific rules or categories (`exports`, `files`, `dependencies`, `devDependencies`, `conditions`, `json`) to fix. The `json` rule only rewrites safely recoverable `package.json` syntax such as comments, trailing commas, missing commas, and missing closing delimiters. Ambiguous or unsafe forms remain unchanged and are reported with a location and reason.

- **dryRun**: If true, logs what would be fixed without modifying files.

**5. Plugin Overrides (plugins)**

Enable or disable an installed source-aware plugin explicitly. Use the canonical plugin name, including the `-plugin` suffix:

```json
{
  "plugins": {
    "astro-plugin": true,
    "vite-plugin": true,
    "vitest-plugin": true
  }
}
```

The CLI equivalent is repeatable and accepts short names without the suffix: `--plugins astro vite vitest`. Each requested plugin is force-enabled. An unknown name produces `Did you mean ...?` when a familiar match exists; otherwise the CLI reports `No Plugin found with the name ...`.

**6. Rule Overrides (rules)**Fine-tune or disable specific inspection rules:

```json
"rules": {
  "rule-name": "error" | "warning" | "off"
}
```

- `"error"`: Causes finding to trigger build errors or exit failures.

- `"warning"`: Emits warnings without halting execution (unless configured by failOn).

- `"off"`: Disables rule checking entirely.

**7. Engine & Solver Tuning (layers)**Configure isolated runtimes, SMT solvers, and symbolic execution passes:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| smtTimeoutMs | number | 10000 | SMT solver execution cap (in milliseconds) per proof path. |
| isolateMemoryLimitMb | number | 128 | Memory ceiling (in MB) allocated to V8 worker isolates. |
| enableConcolicProof | boolean | false | Enables concolic analysis to prove dead execution paths. |
| skip3 | boolean | false | Bypasses Analysis Layer 3. |
| skip4 | boolean | false | Bypasses Analysis Layer 4. |

---

## Alternative: package.json Configuration

If you do not want an additional configuration file in your root folder, add an "optiprune" field inside package.json:

```json
{
  "name": "my-library",
  "version": "1.0.0",
  "optiprune": {
    "entry": ["src/index.ts"],
    "externalContracts": ["MyPublicApi"],
    "failOn": "medium"
  }
}
```