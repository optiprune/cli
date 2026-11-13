import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "pathe";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function isolatedProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "optiprune-cli-version-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "cli-version-unknown-fixture",
    private: true,
  }));
  return root;
}

function runCli(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:1" },
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

test("does not claim a stale Core version when the installed Core cannot be located", async (t) => {
  const root = await isolatedProject(t);
  const result = await runCli(root, ["--version"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Core: unknown/);
  assert.doesNotMatch(result.stdout, /Core: 2\.0\.0-alpha\.1/);
});

test("refuses update core with a non-zero exit code before any network request", async (t) => {
  const root = await isolatedProject(t);
  const result = await runCli(root, ["update", "core"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unable to determine the installed @optiprune\/core version/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed|timed out/i);
});
