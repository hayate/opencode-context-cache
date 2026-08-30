# OpenCode Context Cache Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plugin's session-header writing and `process.cwd()`-derived cache key with a single, provenance-checked prompt cache key scoped to the git worktree.

**Architecture:** One self-contained ESM file exporting pure helpers plus a plugin factory. `resolveCacheKey` computes the key once per factory invocation from `PluginInput`; `applyCacheKey` replaces a cache-key field in `output.options` only when its current value is provably opencode's own session-ID default. No conversation headers are written. No module-level mutable state.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, `node:crypto`, zero runtime and zero dev dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-cache-key-and-headers-design.md`

## Global Constraints

- Single shipped file: `plugins/opencode-context-cache.mjs`. Do not split into `src/`; upstream's install path is copying that one file.
- Zero dependencies, runtime and dev. Tests run on `node --test` with no install step.
- Node `>=20`.
- The plugin must never throw out of the `chat.params` hook.
- Never write `x-session-id`, `conversation_id`, `session_id`, `X-Session-Id`, or `x-session-affinity`. Never touch `input.model.headers`.
- Never log the raw value of an operator-supplied override; log its source and an 8-character fingerprint only.
- `MAX_CACHE_KEY_LENGTH = 64`. Printable ASCII is `/^[\x20-\x7E]+$/`.
- Keep the `EnhancedCachePlugin` named export and the default export as aliases.
- Env var names, exact: `OPENCODE_PROMPT_CACHE_KEY`, `OPENCODE_STICKY_SESSION_ID`, `OPENCODE_CONTEXT_CACHE_SCOPE`, `OPENCODE_CONTEXT_CACHE_DEBUG`, `OPENCODE_CONTEXT_CACHE_LOG`.
- Commit messages: no `Co-Authored-By` agent attribution. Use a plain dash, never an em dash, in all prose and code comments.

## File Structure

| File | Responsibility |
|---|---|
| `plugins/opencode-context-cache.mjs` | Everything shipped: pure helpers + factory. Rewritten. |
| `package.json` | npm-installable identity, `test` scripts. New. |
| `.gitignore` | log file, `node_modules`. New. |
| `test/cache-key.test.mjs` | `resolveCacheKey`, `selectScopePath`, override bounds. |
| `test/apply-cache-key.test.mjs` | `applyCacheKey` provenance and immutability. |
| `test/logger.test.mjs` | log path, write failure, `warnOnce` dedup. |
| `test/plugin-hook.test.mjs` | the real factory and the hook it returns. |
| `test/integration/lifecycle.test.mjs` | opt-in, runs a real `opencode serve`. |
| `test/integration/probe-plugin.mjs` | fixture plugin that records its `PluginInput`. |
| `.github/workflows/test.yml` | CI: `npm test` on Node 20 and 22. |
| `README.md` | Rewritten, honest claims, breaking-change notice. |

---

### Task 1: Scaffolding and cache key resolution

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `plugins/opencode-context-cache.mjs` (replacing the existing file wholesale)
- Test: `test/cache-key.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `sha256(value) -> string`, `isSafeOverride(value) -> boolean`, `selectScopePath({scope, worktree, directory}) -> string`, `resolveCacheKey({env, worktree, directory, user, host}) -> {raw, value, source, hashed, sensitive} | null`, and the constants `PROMPT_CACHE_KEY_ENV_VAR`, `STICKY_SESSION_ID_ENV_VAR`, `SCOPE_ENV_VAR`, `DEBUG_ENV_VAR`, `LOG_PATH_ENV_VAR`, `MAX_CACHE_KEY_LENGTH`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "opencode-context-cache",
  "version": "0.2.0",
  "description": "Stable prompt cache key for opencode sessions, scoped to the git worktree",
  "type": "module",
  "main": "plugins/opencode-context-cache.mjs",
  "exports": {
    ".": "./plugins/opencode-context-cache.mjs"
  },
  "files": [
    "plugins/",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "test:integration": "node --test test/integration/*.test.mjs"
  },
  "keywords": ["opencode", "opencode-plugin", "prompt-cache"],
  "license": "MIT",
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
context-cache.log
*.log
```

- [ ] **Step 3: Write the failing test**

