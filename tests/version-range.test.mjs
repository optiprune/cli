import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { selectHighestCompatibleVersion } = await import(fileURLToPath(new URL("../dist/version-range.js", import.meta.url)));

test("selects the highest compatible stable version from registry versions", () => {
  assert.equal(
    selectHighestCompatibleVersion(["2.0.0", "2.1.0", "2.3.0", "3.0.0"], "^2.0.0"),
    "2.3.0",
  );
});

test("selects the highest compatible prerelease with numeric SemVer ordering", () => {
  assert.equal(
    selectHighestCompatibleVersion(["2.0.0-dev.2", "2.0.0-dev.10", "2.0.0"], ">=2.0.0-dev.1 <2.0.0"),
    "2.0.0-dev.10",
  );
});

test("rejects option-like and non-semver registry specs", () => {
  assert.throws(() => selectHighestCompatibleVersion(["1.0.0"], "--registry=https://evil"), /Invalid npm version range/);
  assert.throws(() => selectHighestCompatibleVersion(["1.0.0"], "file:../../evil"), /Invalid npm version range/);
});
