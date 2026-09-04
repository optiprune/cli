import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "pathe";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function write(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

async function runCli(rootDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "analyze", "--rootDir", rootDir, "--json"], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI loads optiprune.config.ts aliases and package-local TypeScript configuration in a monorepo", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "optiprune-cli-config-ts-"));
  try {
    await write(rootDir, "package.json", JSON.stringify({
      name: "cli-config-ts-monorepo",
      private: true,
      workspaces: ["packages/*"],
      dependencies: {
        "root-ignored": "1.0.0",
        "root-unused": "1.0.0",
      },
    }));
    await write(rootDir, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@root-config/*": ["config/*"] },
      },
    }));
    await write(rootDir, "config/root-values.ts", [
      "export const rootIgnore = ['root-generated/**'];",
      "export const rootIgnoreDependencies = ['root-ignored'];",
    ].join("\n"));
    await write(rootDir, "optiprune.config.ts", [
      "import { rootIgnore, rootIgnoreDependencies } from '@root-config/root-values';",
      "export default {",
      "  entry: ['src/index.ts'],",
      "  ignore: rootIgnore,",
      "  ignoreDependencies: rootIgnoreDependencies,",
      "  includeConventionalEntries: false,",
      "  failOn: 'none',",
      "  layers: { skip3: true, skip4: true },",
      "};",
    ].join("\n"));
    await write(rootDir, "src/index.ts", "export const rootEntry = true;\n");
    await write(rootDir, "root-generated/dead.ts", "export const rootGeneratedDeadCode = true;\n");

    await write(rootDir, "packages/app/package.json", JSON.stringify({
      name: "@fixture/app",
      private: true,
      dependencies: {
        "app-ignored": "1.0.0",
        "app-unused": "1.0.0",
      },
    }));
    await write(rootDir, "packages/app/config-values.ts", [
      "export const packageIgnore = ['generated/**'];",
      "export const packageIgnoreDependencies = ['app-ignored'];",
    ].join("\n"));
    await write(rootDir, "packages/app/optiprune.config.ts", [
      "import { packageIgnore, packageIgnoreDependencies } from './config-values.ts';",
      "export default {",
      "  entry: ['src/main.ts'],",
      "  ignore: packageIgnore,",
      "  ignoreDependencies: packageIgnoreDependencies,",
      "};",
    ].join("\n"));
    await write(rootDir, "packages/app/src/main.ts", "export const appEntry = true;\n");
    await write(rootDir, "packages/app/generated/dead.ts", "export const appGeneratedDeadCode = true;\n");

    await write(rootDir, "packages/lib/package.json", JSON.stringify({
      name: "@fixture/lib",
      private: true,
      dependencies: { "lib-unused": "1.0.0" },
    }));
    await write(rootDir, "packages/lib/src/index.ts", "export const libEntry = true;\n");
    await write(rootDir, "packages/lib/generated/dead.ts", "export const libGeneratedDeadCode = true;\n");

    const result = await runCli(rootDir);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);

    assert.ok(report.entryPoints.includes("src/index.ts"));
    assert.ok(report.entryPoints.includes("packages/app/src/main.ts"));
    assert.ok(report.entryPoints.includes("packages/lib/src/index.ts"));

    const unusedPackages = report.findings
      .filter((finding) => finding.rule === "unused-dependency" || finding.rule === "unused-dev-dependency")
      .map((finding) => String(finding.evidence.package))
      .sort();
    assert.deepEqual(unusedPackages, ["app-unused", "lib-unused", "root-unused"]);

    const unreachableFiles = report.findings
      .filter((finding) => finding.rule === "unreachable-file")
      .map((finding) => String(finding.file));
    assert.equal(unreachableFiles.some((file) => file.endsWith("root-generated/dead.ts")), false);
    assert.equal(unreachableFiles.some((file) => file.endsWith("packages/app/generated/dead.ts")), false);
    assert.equal(unreachableFiles.some((file) => file.endsWith("packages/lib/generated/dead.ts")), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
