import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "pathe";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function fixture(t, config = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "optiprune-cli-regression-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  const home = path.join(temp, "home");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  await writeFile(path.join(root, "src/index.js"), "console.log('entry');\n");
  await writeFile(path.join(root, "src/dead.js"), "export const unused = 1;\n");
  if (Object.keys(config).length) await writeFile(path.join(root, "optiprune.json"), JSON.stringify(config));
  return { root, home };
}

function run(root, home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, HOME: home },
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

test("help is side-effect free even when config enables file fixes", async (t) => {
  const { root, home } = await fixture(t, {
    fix: { rules: ["files"], confidence: "high" },
    layers: { skip3: true, skip4: true },
  });
  const result = await run(root, home, ["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /choose an action from the menu/i);
  assert.equal(await readFile(path.join(root, "src/dead.js"), "utf8").then(() => true, () => false), true);
  assert.equal(await readFile(path.join(root, ".optiprune/cache.json"), "utf8").then(() => true, () => false), false);
});

test("unknown typo flags are rejected before fixes can run", async (t) => {
  const { root, home } = await fixture(t);
  const result = await run(root, home, ["analyze", "--fix=files", "--dryrun", "--skip=3", "--skip=4"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown option.*dryrun/i);
  await readFile(path.join(root, "src/dead.js"), "utf8");
});

test("a variadic option without a value is rejected instead of silently ignored", async (t) => {
  const { root, home } = await fixture(t);
  const result = await run(root, home, ["analyze", "--entry"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /argument missing|requires an argument/i);
});

test("space-separated variadic flags work and unknown options fail", async (t) => {
  const { root, home } = await fixture(t);
  const result = await run(root, home, ["analyze", "--entry", "src/index.js", "--skip", "3", "4", "--fail-on", "none", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.entryPoints, ["src/index.js"]);

  const unknown = await run(root, home, ["analyze", "--not-a-real-option"]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /unknown option/i);
});

test("SARIF selected in optiprune.json is honored", async (t) => {
  const { root, home } = await fixture(t, {
    output: "sarif",
    failOn: "none",
    layers: { skip3: true, skip4: true },
  });
  const result = await run(root, home, ["analyze"]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, "2.1.0");
  assert.ok(Array.isArray(report.runs));
});

test("bare non-interactive invocation keeps analysis behavior", async (t) => {
  const { root, home } = await fixture(t, { failOn: "none", layers: { skip3: true, skip4: true } });
  const result = await run(root, home, []);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Optiprune Analysis Report/);
});
