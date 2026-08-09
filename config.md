# OptiPrune Configuration Example

Here is an example of an `optiprune.config.ts` based on the type definitions from the `@optiprune/core` package. This file allows you to customize analyzer behavior, engine parameters, and rule severity levels.

```typescript
import { defineConfig } from '@optiprune/core';

/**
 * OptiPrune Configuration File
 * 
 * This file is automatically detected by the CLI when placed 
 * in the root directory of your project.
 */
export default defineConfig({
  // --- Base Options ---
  
  // The root directory of the project (default: current working directory)
  rootDir: '.',

  // Entry points for analysis. Define the files here from which 
  // code reachability will be checked.
  entry: [
    'src/main.ts',
    'src/api/server.ts'
  ],

  // File extensions to scan
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],

  // Glob patterns for files or directories that should be ignored
  ignore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/test/fixtures/**'
  ],

  // --- Analysis Behavior ---

  // Symbols considered "externally consumed" (e.g., public APIs).
  // These will not be flagged as unused, even if no internal import exists.
  externalContracts: [
    'handleRequest',
    'PluginInterface'
  ],

  // Whether unused exports (functions, classes, types) should be reported
  reportUnusedExports: true,

  // Whether conventional entry points (like index.ts, main.ts) 
  // should automatically be included in the analysis.
  includeConventionalEntries: true,

  // Failure threshold for the process (exit code 1).
  // Possible values: "high" | "medium" | "low" | "info" | "none"
  failOn: 'high',

  // --- Engine Layer (Advanced) ---

  layers: {
    // Timeout for the Z3 SMT solver in milliseconds
    smtTimeoutMs: 5000,
    
    // Memory limit for the WASM-based QuickJS sandbox in MB
    isolateMemoryLimitMb: 128,
    
    // Enables concolic execution to mathematically prove code path reachability 
    // (prevents false positives).
    enableConcolicProof: true,
    
    // Skips specific analysis layers (recommended for debugging only)
    skip3: false, // Symbol Propagation
    skip4: false  // Concolic Execution
  },

  // --- Rule Configuration ---

  // Override severity levels for specific findings.
  // Possible values: "error" | "warning" | "off"
  rules: {
    'unused-dependency': 'warning',
    'unused-dev-dependency': 'info',
    'missing-dependency': 'error',
    'unreachable-file': 'error',
    'unused-export': 'warning',
    'unused-member': 'info',
    'constant-condition': 'off',
    'unresolved-import': 'error'
  },

  // --- Output ---
  
  // Detailed log output for debugging
  verbose: false,
  
  // Output results in JSON format
  json: false
});
```

## Usage

1. Ensure `@optiprune/core` is installed in your project.
2. Create the `optiprune.config.ts` file in your root directory.
3. Run `optiprune` from your terminal. The analyzer will load the configuration automatically.