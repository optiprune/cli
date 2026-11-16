import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "pathe";
import test from "node:test";

const { readConfigDocument, writeConfigDocument } = await import("../dist/config-document.js");

test("JSONC config edits preserve comments and refuse malformed files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "optiprune-jsonc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "optiprune.jsonc");
  const original = "{\n  // keep this explanation\n  \"enabled\": true,\n}\n";
  await writeFile(file, original);

  const document = readConfigDocument(file);
  assert.equal(document.value.enabled, true);
  writeConfigDocument(file, document, "enabled", false);
  const updated = await readFile(file, "utf8");
  assert.match(updated, /keep this explanation/);
  assert.match(updated, /\"enabled\": false/);

  const malformed = "{\n  // unterminated\n  \"enabled\": true,\n";
  await writeFile(file, malformed);
  const invalid = readConfigDocument(file);
  assert.equal(invalid.writable, false);
  writeConfigDocument(file, invalid, "enabled", false);
  assert.equal(await readFile(file, "utf8"), malformed);
});
