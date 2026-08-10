# OptiPrune Configuration Guide (`config.md`)

OptiPrune uses a structured configuration file to define entry points, rule behavior, ignore patterns, and core analysis engine mechanics.

---

## Quick Start

Create an `optiprune.json` or `optiprune.jsonc` file in the root directory of your project:

```jsonc
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
When OptiPrune initializes, it checks the workspace root in the following order of precedence:

optiprune.json (Highest Priority)

optiprune.jsonc (Allows comments //, /* */, and trailing commas)

package.json (Falls back to reading an "optiprune" key)

---

## Configuration Reference
**1. File & Workspace Discovery**
rootDir (string, default: ".")

Specifies the base directory for source files relative to the project workspace root.

entry (string[], default: [])

Defines root entry files. Any code reachable from these files (and their dependency trees) is marked as used and protected from unused-code reports.

extensions (string[], default: [".ts", ".tsx", ".js", ".jsx"])

File extensions that OptiPrune will parse and analyze.

ignore (string[], default: [])

Glob patterns or directory paths to skip entirely during analysis (e.g., test fixtures, output directories).

**2. Export & Contract Safeguards**
externalContracts (string[], default: [])

List of public API symbol or interface names. Marks these exports as globally used across all execution layers, preventing OptiPrune from flagging them as dead code when building public libraries or plugins.

reportUnusedExports (boolean, default: true)

When set to true, OptiPrune reports exported functions, types, or variables that have no internal or external references.

includeConventionalEntries (boolean, default: true)

Automatically treats framework conventions (e.g., index.ts, main.ts, App.tsx) as entry points without needing manual listing in entry.

**3. CLI & Execution Controls**
failOn ("high" | "medium" | "low" | "info" | "none", default: "high")

Determines the minimum issue severity level required to exit the process with a non-zero exit code in CI/CD pipelines.

verbose (boolean, default: false)

Prints step-by-step diagnostic information to stdout.

json (boolean, default: false)

Formats output directly as raw JSON for external tool ingestion.

**4. Rule Overrides (rules)**
Fine-tune or disable specific inspection rules:

```json
"rules": {
  "rule-name": "error" | "warning" | "off"
}
```

- `"error"`: Causes finding to trigger build errors or exit failures.
- `"warning"`: Emits warnings without halting execution (unless configured by failOn).
- `"off"`: Disables rule checking entirely.

**5. Engine & Solver Tuning (layers)**
Configure isolated runtimes, SMT solvers, and symbolic execution passes:

| Option | Type | Default | Purpose |
| :----- | :--- | :------ | :------ |
| smtTimeoutMs | number | 10000 | SMT solver execution cap (in milliseconds) per proof path.|
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