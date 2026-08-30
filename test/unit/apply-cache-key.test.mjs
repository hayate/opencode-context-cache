import { test } from "node:test";
import assert from "node:assert/strict";

import plugin from "../../plugins/opencode-context-cache.mjs";

const { applyCacheKey, stripSesPrefix } = plugin.internals;

const SESSION = "ses_" + "a".repeat(64);
const STRIPPED = "a".repeat(64);
const KEY = "stable-key";

test("strips the ses_ prefix only from a full lowercase 64-hex session id", () => {
  assert.equal(stripSesPrefix(SESSION), STRIPPED);
  assert.equal(stripSesPrefix("ses_short"), "ses_short");
  assert.equal(stripSesPrefix("ses_" + "A".repeat(64)), "ses_" + "A".repeat(64));
  assert.equal(stripSesPrefix("plain"), "plain");
});

test("replaces promptCacheKey when it holds core's session id", () => {
  const output = { options: { promptCacheKey: SESSION, store: false } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r, { appliedFields: ["promptCacheKey"], foreignFields: [], reason: null });
  assert.equal(output.options.promptCacheKey, KEY);
  assert.equal(output.options.store, false);
});

test("replaces prompt_cache_key for deepinfra and cerebras style providers", () => {
  const output = { options: { prompt_cache_key: SESSION } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r.appliedFields, ["prompt_cache_key"]);
  assert.equal(output.options.prompt_cache_key, KEY);
});

test("replaces a value equal to the ses_-stripped session id", () => {
  const output = { options: { promptCacheKey: STRIPPED } };
  assert.deepEqual(applyCacheKey(output, KEY, SESSION).appliedFields, ["promptCacheKey"]);
  assert.equal(output.options.promptCacheKey, KEY);
});

test("replaces both fields when both hold core's default", () => {
  const output = { options: { promptCacheKey: SESSION, prompt_cache_key: SESSION } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r.appliedFields, ["promptCacheKey", "prompt_cache_key"]);
  assert.equal(output.options.promptCacheKey, KEY);
  assert.equal(output.options.prompt_cache_key, KEY);
});

test("leaves a value this plugin did not set and reports it", () => {
  const output = { options: { promptCacheKey: "someone-elses-key" } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r, { appliedFields: [], foreignFields: ["promptCacheKey"], reason: null });
  assert.equal(output.options.promptCacheKey, "someone-elses-key");
});

test("reports a foreign snake_case sibling alongside an applied camelCase field", () => {
  const output = { options: { promptCacheKey: SESSION, prompt_cache_key: "theirs" } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r.appliedFields, ["promptCacheKey"]);
  assert.deepEqual(r.foreignFields, ["prompt_cache_key"], "a mixed conflict must not be hidden");
  assert.equal(output.options.promptCacheKey, KEY);
  assert.equal(output.options.prompt_cache_key, "theirs");
});

test("treats a present-but-undefined field as foreign, not as core's", () => {
  const output = { options: { promptCacheKey: undefined } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r.foreignFields, ["promptCacheKey"]);
  assert.equal(output.options.promptCacheKey, undefined);
});

test("reports no-fields distinctly when core placed nothing", () => {
  const output = { options: { store: false } };
  const r = applyCacheKey(output, KEY, SESSION);
  assert.deepEqual(r, { appliedFields: [], foreignFields: [], reason: "no-fields" });
  assert.deepEqual(output.options, { store: false });
});

test("reports invalid-options distinctly, and never throws", () => {
  assert.equal(applyCacheKey({}, KEY, SESSION).reason, "invalid-options");
  assert.equal(applyCacheKey(undefined, KEY, SESSION).reason, "invalid-options");
  assert.equal(applyCacheKey({ options: null }, KEY, SESSION).reason, "invalid-options");
  assert.equal(applyCacheKey({ options: "nope" }, KEY, SESSION).reason, "invalid-options");
});

test("reports missing-session distinctly and changes nothing", () => {
  const output = { options: { promptCacheKey: SESSION } };
  const r = applyCacheKey(output, KEY, undefined);
  assert.equal(r.reason, "missing-session");
  assert.deepEqual(r.appliedFields, []);
  assert.equal(output.options.promptCacheKey, SESSION, "provenance is unprovable, so nothing may change");
});

test("replaces options rather than mutating the object it was handed", () => {
  const original = { promptCacheKey: SESSION };
  const output = { options: original };
  applyCacheKey(output, KEY, SESSION);
  assert.notEqual(output.options, original, "output.options should be a new object");
  assert.equal(original.promptCacheKey, SESSION, "the original object must be untouched");
});