Create `test/cache-key.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MAX_CACHE_KEY_LENGTH,
  PROMPT_CACHE_KEY_ENV_VAR,
  SCOPE_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  isSafeOverride,
  resolveCacheKey,
  selectScopePath,
  sha256,
} from "../plugins/opencode-context-cache.mjs";

const BASE = { user: "andrea", host: "moonveil", worktree: "/srv/repo", directory: "/srv/repo/pkg/a" };
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

test("selectScopePath prefers worktree, guards against a degenerate root", () => {
  assert.equal(selectScopePath({ scope: "worktree", worktree: "/srv/repo", directory: "/srv/repo/x" }), "/srv/repo");
  assert.equal(selectScopePath({ scope: "worktree", worktree: "", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "worktree", worktree: "/", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "directory", worktree: "/srv/repo", directory: "/srv/repo/x" }), "/srv/repo/x");
  assert.equal(selectScopePath({ scope: "session", worktree: "/srv/repo", directory: "/srv/repo/x" }), "");
});

test("explicit override wins and is used verbatim when safe", () => {
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: "  team-key  " } });
  assert.equal(r.value, "team-key");
  assert.equal(r.raw, "team-key");
  assert.equal(r.hashed, false);
  assert.equal(r.sensitive, true);
  assert.equal(r.source, PROMPT_CACHE_KEY_ENV_VAR);
});

test("prompt cache key env beats the deprecated sticky session env", () => {
  const r = resolveCacheKey({
    ...BASE,
    env: { [PROMPT_CACHE_KEY_ENV_VAR]: "first", [STICKY_SESSION_ID_ENV_VAR]: "second" },
  });
  assert.equal(r.value, "first");
});

test("deprecated sticky session env is still honoured", () => {
  const r = resolveCacheKey({ ...BASE, env: { [STICKY_SESSION_ID_ENV_VAR]: "legacy" } });
  assert.equal(r.value, "legacy");
  assert.equal(r.source, STICKY_SESSION_ID_ENV_VAR);
});

test("an unsafe override is hashed rather than sent as-is", () => {
  const long = "x".repeat(MAX_CACHE_KEY_LENGTH + 1);
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: long } });
  assert.equal(r.value, digest(long));
  assert.equal(r.hashed, true);
  assert.equal(r.value.length, 64);
});

test("whitespace-only env values are ignored", () => {
  const r = resolveCacheKey({ ...BASE, env: { [PROMPT_CACHE_KEY_ENV_VAR]: "   " } });
  assert.equal(r.source, "user@host:worktree");
});

test("generated key is the sha256 of user@host:worktree", () => {
  const r = resolveCacheKey({ ...BASE, env: {} });
  assert.equal(r.raw, "andrea@moonveil:/srv/repo");
  assert.equal(r.value, digest("andrea@moonveil:/srv/repo"));
  assert.equal(r.hashed, true);
  assert.equal(r.sensitive, false);
});

test("scope env can narrow to the directory", () => {
  const r = resolveCacheKey({ ...BASE, env: { [SCOPE_ENV_VAR]: "directory" } });
  assert.equal(r.raw, "andrea@moonveil:/srv/repo/pkg/a");
  assert.equal(r.source, "user@host:directory");
});

test("scope session yields no key so core's default stands", () => {
  assert.equal(resolveCacheKey({ ...BASE, env: { [SCOPE_ENV_VAR]: "session" } }), null);
});

test("an explicit override still wins over scope session", () => {
  const r = resolveCacheKey({
    ...BASE,
    env: { [SCOPE_ENV_VAR]: "session", [PROMPT_CACHE_KEY_ENV_VAR]: "team-key" },
  });
  assert.equal(r.value, "team-key");
});

test("no usable path yields null", () => {
  assert.equal(resolveCacheKey({ user: "a", host: "b", worktree: "", directory: "", env: {} }), null);
});

test("key is deterministic and varies with user, host and path", () => {
  const a = resolveCacheKey({ ...BASE, env: {} });
  assert.equal(a.value, resolveCacheKey({ ...BASE, env: {} }).value);
  assert.notEqual(a.value, resolveCacheKey({ ...BASE, user: "other", env: {} }).value);
  assert.notEqual(a.value, resolveCacheKey({ ...BASE, host: "other", env: {} }).value);
  assert.notEqual(a.value, resolveCacheKey({ ...BASE, worktree: "/srv/other", env: {} }).value);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. The existing `plugins/opencode-context-cache.mjs` exports none of these names, so the import throws `SyntaxError: The requested module ... does not provide an export named 'resolveCacheKey'`.

- [ ] **Step 5: Replace `plugins/opencode-context-cache.mjs` with the resolution layer**

Delete the entire existing contents. The `DebugLogger`, `CacheKeyResolver`, `CacheKeyApplier` and `ContextCachePluginRuntime` classes and the module-level singletons all go. Write:

```js
/**
 * opencode plugin: OpenCode Context Cache
 *
 * Gives opencode a prompt cache key that is stable across sessions in the same
 * git worktree, instead of core's default of a fresh session ID per session.
 *
 * It sets exactly one thing: the prompt cache key field that opencode core has
 * already placed in `output.options`, and only when that field still holds
 * core's own session-ID default. It writes no headers.
 */

