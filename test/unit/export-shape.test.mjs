/**
 * Reproduces opencode's plugin loader check.
 *
 * A file-path plugin is loaded by walking `Object.values(module)`. Every value
 * must be a function, or an object carrying a `server` function; anything else
 * makes opencode refuse the whole plugin with "Plugin export is not a
 * function". Every distinct function that survives is then *invoked* as a
 * plugin factory with `(PluginInput, options)`.
 *
 * This was found by running the plugin under a real opencode, not by any unit
 * test: exporting the helpers for testability silently made the plugin
 * unloadable while 57 tests stayed green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as pluginModule from "../../plugins/opencode-context-cache.mjs";

/** opencode's `Gy`: normalise one export to a plugin factory, or nothing. */
function toPluginFactory(value) {
  if (typeof value === "function") return value;
  if (!value || typeof value !== "object" || !("server" in value)) return undefined;
  if (typeof value.server !== "function") return undefined;
  return value.server;
}

/** opencode's `Wy`: every export must normalise, deduplicated by identity. */
function collectPlugins(mod) {
  const seen = new Set();
  const plugins = [];
  for (const value of Object.values(mod)) {
    if (seen.has(value)) continue;
    seen.add(value);
    const factory = toPluginFactory(value);
    if (!factory) throw new TypeError("Plugin export is not a function");
    plugins.push(factory);
  }
  return plugins;
}

test("every export satisfies opencode's plugin loader", () => {
  assert.doesNotThrow(
    () => collectPlugins(pluginModule),
    "a non-function export makes opencode refuse the entire plugin",
  );
});

test("the module registers exactly one plugin", () => {
  const plugins = collectPlugins(pluginModule);
  assert.equal(
    plugins.length,
    1,
    "every distinct exported function is invoked as a plugin factory, so helpers " +
      "must not be exported - hang them off the factory as `internals` instead",
  );
});

test("the aliases are the same function object, so the loader deduplicates them", () => {
  assert.equal(pluginModule.EnhancedCachePlugin, pluginModule.OpenCodeContextCachePlugin);
  assert.equal(pluginModule.default, pluginModule.OpenCodeContextCachePlugin);
});

test("the single registered plugin is the factory, and it returns hooks", async () => {
  const [factory] = collectPlugins(pluginModule);
  assert.equal(factory, pluginModule.default);
  const hooks = await factory({ directory: "/srv/repo", worktree: "/srv/repo" }, {});
  assert.equal(typeof hooks, "object");
  assert.equal(typeof hooks["chat.params"], "function");
});

test("internals are reachable for tests without being exported", () => {
  const { internals } = pluginModule.default;
  assert.equal(typeof internals, "object");
  assert.equal(Object.isFrozen(internals), true);
  for (const name of ["resolveCacheKey", "applyCacheKey", "createLogger", "sha256"]) {
    assert.equal(typeof internals[name], "function", `internals.${name} should be available to tests`);
  }
  assert.equal(Object.keys(pluginModule).includes("resolveCacheKey"), false, "helpers must not be exported");
});
