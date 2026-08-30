/**
 * Compatibility gate: the facts about opencode this plugin's design rests on.
 *
 * The design was verified against a compiled binary, not a published contract
 * (the installed plugin types were 1.18.21 while the binary was 1.18.25), so
 * these assertions exist to fail loudly on the opencode upgrade that changes
 * something underneath us rather than letting the plugin go quietly inert.
 *
 * This half checks the binary's own text. The sibling suite boots a real server
 * and checks PluginInput. Neither drives a live model request - that needs
 * provider credentials - so the wire-level behavior is covered by the unit
 * suite instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BIN =
  [process.env.OPENCODE_BIN, join(process.env.HOME ?? "", ".opencode", "bin", "opencode")]
    .filter(Boolean)
    .find((p) => existsSync(p)) ?? null;
const skip = BIN ? false : "no opencode binary found; set OPENCODE_BIN to run this suite";

let cached = null;
function binaryText() {
  if (cached === null) {
    cached = execFileSync("strings", ["-n", "8", BIN], { maxBuffer: 512 * 1024 * 1024 }).toString();
  }
  return cached;
}

/**
 * Each entry is a fact the plugin depends on, the shape it must still have, and
 * what breaks if it is gone. Keep the failure messages actionable: whoever hits
 * one is mid-upgrade and needs to know what to re-check.
 */
const CONTRACT = [
  {
    what: "chat.params is triggered with a pre-populated options object",
    pattern: /trigger\("chat\.params",\{sessionID:[^}]*\},\{[^}]*options:/,
    breaks:
      "The plugin only ever replaces a value core already placed. If options is no longer " +
      "seeded before the hook runs, applyCacheKey will report no-fields forever.",
  },
  {
    what: "the hook input still carries sessionID",
    pattern: /trigger\("chat\.params",\{sessionID:/,
    breaks:
      "Provenance is proved by matching the existing key against sessionID. Without it the " +
      "plugin can never confirm a key is core's and will stop replacing anything.",
  },
  {
    what: "core seeds the camelCase promptCacheKey from the session id",
    pattern: /promptCacheKey=\$\.sessionID/,
    breaks: "The value the plugin matches on has changed; provenance detection will fail.",
  },
  {
    what: "core seeds the snake_case prompt_cache_key for some providers",
    pattern: /prompt_cache_key=\$\.sessionID/,
    breaks: "The deepinfra/cerebras spelling changed; those providers will stop being handled.",
  },
  {
    what: "setCacheKey remains the provider opt-in core consults",
    pattern: /setCacheKey/,
    breaks: "The plugin inherits core's opt-in decision; if this is gone, that inheritance is broken.",
  },
  {
    what: "a plugin export that is not a function is still rejected",
    pattern: /Plugin export is not a function/,
    breaks:
      "The single-export constraint may have relaxed or changed shape. Re-check " +
      "test/unit/export-shape.test.mjs against the loader before relying on it.",
  },
  {
    what: "core still sends its own session identity headers",
    pattern: /"x-session-affinity":/,
    breaks:
      "The 0.2.0 breaking change told users to rely on core's headers instead of the ones this " +
      "plugin used to write. If core stopped sending them, that migration advice is now wrong.",
  },
];

for (const { what, pattern, breaks } of CONTRACT) {
  test(`opencode contract: ${what}`, { skip }, () => {
    assert.match(binaryText(), pattern, `\n\nWhat this breaks: ${breaks}\n`);
  });
}

test("the plugin's own cache key field names match the ones core writes", { skip }, async () => {
  const { internals } = (await import("../../plugins/opencode-context-cache.mjs")).default;
  const text = binaryText();
  for (const field of internals.CACHE_KEY_FIELDS) {
    const spelling = field === "prompt_cache_key" ? /prompt_cache_key=/ : /promptCacheKey=/;
    assert.match(text, spelling, `opencode no longer writes ${field}; the plugin would never match it`);
  }
});
