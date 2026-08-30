import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import plugin from "../../plugins/opencode-context-cache.mjs";

// Helpers are not exported: opencode's loader would invoke each one as a
// plugin factory. See the note beside `internals` in the plugin file.
const {
  MAX_CACHE_KEY_LENGTH,
  PROMPT_CACHE_KEY_ENV_VAR,
  SCOPE_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  getUsername,
  isSafeOverride,
  parseScope,
  resolveCacheKey,
  safeHostname,
  selectScopePath,
  sha256,
  identityWarning,
  scopeSetting,
} = plugin.internals;

const BASE = { user: "andrea", host: "moonveil", worktree: "/srv/repo", directory: "/srv/repo/pkg/a", env: {} };
const digest = (v) => createHash("sha256").update(v, "utf8").digest("hex");

test("sha256 matches node crypto", () => {
  assert.equal(sha256("abc"), digest("abc"));
});

test("isSafeOverride bounds length and character set", () => {
  assert.equal(isSafeOverride("team-key"), true);
  assert.equal(isSafeOverride("a".repeat(MAX_CACHE_KEY_LENGTH)), true);
  assert.equal(isSafeOverride("a".repeat(MAX_CACHE_KEY_LENGTH + 1)), false);
  assert.equal(isSafeOverride("bad\nkey"), false);
  assert.equal(isSafeOverride("café"), false);
});

test("parseScope accepts the enum and flags anything else", () => {
  assert.deepEqual(parseScope("worktree"), { scope: "worktree", unknown: null });
  assert.deepEqual(parseScope("DIRECTORY"), { scope: "directory", unknown: null });
  assert.deepEqual(parseScope(" session "), { scope: "session", unknown: null });
  assert.deepEqual(parseScope(""), { scope: "worktree", unknown: null });
  assert.deepEqual(parseScope(undefined), { scope: "worktree", unknown: null });
  assert.deepEqual(parseScope("sessions"), { scope: "worktree", unknown: "sessions" });
});

test("selectScopePath prefers worktree and guards a degenerate root", () => {
  assert.equal(selectScopePath({ scope: "worktree", worktree: "/srv/repo", directory: "/srv/repo/x" }), "/srv/repo");
  assert.equal(selectScopePath({ scope: "worktree", worktree: "", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "worktree", worktree: "   ", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "worktree", worktree: "/", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "directory", worktree: "/srv/repo", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "session", worktree: "/srv/repo", directory: "/srv/repo/x" }), "");
});

test("a path is used verbatim and never trimmed", () => {
  const r = resolveCacheKey({ ...BASE, worktree: "/srv/odd " });
  assert.equal(r.raw, "andrea@moonveil:/srv/odd ");
});

test("explicit override wins and is used verbatim when safe", () => {
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: "  team-key  " } });
  assert.equal(r.value, "team-key");
  assert.equal(r.hashed, false);
  assert.equal(r.sensitive, true);
  assert.equal(r.source, PROMPT_CACHE_KEY_ENV_VAR);
  assert.equal(r.deprecated, false);
});

test("prompt cache key env beats the deprecated sticky session env", () => {
  const r = resolveCacheKey({
    ...BASE,
    env: { [PROMPT_CACHE_KEY_ENV_VAR]: "first", [STICKY_SESSION_ID_ENV_VAR]: "second" },
  });
  assert.equal(r.value, "first");
});

test("the sticky session env still works and is flagged deprecated", () => {
  const r = resolveCacheKey({ ...BASE, env: { [STICKY_SESSION_ID_ENV_VAR]: "legacy" } });
  assert.equal(r.value, "legacy");
  assert.equal(r.deprecated, true);
});

test("an overlong override is hashed rather than sent as-is", () => {
  const long = "x".repeat(MAX_CACHE_KEY_LENGTH + 1);
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: long } });
  assert.equal(r.value, digest(long));
  assert.equal(r.hashed, true);
  assert.equal(r.value.length, MAX_CACHE_KEY_LENGTH);
});

test("a non-printable override is hashed rather than sent as-is", () => {
  const bad = "key\nwith\tcontrol";
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: bad } });
  assert.equal(r.value, digest(bad));
  assert.equal(r.hashed, true);
});

test("whitespace-only env values are ignored", () => {
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: "   " } });
  assert.equal(r.source, "user@host:worktree");
});

test("generated key is the sha256 of user@host:worktree", () => {
  const r = resolveCacheKey(BASE);
  assert.equal(r.raw, "andrea@moonveil:/srv/repo");
  assert.equal(r.value, digest("andrea@moonveil:/srv/repo"));
  assert.equal(r.hashed, true);
  assert.equal(r.sensitive, false);
});

test("scope can be narrowed to the directory", () => {
  const r = resolveCacheKey({ ...BASE, env: { [SCOPE_ENV_VAR]: "directory" } });
  assert.equal(r.raw, "andrea@moonveil:/srv/repo/pkg/a");
  assert.equal(r.source, "user@host:directory");
});

