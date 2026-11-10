import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPluginsExist,
  discoverPluginNames,
  resolvePlugins,
} from "../dist/plugin-resolution.js";

const aliases = {
  "lint-html-plugin": "linthtml-plugin",
  "markdown-lint-plugin": "markdownlint-plugin",
  "node-types-plugin": "node-builtin-plugin",
  "nuxtjs-plugin": "nuxt-plugin",
  "svelte-kit-plugin": "sveltekit-plugin",
  "temporal-io-plugin": "temporal-plugin",
  "webdriver-io-plugin": "webdriverio-plugin",
};

test("resolves filename stems and declared names to the Core plugin name", () => {
  assert.deepEqual(resolvePlugins(["nuxtjs"], ["nuxtjs-plugin"]), [
    { requested: "nuxtjs", canonical: "nuxt-plugin" },
  ]);
  assert.deepEqual(resolvePlugins(["nuxt-plugin"], ["nuxtjs-plugin"]), [
    { requested: "nuxt-plugin", canonical: "nuxt-plugin" },
  ]);
});

test("resolves all seven known filename/name mismatches", () => {
  for (const [stem, canonical] of Object.entries(aliases)) {
    assert.deepEqual(resolvePlugins([stem], [stem]), [{ requested: stem, canonical }]);
    assert.deepEqual(resolvePlugins([canonical], [stem]), [{ requested: canonical, canonical }]);
  }
});

test("assertPluginsExist returns canonical names", () => {
  assert.deepEqual(assertPluginsExist(["nuxtjs", "nuxt-plugin"], ["nuxtjs-plugin"]), [
    "nuxt-plugin",
    "nuxt-plugin",
  ]);
  assert.deepEqual(assertPluginsExist(["linthtml-plugin"], ["lint-html-plugin"]), [
    "linthtml-plugin",
  ]);
});

test("every discovered bundled plugin resolves to a canonical name", () => {
  for (const name of discoverPluginNames()) {
    const [resolution] = resolvePlugins([name]);
    assert.ok(resolution.canonical, `failed to resolve ${name}`);
  }
});