import { hostname, homedir, userInfo } from "os";
import { dirname, join } from "path";
import { appendFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";

export const PROMPT_CACHE_KEY_ENV_VAR = "OPENCODE_PROMPT_CACHE_KEY";
export const STICKY_SESSION_ID_ENV_VAR = "OPENCODE_STICKY_SESSION_ID";
export const SCOPE_ENV_VAR = "OPENCODE_CONTEXT_CACHE_SCOPE";
export const DEBUG_ENV_VAR = "OPENCODE_CONTEXT_CACHE_DEBUG";
export const LOG_PATH_ENV_VAR = "OPENCODE_CONTEXT_CACHE_LOG";

/** OpenAI is reported to cap prompt_cache_key at 64 characters; a sha256 hex digest is exactly 64. */
export const MAX_CACHE_KEY_LENGTH = 64;

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function trimmedEnv(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

export function isSafeOverride(value) {
  return value.length <= MAX_CACHE_KEY_LENGTH && PRINTABLE_ASCII.test(value);
}

/**
 * Mirrors core's own project-path guard:
 *   vcs === "git" && worktree !== "/" ? worktree : directory
 * A degenerate "/" worktree would otherwise collapse every project on the
 * machine onto a single key.
 */
export function selectScopePath({ scope, worktree, directory }) {
  const tree = typeof worktree === "string" ? worktree.trim() : "";
  const dir = typeof directory === "string" ? directory.trim() : "";
  if (scope === "session") return "";
  if (scope === "directory") return dir;
  if (tree && tree !== "/") return tree;
  return dir;
}

export function resolveCacheKey({ env = {}, worktree, directory, user, host } = {}) {
  for (const name of [PROMPT_CACHE_KEY_ENV_VAR, STICKY_SESSION_ID_ENV_VAR]) {
    const raw = trimmedEnv(env, name);
    if (!raw) continue;
    const safe = isSafeOverride(raw);
    return { raw, value: safe ? raw : sha256(raw), source: name, hashed: !safe, sensitive: true };
  }

  const scope = trimmedEnv(env, SCOPE_ENV_VAR).toLowerCase() || "worktree";
  const path = selectScopePath({ scope, worktree, directory });
  if (!path) return null;

  const raw = `${user}@${host}:${path}`;
  return { raw, value: sha256(raw), source: `user@host:${scope}`, hashed: true, sensitive: false };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 14 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore plugins/opencode-context-cache.mjs test/cache-key.test.mjs
git commit -m "feat: resolve a worktree-scoped prompt cache key

Replaces the process.cwd() key with one derived from PluginInput, bounds
explicit overrides to what a provider will accept, and adds a scope knob."
```

---

### Task 2: Provenance-checked application

**Files:**
- Modify: `plugins/opencode-context-cache.mjs` (append)
- Test: `test/apply-cache-key.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; shares the file.
- Produces: `CACHE_KEY_FIELDS: string[]`, `stripSesPrefix(sessionID) -> string`, `applyCacheKey(output, value, sessionID) -> "applied" | "absent" | "foreign"`.

- [ ] **Step 1: Write the failing test**

Create `test/apply-cache-key.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCacheKey, stripSesPrefix } from "../plugins/opencode-context-cache.mjs";

const SESSION = "ses_" + "a".repeat(64);
const KEY = "stable-key";

test("strips the ses_ prefix only from a full 64-hex session id", () => {
  assert.equal(stripSesPrefix(SESSION), "a".repeat(64));
  assert.equal(stripSesPrefix("ses_short"), "ses_short");
  assert.equal(stripSesPrefix("plain"), "plain");
});

test("replaces promptCacheKey when it holds core's session id", () => {
  const output = { options: { promptCacheKey: SESSION, store: false } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "applied");
  assert.equal(output.options.promptCacheKey, KEY);
  assert.equal(output.options.store, false);
});

test("replaces prompt_cache_key for deepinfra and cerebras style providers", () => {
  const output = { options: { prompt_cache_key: SESSION } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "applied");
  assert.equal(output.options.prompt_cache_key, KEY);
});

test("replaces a value equal to the ses_-stripped session id", () => {
  const output = { options: { promptCacheKey: "a".repeat(64) } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "applied");
  assert.equal(output.options.promptCacheKey, KEY);
});

test("leaves a value this plugin did not set", () => {
  const output = { options: { promptCacheKey: "someone-elses-key" } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "foreign");
  assert.equal(output.options.promptCacheKey, "someone-elses-key");
});

test("treats a present-but-undefined field as foreign, not as core's", () => {
  const output = { options: { promptCacheKey: undefined } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "foreign");
  assert.equal(output.options.promptCacheKey, undefined);
});

test("adds nothing when no cache key field is present", () => {
  const output = { options: { store: false } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "absent");
  assert.deepEqual(output.options, { store: false });
});

test("does not throw and reports absent when options are missing", () => {
  assert.equal(applyCacheKey({}, KEY, SESSION), "absent");
  assert.equal(applyCacheKey(undefined, KEY, SESSION), "absent");
  assert.equal(applyCacheKey({ options: null }, KEY, SESSION), "absent");
});

test("cannot prove provenance without a session id", () => {
  const output = { options: { promptCacheKey: SESSION } };
  assert.equal(applyCacheKey(output, KEY, undefined), "absent");
  assert.equal(output.options.promptCacheKey, SESSION);
});

test("replaces the core-owned field and leaves a foreign sibling alone", () => {
  const output = { options: { promptCacheKey: SESSION, prompt_cache_key: "theirs" } };
  assert.equal(applyCacheKey(output, KEY, SESSION), "applied");
  assert.equal(output.options.promptCacheKey, KEY);
  assert.equal(output.options.prompt_cache_key, "theirs");
});

test("replaces options rather than mutating the object it was handed", () => {
  const original = { promptCacheKey: SESSION };
  const output = { options: original };
  applyCacheKey(output, KEY, SESSION);
  assert.notEqual(output.options, original, "output.options should be a new object");
  assert.equal(original.promptCacheKey, SESSION, "the original object must be untouched");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'applyCacheKey'`.

- [ ] **Step 3: Append the application layer to the plugin file**

```js
/** The two spellings opencode core uses, depending on provider. */
export const CACHE_KEY_FIELDS = ["promptCacheKey", "prompt_cache_key"];

const SES_PREFIXED = /^ses_[0-9a-f]{64}$/;

/** Core sends the digest without the ses_ prefix on its own zen provider path. */
export function stripSesPrefix(sessionID) {
  return SES_PREFIXED.test(sessionID) ? sessionID.slice(4) : sessionID;
}

/**
 * Replace a cache key field only when it still holds core's session-ID default.
 * Field presence alone does not prove core set the value: model, agent and
 * variant options can carry the field, and a plugin ordered before this one can
 * add it. Matching the session ID is exact provenance, and it inherits core's
 * whole provider table without duplicating it.
 */
export function applyCacheKey(output, value, sessionID) {
  const options = output?.options;
  if (!options || typeof options !== "object") return "absent";
  if (typeof sessionID !== "string" || sessionID === "") return "absent";

  const stripped = stripSesPrefix(sessionID);
  const replacements = {};
  let sawForeign = false;

  for (const field of CACHE_KEY_FIELDS) {
    if (!(field in options)) continue;
    const current = options[field];
    if (current === sessionID || current === stripped) replacements[field] = value;
    else sawForeign = true;
  }

  if (Object.keys(replacements).length === 0) return sawForeign ? "foreign" : "absent";

  output.options = { ...options, ...replacements };
  return "applied";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 25 tests total.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode-context-cache.mjs test/apply-cache-key.test.mjs
git commit -m "feat: replace the cache key only when it is core's own default

Field presence does not prove provenance; matching opencode's session ID
does, and it leaves deliberate operator and plugin settings untouched."
```

---

### Task 3: Logging and the operator warning channel

**Files:**
- Modify: `plugins/opencode-context-cache.mjs` (append)
- Test: `test/logger.test.mjs`

**Interfaces:**
- Consumes: `sha256` from Task 1.
- Produces: `defaultLogPath(env, home) -> string`, `fingerprint(value) -> string`, `createLogger({env, filePath, write, warn}) -> {enabled, path, debug(...args), warnOnce(key, message) -> boolean}`.

- [ ] **Step 1: Write the failing test**

Create `test/logger.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  DEBUG_ENV_VAR,
  LOG_PATH_ENV_VAR,
  createLogger,
  defaultLogPath,
  fingerprint,
} from "../plugins/opencode-context-cache.mjs";

test("default log path honours an explicit override", () => {
  assert.equal(defaultLogPath({ [LOG_PATH_ENV_VAR]: "/custom/x.log" }, "/home/u"), "/custom/x.log");
});

test("default log path honours XDG_STATE_HOME, else falls back under home", () => {
  assert.equal(defaultLogPath({ XDG_STATE_HOME: "/xdg" }, "/home/u"), "/xdg/opencode/context-cache.log");
  assert.equal(defaultLogPath({}, "/home/u"), "/home/u/.local/state/opencode/context-cache.log");
});

test("fingerprint is a short, stable, non-reversible tag", () => {
  assert.equal(fingerprint("team-key").length, 8);
  assert.equal(fingerprint("team-key"), fingerprint("team-key"));
  assert.notEqual(fingerprint("team-key"), fingerprint("other-key"));
});

test("debug logging is off unless explicitly enabled", () => {
  const lines = [];
  const logger = createLogger({ env: {}, filePath: "/unused", write: (_p, l) => lines.push(l) });
  assert.equal(logger.enabled, false);
  logger.debug("hello");
  assert.deepEqual(lines, []);
});

test("debug logging writes one single-line entry when enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-"));
  const path = join(dir, "nested", "context-cache.log");
  const logger = createLogger({ env: { [DEBUG_ENV_VAR]: "1" }, filePath: path });
  assert.equal(logger.enabled, true);
  logger.debug("hello", "multi\nline");
  const body = readFileSync(path, "utf8");
  assert.equal(body.split("\n").filter(Boolean).length, 1);
  assert.match(body, /\[context-cache\] hello multi\\nline/);
});

test("an unwritable log warns exactly once and never throws", () => {
  const warnings = [];
  const logger = createLogger({
    env: { [DEBUG_ENV_VAR]: "true" },
    filePath: "/unused",
    write: () => { throw new Error("EACCES"); },
    warn: (m) => warnings.push(m),
  });
  logger.debug("one");
  logger.debug("two");
  logger.debug("three");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
});

test("warnOnce deduplicates by key and ignores the debug flag", () => {
  const warnings = [];
  const logger = createLogger({ env: {}, filePath: "/unused", warn: (m) => warnings.push(m) });
  assert.equal(logger.warnOnce("absent:openai", "first"), true);
  assert.equal(logger.warnOnce("absent:openai", "again"), false);
  assert.equal(logger.warnOnce("absent:anthropic", "other"), true);
  assert.deepEqual(warnings, ["[context-cache] first", "[context-cache] other"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'createLogger'`.

- [ ] **Step 3: Append the logging layer**

```js
export function fingerprint(value) {
  return sha256(value).slice(0, 8);
}

export function defaultLogPath(env = {}, home = homedir()) {
  const explicit = trimmedEnv(env, LOG_PATH_ENV_VAR);
  if (explicit) return explicit;
  const stateHome = trimmedEnv(env, "XDG_STATE_HOME") || join(home, ".local", "state");
  return join(stateHome, "opencode", "context-cache.log");
}

/**
 * Two channels. `debug` is opt-in and file-backed. `warnOnce` is always on and
 * deduplicated: a compatibility failure must be visible without the operator
 * having first guessed to turn debug logging on.
 */
export function createLogger({ env = {}, filePath, write = appendFileSync, warn = console.warn } = {}) {
  const flag = String(env?.[DEBUG_ENV_VAR] ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const path = filePath ?? defaultLogPath(env);
  const warned = new Set();
  let fileUsable = true;

  function emit(message) {
    warn(`[context-cache] ${message}`);
  }

  return {
    enabled,
    path,

    debug(...args) {
      if (!enabled || !fileUsable) return;
      const body = args
        .map((arg) => (typeof arg === "object" && arg !== null ? safeJson(arg) : String(arg)))
        .join(" ")
        .replace(/\r?\n/g, "\\n");
      const line = `[${new Date().toISOString()}] [pid:${process.pid}] [context-cache] ${body}\n`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        write(path, line, "utf8");
      } catch (error) {
        fileUsable = false;
        emit(`cannot write debug log at ${path}: ${error?.message ?? error}; debug logging disabled`);
      }
    },

    warnOnce(key, message) {
      if (warned.has(key)) return false;
      warned.add(key);
      emit(message);
      return true;
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 32 tests total.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode-context-cache.mjs test/logger.test.mjs
git commit -m "feat: split operator warnings from the opt-in debug log

Compatibility failures now surface without the debug flag, deduplicated,
and the log moves out of the plugin directory into the XDG state dir."
```

---

### Task 4: Plugin factory and hook wiring

**Files:**
- Modify: `plugins/opencode-context-cache.mjs` (append)
- Test: `test/plugin-hook.test.mjs`

**Interfaces:**
- Consumes: `resolveCacheKey`, `applyCacheKey`, `createLogger`, `fingerprint` from Tasks 1-3.
- Produces: `getUsername(env) -> string`, `safeHostname() -> string`, `OpenCodeContextCachePlugin(pluginInput, options?) -> Promise<{"chat.params": fn}>`, plus `EnhancedCachePlugin` and default aliases.

- [ ] **Step 1: Write the failing test**

Create `test/plugin-hook.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import OpenCodeContextCacheDefault, {
  EnhancedCachePlugin,
  OpenCodeContextCachePlugin,
  PROMPT_CACHE_KEY_ENV_VAR,
  SCOPE_ENV_VAR,
  resolveCacheKey,
  getUsername,
  safeHostname,
} from "../plugins/opencode-context-cache.mjs";

const SESSION = "ses_" + "b".repeat(64);

function hookInput(extra = {}) {
  return {
    sessionID: SESSION,
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5", headers: { "x-existing": "keep" } },
    provider: { info: { id: "openai" } },
    ...extra,
  };
}

function withEnv(vars, run) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("exports the factory under all three names", () => {
  assert.equal(typeof OpenCodeContextCachePlugin, "function");
  assert.equal(EnhancedCachePlugin, OpenCodeContextCachePlugin);
  assert.equal(OpenCodeContextCacheDefault, OpenCodeContextCachePlugin);
});

test("factory returns a chat.params hook", async () => {
  const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
  assert.equal(typeof hooks["chat.params"], "function");
});

test("the hook applies exactly the key the resolver would produce", async () => {
  await withEnv({ [PROMPT_CACHE_KEY_ENV_VAR]: undefined, [SCOPE_ENV_VAR]: undefined }, async () => {
    const input = { directory: "/srv/repo/pkg/a", worktree: "/srv/repo" };
    const expected = resolveCacheKey({
      env: process.env,
      directory: input.directory,
      worktree: input.worktree,
      user: getUsername(process.env),
      host: safeHostname(),
    });
    const hooks = await OpenCodeContextCachePlugin(input);
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, expected.value);
  });
});

test("the hook never writes conversation headers", async () => {
  const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
  const input = hookInput();
  const before = structuredClone(input.model.headers);
  await hooks["chat.params"](input, { options: { promptCacheKey: SESSION } });
  assert.deepEqual(input.model.headers, before);
  for (const banned of ["x-session-id", "session_id", "conversation_id", "X-Session-Id", "x-session-affinity"]) {
    assert.equal(banned in input.model.headers, false, `must not set ${banned}`);
  }
});

test("the hook leaves a key it did not set", async () => {
  const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
  const output = { options: { promptCacheKey: "operator-choice" } };
  await hooks["chat.params"](hookInput(), output);
  assert.equal(output.options.promptCacheKey, "operator-choice");
});

test("the hook adds nothing when core placed no field", async () => {
  const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
  const output = { options: { store: false } };
  await hooks["chat.params"](hookInput(), output);
  assert.deepEqual(output.options, { store: false });
});

test("the hook is inert when no key could be resolved", async () => {
  await withEnv({ [SCOPE_ENV_VAR]: "session" }, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, SESSION);
  });
});

test("the hook does not throw on malformed input or output", async () => {
  const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
  await hooks["chat.params"](hookInput(), {});
  await hooks["chat.params"](hookInput(), { options: null });
  await hooks["chat.params"]({}, { options: { promptCacheKey: SESSION } });
  await hooks["chat.params"](undefined, { options: { promptCacheKey: SESSION } });
  await hooks["chat.params"](hookInput({ sessionID: undefined }), { options: { promptCacheKey: SESSION } });
});

test("two worktrees yield different keys, independent of process.cwd()", async () => {
  const output = (key) => ({ options: { promptCacheKey: key } });
  const a = await OpenCodeContextCachePlugin({ directory: "/srv/a/sub", worktree: "/srv/a" });
  const b = await OpenCodeContextCachePlugin({ directory: "/srv/b/sub", worktree: "/srv/b" });
  const outA = output(SESSION);
  const outB = output(SESSION);
  await a["chat.params"](hookInput(), outA);
  await b["chat.params"](hookInput(), outB);
  assert.notEqual(outA.options.promptCacheKey, outB.options.promptCacheKey);
});

test("a nested directory shares the key of its worktree root", async () => {
  const root = await OpenCodeContextCachePlugin({ directory: "/srv/a", worktree: "/srv/a" });
  const nested = await OpenCodeContextCachePlugin({ directory: "/srv/a/pkg/deep", worktree: "/srv/a" });
  const outRoot = { options: { promptCacheKey: SESSION } };
  const outNested = { options: { promptCacheKey: SESSION } };
  await root["chat.params"](hookInput(), outRoot);
  await nested["chat.params"](hookInput(), outNested);
  assert.equal(outRoot.options.promptCacheKey, outNested.options.promptCacheKey);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'getUsername'`.

- [ ] **Step 3: Append the factory**

```js
export function getUsername(env = process.env) {
  try {
    const info = userInfo();
    if (info?.username) return info.username;
  } catch {
    // userInfo throws in some restricted environments; fall through to env.
  }
  return env?.USER || env?.USERNAME || env?.LOGNAME || "unknown";
}

export function safeHostname() {
  try {
    return hostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

export const OpenCodeContextCachePlugin = async (input = {}) => {
  const env = process.env;
  const logger = createLogger({ env });
  const resolved = resolveCacheKey({
    env,
    worktree: input?.worktree,
    directory: input?.directory,
    user: getUsername(env),
    host: safeHostname(),
  });

  if (!resolved) {
    logger.debug("no stable cache key resolved; leaving opencode's session default in place");
  } else {
    logger.debug(
      `cache key source=${resolved.source} hashed=${resolved.hashed}`,
      // Never log the raw value of an operator-supplied override: it may carry
      // a tenant name or a secret pasted into the env var by mistake.
      resolved.sensitive ? `fingerprint=${fingerprint(resolved.raw)}` : `raw=${resolved.raw}`,
    );
  }

  return {
    "chat.params": async (hookInput, output) => {
      if (!resolved) return;
      const provider = hookInput?.model?.providerID ?? hookInput?.provider?.info?.id ?? "unknown";
      try {
        const outcome = applyCacheKey(output, resolved.value, hookInput?.sessionID);
        if (outcome === "applied") {
          logger.debug(`applied cache key for provider=${provider}`);
          return;
        }
        if (outcome === "foreign") {
          logger.warnOnce(
            `foreign:${provider}`,
            `provider ${provider} already carries a prompt cache key this plugin did not set; leaving it unchanged`,
          );
          return;
        }
        logger.warnOnce(
          `absent:${provider}`,
          `provider ${provider} exposes no prompt cache key field, so none was applied. ` +
            "This is expected for providers that do not support one; if this provider used to work, " +
            "opencode may have renamed the field.",
        );
      } catch (error) {
        // A cache optimization must never fail the user's request.
        logger.warnOnce(`error:${provider}`, `unexpected error applying cache key: ${error?.stack ?? error}`);
      }
    },
  };
};

/** Kept so existing configs importing the old name keep working. */
export const EnhancedCachePlugin = OpenCodeContextCachePlugin;

export default OpenCodeContextCachePlugin;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 42 tests total.

- [ ] **Step 5: Verify no header writing survives anywhere in the file**

Run: `grep -nE "x-session-id|session_id|conversation_id|model\.headers|x-session-affinity" plugins/opencode-context-cache.mjs`
Expected: no output. If anything matches, remove it.

- [ ] **Step 6: Commit**

```bash
git add plugins/opencode-context-cache.mjs test/plugin-hook.test.mjs
git commit -m "feat: resolve the key once per plugin instance from PluginInput

Drops all conversation-identity header writes and the module-level
singletons, so two projects served by one process no longer share a key."
```

---

### Task 5: Opt-in integration test against a real opencode

**Files:**
- Create: `test/integration/probe-plugin.mjs`
- Create: `test/integration/lifecycle.test.mjs`

**Interfaces:**
- Consumes: nothing from the plugin under test; it asserts the opencode contract the plugin depends on.
- Produces: nothing consumed by later tasks.

This is the compatibility gate. The installed plugin types are 1.18.21 while the binary is 1.18.25, so the behavior this design rests on is verified against compiled code, not a published contract. Run this before upgrading opencode.

- [ ] **Step 1: Create the probe fixture**

Create `test/integration/probe-plugin.mjs`:

```js
import { appendFileSync } from "fs";

const OUT = process.env.CONTEXT_CACHE_PROBE_OUT;

export const ProbePlugin = async (input) => {
  if (OUT) {
    appendFileSync(
      OUT,
      JSON.stringify({
        directory: input?.directory,
        worktree: input?.worktree,
        hasWorktree: input ? "worktree" in input : false,
        vcs: input?.project?.vcs ?? null,
        cwd: process.cwd(),
      }) + "\n",
      "utf8",
    );
  }
  return {};
};

export default ProbePlugin;
```

- [ ] **Step 2: Write the failing test**

Create `test/integration/lifecycle.test.mjs`:

```js
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function findOpencode() {
  const candidates = [
    process.env.OPENCODE_BIN,
    join(process.env.HOME ?? "", ".opencode", "bin", "opencode"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const BIN = findOpencode();
const skip = BIN ? false : "no opencode binary found; set OPENCODE_BIN to run this suite";

const root = mkdtempSync(join(tmpdir(), "ctx-cache-it-"));
const probeOut = join(root, "probe.jsonl");
const servers = [];

after(() => {
  for (const s of servers) s.kill("SIGTERM");
});

function makeProject(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, "pkg", "deep"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
    },
  });
  cpSync(join(HERE, "probe-plugin.mjs"), join(dir, "probe-plugin.mjs"));
  writeFileSync(
    join(dir, "opencode.jsonc"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["./probe-plugin.mjs"] }, null, 2),
  );
  return dir;
}

async function serveAndProbe(port, directories, cwd) {
  const child = spawn(BIN, ["serve", "--port", String(port)], {
    cwd,
    env: { ...process.env, CONTEXT_CACHE_PROBE_OUT: probeOut },
    stdio: "ignore",
  });
  servers.push(child);
  await new Promise((r) => setTimeout(r, 8000));
  for (const dir of directories) {
    await fetch(`http://127.0.0.1:${port}/config`, {
      headers: { "x-opencode-directory": encodeURIComponent(dir) },
    }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 3000));
  child.kill("SIGTERM");
  return readFileSync(probeOut, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("one server process gives each project its own PluginInput", { skip }, async () => {
  const a = makeProject("alpha");
  const b = makeProject("beta");
  // Start the server from a directory that is neither project, so any
  // implementation reading process.cwd() is demonstrably wrong.
  const records = await serveAndProbe(47901, [a, b], root);

  const forA = records.find((r) => r.worktree === a);
  const forB = records.find((r) => r.worktree === b);

  assert.ok(forA, "expected a plugin invocation for project alpha");
  assert.ok(forB, "expected a plugin invocation for project beta");
  assert.notEqual(forA.worktree, forB.worktree);
  assert.equal(forA.cwd, forB.cwd, "both invocations share one process cwd");
  assert.notEqual(forA.cwd, forA.worktree, "process.cwd() is not the project path");
});

test("PluginInput still exposes worktree as the VCS root", { skip }, async () => {
  const project = makeProject("gamma");
  const nested = join(project, "pkg", "deep");
  const records = await serveAndProbe(47902, [nested], nested);
  const record = records.find((r) => r.directory === nested);

  assert.ok(record, "expected a plugin invocation for the nested directory");
  assert.equal(record.hasWorktree, true, "PluginInput.worktree must exist");
  assert.equal(record.worktree, project, "worktree must be the git root, not the cwd");
  assert.equal(record.vcs, "git");
});
```

- [ ] **Step 3: Run the integration suite**

Run: `npm run test:integration`
Expected: PASS with 2 tests when an opencode binary is present; both reported as skipped otherwise.

- [ ] **Step 4: Confirm the unit suite did not pick these up**

Run: `npm test`
Expected: still 42 tests. `test/*.test.mjs` must not match `test/integration/`.

- [ ] **Step 5: Commit**

```bash
git add test/integration
git commit -m "test: add an opt-in opencode lifecycle compatibility gate

Asserts the two contracts this design rests on - one plugin instance per
project, and worktree as the VCS root - against the real binary. Skips
when none is installed, so CI stays green."
```

---

### Task 6: CI and README

**Files:**
- Create: `.github/workflows/test.yml`
- Modify: `README.md` (rewrite)

**Interfaces:**
- Consumes: the `test` script from Task 1.
- Produces: nothing.

- [ ] **Step 1: Create the CI workflow**

Create `.github/workflows/test.yml`:

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ["20", "22"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm test
```

No install step: the project has no dependencies.

- [ ] **Step 2: Rewrite `README.md`**

Replace the file. Required content, in order:

1. **Title and one-paragraph summary.** State plainly that the plugin sets a prompt cache key stable across sessions in one git worktree, replacing opencode's per-session default.
2. **A "Breaking change in 0.2.0" section, near the top.** State that the plugin no longer writes `x-session-id`, `conversation_id` or `session_id`; that opencode core already sends `x-session-affinity` and `X-Session-Id` derived from the real session ID; and that a gateway relying on the underscore names must be reconfigured to read core's headers. Give the reason in one sentence: those header names identify a conversation, and a project-stable value in them is wrong, because on opencode's OpenAI/Codex path `x-session-affinity` keys a WebSocket pool whose `busy` and `fallback` state would then be shared by every concurrent session in the project.
3. **How it works.** The three-line version: core sets the cache key to the session ID; this plugin replaces that value, and only that value, with `sha256(user@host:<worktree>)`.
4. **Install.** Both routes: npm identifier in the `plugin` array, and copying the single file. Keep the existing warning that the `plugin` entry is required.
5. **Configuration.** A table of all five env vars with defaults, plus `OPENCODE_CONTEXT_CACHE_SCOPE` values (`worktree` default, `directory`, `session`).
6. **Provider support.** Honest: this sets OpenAI-family `promptCacheKey` / `prompt_cache_key`. Anthropic uses `cache_control` breakpoints and ignores a cache key, so the plugin is inert there and says so once in the log. Remove every "works with ALL providers" claim.
7. **Hashing.** Describe as keeping the local username, hostname and path off the wire. Do not call it privacy: the pre-image space is small enough to enumerate.
8. **Observed impact.** Keep the 97.99% figure but label it explicitly as a single anecdotal run on one provider with no controlled baseline.
9. **Troubleshooting.** Debug flag, log location, and what the two operator warnings mean.

Delete: the `isSha256Hex` digest-detection bullet, the five-level precedence list (it is three levels now), and every reference to setting session headers.

- [ ] **Step 3: Verify no stale claims survive**

Run: `grep -niE "all providers|privacy|sticky session header|conversation_id|x-session-id" README.md`
Expected: matches only inside the "Breaking change" section, where those names are named in order to say they were removed.

- [ ] **Step 4: Run the full suite one more time**

Run: `npm test && npm run test:integration`
Expected: 42 unit tests pass; integration passes or skips.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/test.yml README.md
git commit -m "docs: rewrite README for the new behavior, add CI

Documents the header removal as a breaking change, drops the all-providers
and privacy claims, and labels the cache hit figure as a single run."
```

---

## Self-Review

**Spec coverage.** Section 3.1 shape -> Task 1 Step 5. 3.2 resolution, scope, override bounds -> Task 1. 3.3 provenance and replacement -> Task 2. 3.4 hook wiring -> Task 4. 3.5 logging and warning channel -> Task 3. 3.6 error handling table -> Tasks 2 and 4 (every row has a test). Section 4 unit tests -> Tasks 1-4; hook-level tests -> Task 4; integration -> Task 5. Section 5 deliverables -> all six tasks. No gaps.

**Placeholder scan.** Every code step carries complete code. Task 6 Step 2 specifies README content as a numbered list of required sections rather than full prose; that is a documentation step, and each item states exactly what it must say and what must be deleted, with a grep gate in Step 3 to verify.

**Type consistency.** `resolveCacheKey` returns `{raw, value, source, hashed, sensitive}` in Task 1 and is destructured for exactly those fields in Task 4. `applyCacheKey(output, value, sessionID)` takes the output object, not `options`, in both Task 2 and Task 4. `createLogger` exposes `enabled`, `path`, `debug`, `warnOnce` in Task 3 and Task 4 uses only those. `trimmedEnv` and `safeJson` are module-private and defined once each, in Tasks 1 and 3 respectively.