test("scope session is a hard opt-out that beats an explicit override", () => {
  assert.equal(resolveCacheKey({ ...BASE, env: { [SCOPE_ENV_VAR]: "session" } }), null);
  assert.equal(
    resolveCacheKey({
      ...BASE,
      env: { [SCOPE_ENV_VAR]: "session", [PROMPT_CACHE_KEY_ENV_VAR]: "stale-key" },
    }),
    null,
    "a forgotten override must not defeat the safety valve",
  );
});

test("an unrecognised scope falls back to worktree and reports itself", () => {
  const r = resolveCacheKey({ ...BASE, env: { [SCOPE_ENV_VAR]: "sessions" } });
  assert.equal(r.unknownScope, "sessions");
  assert.equal(r.source, "user@host:worktree");
});

test("plugin options supply defaults that env overrides", () => {
  assert.equal(resolveCacheKey({ ...BASE, options: { scope: "directory" } }).source, "user@host:directory");
  assert.equal(resolveCacheKey({ ...BASE, options: { cacheKey: "from-config" } }).value, "from-config");
  assert.equal(
    resolveCacheKey({ ...BASE, options: { cacheKey: "from-config" }, env: { [PROMPT_CACHE_KEY_ENV_VAR]: "from-env" } }).value,
    "from-env",
  );
});

test("no usable path yields null", () => {
  assert.equal(resolveCacheKey({ ...BASE, worktree: "", directory: "" }), null);
});

test("key is deterministic and varies with user, host and path", () => {
  const a = resolveCacheKey(BASE);
  assert.equal(a.value, resolveCacheKey(BASE).value);
  assert.notEqual(a.value, resolveCacheKey({ ...BASE, user: "other" }).value);
  assert.notEqual(a.value, resolveCacheKey({ ...BASE, host: "other" }).value);
  assert.notEqual(a.value, resolveCacheKey({ ...BASE, worktree: "/srv/other" }).value);
});

test("getUsername falls back through env when userInfo throws", () => {
  const boom = () => { throw new Error("no passwd entry"); };
  assert.equal(getUsername({ env: { USER: "envuser" }, readUserInfo: boom }), "envuser");
  assert.equal(getUsername({ env: { LOGNAME: "logname" }, readUserInfo: boom }), "logname");
  assert.equal(getUsername({ env: {}, readUserInfo: boom }), "unknown");
  assert.equal(getUsername({ env: {}, readUserInfo: () => ({ username: "real" }) }), "real");
});

test("safeHostname falls back when hostname throws or is empty", () => {
  assert.equal(safeHostname({ readHostname: () => { throw new Error("nope"); } }), "unknown-host");
  assert.equal(safeHostname({ readHostname: () => "" }), "unknown-host");
  assert.equal(safeHostname({ readHostname: () => "box" }), "box");
});

test("identityWarning fires only when a generated key rests on placeholder identity", () => {
  assert.equal(identityWarning({ user: "andrea", host: "moonveil", sensitive: false }), null);
  assert.equal(
    identityWarning({ user: "unknown", host: "unknown-host", sensitive: true }),
    null,
    "an explicit override does not depend on local identity",
  );

  const noUser = identityWarning({ user: "unknown", host: "moonveil", sensitive: false });
  assert.match(noUser, /could not determine the local username,/);
  assert.match(noUser, /unknown@moonveil:<path>/);
  assert.match(noUser, new RegExp(PROMPT_CACHE_KEY_ENV_VAR));

  assert.match(
    identityWarning({ user: "andrea", host: "unknown-host", sensitive: false }),
    /could not determine the local hostname,/,
  );
  assert.match(
    identityWarning({ user: "unknown", host: "unknown-host", sensitive: false }),
    /could not determine the local username or hostname,/,
  );
});

test("a placeholder identity is reachable from the real fallback paths", () => {
  // Ties identityWarning to the functions that actually produce the sentinels,
  // so renaming a sentinel in one place breaks this test rather than silently
  // disabling the warning.
  const boom = () => { throw new Error("no passwd entry"); };
  const user = getUsername({ env: {}, readUserInfo: boom });
  const host = safeHostname({ readHostname: boom });
  assert.notEqual(identityWarning({ user, host, sensitive: false }), null);
});

test("scopeSetting is the single source of truth for where scope comes from", () => {
  assert.equal(scopeSetting({ [SCOPE_ENV_VAR]: "directory" }, { scope: "session" }), "directory");
  assert.equal(scopeSetting({}, { scope: "session" }), "session");
  assert.equal(scopeSetting({}, {}), "");
  assert.equal(scopeSetting({}, { scope: 42 }), "", "a non-string option is ignored, not coerced");
  assert.equal(scopeSetting(undefined, undefined), "");
});

test("the printable-ASCII bound excludes DEL and everything above it", () => {
  assert.equal(isSafeOverride("\x7e"), true, "tilde is the last printable character");
  assert.equal(isSafeOverride("\x7f"), false, "DEL is not printable");
  assert.equal(isSafeOverride("\x1f"), false);
  assert.equal(isSafeOverride("\x20"), true, "space is printable");
});
