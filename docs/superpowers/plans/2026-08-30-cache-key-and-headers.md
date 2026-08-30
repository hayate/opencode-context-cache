# OpenCode Context Cache Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plugin's session-header writing and `process.cwd()`-derived cache key with a single, provenance-checked prompt cache key scoped to the git worktree.

**Architecture:** One self-contained ESM file exporting pure helpers plus a plugin factory. `resolveCacheKey` computes the key once per factory invocation from `PluginInput`; `applyCacheKey` replaces a cache-key field in `output.options` only when its current value is provably opencode's own session-ID default. No conversation headers are written. No module-level mutable state.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, `node:crypto`, zero runtime and zero dev dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-cache-key-and-headers-design.md`

## Global Constraints

- Single shipped file: `plugins/opencode-context-cache.mjs`. Do not split into `src/`; upstream's install path is copying that one file.
- **Every commit must leave a loadable plugin.** After each task, `plugins/opencode-context-cache.mjs` must still export `OpenCodeContextCachePlugin`, `EnhancedCachePlugin` and a default, and that factory must return an object with a `chat.params` function. An intermediate commit may ship a plugin that does nothing; it may never ship one opencode cannot load.
- Zero dependencies, runtime and dev. Tests run on `node --test` with no install step.
- Node `>=20`.
- **The hook must never throw.** The entire hook body, including provider-label extraction, lives inside one `try`. Logging and warning sinks are themselves wrapped so a failing `console.warn` cannot escape.
- Never write `x-session-id`, `conversation_id`, `session_id`, `X-Session-Id`, or `x-session-affinity`. Never touch `input.model.headers`.
- Never log the raw value of an operator-supplied override; log its source and an 8-character fingerprint only.
- `MAX_CACHE_KEY_LENGTH = 64`. Printable ASCII is `/^[\x20-\x7E]+$/`.
- **Do not trim filesystem paths.** A path may legitimately end in whitespace. Treat a whitespace-only path as absent; otherwise use it verbatim.
- Keep the `EnhancedCachePlugin` named export and the default export as aliases.
- Env var names, exact: `OPENCODE_PROMPT_CACHE_KEY`, `OPENCODE_STICKY_SESSION_ID`, `OPENCODE_CONTEXT_CACHE_SCOPE`, `OPENCODE_CONTEXT_CACHE_DEBUG`, `OPENCODE_CONTEXT_CACHE_LOG`.
- **Scope precedence:** parse scope first. `session` is a hard opt-out that beats an explicit override, because it is the safety valve for providers with lookup-key semantics and must not be defeatable by a stale env var. An unrecognised scope value warns once and falls back to `worktree`.
- **Config precedence:** env vars beat the plugin `options` object from `opencode.jsonc`, which beats defaults.
- Commit messages: no `Co-Authored-By` agent attribution. Use a plain dash, never an em dash, in all prose and code comments.

## File Structure

| File | Responsibility |
|---|---|
| `plugins/opencode-context-cache.mjs` | Everything shipped: pure helpers + factory. Rewritten. |
| `package.json` | npm-installable identity, explicit `test` scripts. New. |
| `.gitignore` | log file, `node_modules`. New. |
| `test/unit/cache-key.test.mjs` | resolution, scope parsing, override bounds. |
| `test/unit/apply-cache-key.test.mjs` | provenance, per-field outcomes, immutability. |
| `test/unit/logger.test.mjs` | log path, write and mkdir failure, `warnOnce`, redaction. |
| `test/unit/plugin-hook.test.mjs` | the real factory and the hook it returns. |
| `test/integration/probe-plugin.mjs` | fixture recording `PluginInput`. |
| `test/integration/plugin-input-contract.test.mjs` | opt-in, runs a real `opencode serve`. |
| `.github/workflows/test.yml` | CI on Node 20 and 22. |
| `README.md`, `CHANGELOG.md` | Rewritten / new. |

---

### Task 1: Scaffolding and a loadable, inert plugin

Delivers the resolution layer and a plugin that loads, resolves a key, logs it, and deliberately does nothing with it yet. Applying the key arrives in Task 4.

**Files:**
- Create: `package.json`, `.gitignore`
- Create: `plugins/opencode-context-cache.mjs` (replacing the existing file wholesale)
- Test: `test/unit/cache-key.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: constants `PROMPT_CACHE_KEY_ENV_VAR`, `STICKY_SESSION_ID_ENV_VAR`, `SCOPE_ENV_VAR`, `DEBUG_ENV_VAR`, `LOG_PATH_ENV_VAR`, `MAX_CACHE_KEY_LENGTH`, `SCOPES`; `sha256(v) -> string`; `fingerprint(v) -> string`; `isSafeOverride(v) -> boolean`; `parseScope(raw) -> {scope, unknown}`; `selectScopePath({scope, worktree, directory}) -> string`; `resolveCacheKey({env, options, worktree, directory, user, host}) -> {raw, value, source, hashed, sensitive, deprecated, unknownScope} | null`; `getUsername({env, readUserInfo}) -> string`; `safeHostname({readHostname}) -> string`; `createLogger(...)`; `OpenCodeContextCachePlugin`, `EnhancedCachePlugin`, default.

- [ ] **Step 1: Create `package.json`**

Test files are listed explicitly. A glob is not portable to Windows `cmd.exe`, and on Node 24 an unmatched quoted glob reports zero tests and exits 0 - a silently green CI run.

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
    "CHANGELOG.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "node --test test/unit/cache-key.test.mjs test/unit/apply-cache-key.test.mjs test/unit/logger.test.mjs test/unit/plugin-hook.test.mjs",
    "test:integration": "node --test test/integration/plugin-input-contract.test.mjs"
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

Create `test/unit/cache-key.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
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
} from "../../plugins/opencode-context-cache.mjs";

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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL at module link time with `SyntaxError: The requested module '../../plugins/opencode-context-cache.mjs' does not provide an export named 'MAX_CACHE_KEY_LENGTH'`. Node reports the *first* missing binding in the import list, not `resolveCacheKey`.

- [ ] **Step 5: Replace `plugins/opencode-context-cache.mjs`**

Delete the entire existing contents: the `DebugLogger`, `CacheKeyResolver`, `CacheKeyApplier` and `ContextCachePluginRuntime` classes, and the module-level singletons. Write:

```js
/**
 * opencode plugin: OpenCode Context Cache
 *
 * Gives opencode a prompt cache key that is stable across sessions in the same
 * git worktree, instead of core's default of a fresh session ID per session.
 *
 * It sets exactly one thing: the prompt cache key field opencode core has
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

export const SCOPES = ["worktree", "directory", "session"];

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprint(value) {
  return sha256(value).slice(0, 8);
}

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Paths are used verbatim: only a whitespace-only path counts as absent. */
function usablePath(value) {
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

export function isSafeOverride(value) {
  return value.length <= MAX_CACHE_KEY_LENGTH && PRINTABLE_ASCII.test(value);
}

export function parseScope(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "") return { scope: "worktree", unknown: null };
  if (SCOPES.includes(value)) return { scope: value, unknown: null };
  return { scope: "worktree", unknown: value };
}

/**
 * Mirrors core's own project-path guard:
 *   vcs === "git" && worktree !== "/" ? worktree : directory
 * A degenerate "/" worktree would otherwise collapse every project on the
 * machine onto a single key.
 */
export function selectScopePath({ scope, worktree, directory }) {
  const tree = usablePath(worktree);
  const dir = usablePath(directory);
  if (scope === "session") return "";
  if (scope === "directory") return dir;
  if (tree && tree.trim() !== "/") return tree;
  return dir;
}

export function resolveCacheKey({ env = {}, options = {}, worktree, directory, user, host } = {}) {
  // Scope is parsed first so that `session` is a genuine opt-out: a stale
  // override must not be able to defeat the safety valve.
  const { scope, unknown: unknownScope } = parseScope(
    readEnv(env, SCOPE_ENV_VAR) || (typeof options?.scope === "string" ? options.scope : ""),
  );
  if (scope === "session") return null;

  const explicit = [
    [readEnv(env, PROMPT_CACHE_KEY_ENV_VAR), PROMPT_CACHE_KEY_ENV_VAR, false],
    [readEnv(env, STICKY_SESSION_ID_ENV_VAR), STICKY_SESSION_ID_ENV_VAR, true],
    [typeof options?.cacheKey === "string" ? options.cacheKey.trim() : "", "options.cacheKey", false],
  ].find(([raw]) => raw !== "");

  if (explicit) {
    const [raw, source, deprecated] = explicit;
    const safe = isSafeOverride(raw);
    return { raw, value: safe ? raw : sha256(raw), source, hashed: !safe, sensitive: true, deprecated, unknownScope };
  }

  const path = selectScopePath({ scope, worktree, directory });
  if (!path) return null;

  const raw = `${user}@${host}:${path}`;
  return {
    raw,
    value: sha256(raw),
    source: `user@host:${scope}`,
    hashed: true,
    sensitive: false,
    deprecated: false,
    unknownScope,
  };
}

export function getUsername({ env = process.env, readUserInfo = userInfo } = {}) {
  try {
    const info = readUserInfo();
    if (info?.username) return info.username;
  } catch {
    // userInfo throws in some restricted environments; fall through to env.
  }
  return env?.USER || env?.USERNAME || env?.LOGNAME || "unknown";
}

export function safeHostname({ readHostname = hostname } = {}) {
  try {
    return readHostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

export function defaultLogPath(env = {}, home = homedir()) {
  const explicit = readEnv(env, LOG_PATH_ENV_VAR);
  if (explicit) return explicit;
  const stateHome = readEnv(env, "XDG_STATE_HOME") || join(home, ".local", "state");
  return join(stateHome, "opencode", "context-cache.log");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Minimal debug-only logger. The operator warning channel arrives in Task 3. */
export function createLogger({ env = {}, filePath, write = appendFileSync, warn = console.warn } = {}) {
  const flag = String(env?.[DEBUG_ENV_VAR] ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const path = filePath ?? defaultLogPath(env);
  let fileUsable = true;
  let dirReady = false;

  function emit(message) {
    try {
      warn(`[context-cache] ${message}`);
    } catch {
      // A failing warning sink must never escape into the request path.
    }
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
      try {
        if (!dirReady) {
          mkdirSync(dirname(path), { recursive: true });
          dirReady = true;
        }
        write(path, `[${new Date().toISOString()}] [pid:${process.pid}] [context-cache] ${body}\n`, "utf8");
      } catch (error) {
        fileUsable = false;
        emit(`cannot write debug log at ${path}: ${error?.message ?? error}; debug logging disabled`);
      }
    },
  };
}

export const OpenCodeContextCachePlugin = async (input = {}, options = {}) => {
  const env = process.env;
  const logger = createLogger({ env });
  const resolved = resolveCacheKey({
    env,
    options,
    worktree: input?.worktree,
    directory: input?.directory,
    user: getUsername({ env }),
    host: safeHostname(),
  });

  if (!resolved) logger.debug("no stable cache key resolved; leaving opencode's session default in place");
  else {
    logger.debug(
      `cache key source=${resolved.source} hashed=${resolved.hashed}`,
      // Never log the raw value of an operator-supplied override: it may carry
      // a tenant name or a secret pasted into the env var by mistake.
      resolved.sensitive ? `fingerprint=${fingerprint(resolved.raw)}` : `raw=${resolved.raw}`,
    );
  }

  return {
    // Applying the key is wired in Task 4. This keeps the plugin loadable.
    "chat.params": async () => {},
  };
};

/** Kept so existing configs importing the old name keep working. */
export const EnhancedCachePlugin = OpenCodeContextCachePlugin;

export default OpenCodeContextCachePlugin;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 20 tests.

- [ ] **Step 7: Verify the plugin is still loadable**

Run: `node -e "import('./plugins/opencode-context-cache.mjs').then(async m => { const h = await m.default({directory:'/tmp',worktree:'/tmp'}); console.log(typeof h['chat.params']); })"`
Expected: `function`

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore plugins/opencode-context-cache.mjs test/unit/cache-key.test.mjs
git commit -m "feat: resolve a worktree-scoped prompt cache key

Replaces the process.cwd() key with one derived from PluginInput, bounds
explicit overrides to what a provider will accept, and makes scope=session
a hard opt-out. The plugin loads and is inert; applying the key follows."
```

---

### Task 2: Provenance-checked application

**Files:**
- Modify: `plugins/opencode-context-cache.mjs` (append, above the factory)
- Test: `test/unit/apply-cache-key.test.mjs`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: `CACHE_KEY_FIELDS: string[]`, `stripSesPrefix(sessionID) -> string`, `applyCacheKey(output, value, sessionID) -> {appliedFields: string[], foreignFields: string[], reason: "invalid-options"|"missing-session"|"no-fields"|null}`.

A three-value return cannot express "applied one field and found another foreign", so the result is a record. Only `reason === "no-fields"` and a non-empty `foreignFields` warrant an operator warning; `invalid-options` and `missing-session` are debug-only, per the spec's error table.

- [ ] **Step 1: Write the failing test**

Create `test/unit/apply-cache-key.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCacheKey, stripSesPrefix } from "../../plugins/opencode-context-cache.mjs";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'applyCacheKey'`.

- [ ] **Step 3: Append the application layer**

Insert immediately before `export const OpenCodeContextCachePlugin`:

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
  if (!options || typeof options !== "object") {
    return { appliedFields: [], foreignFields: [], reason: "invalid-options" };
  }
  if (typeof sessionID !== "string" || sessionID === "") {
    return { appliedFields: [], foreignFields: [], reason: "missing-session" };
  }

  const stripped = stripSesPrefix(sessionID);
  const appliedFields = [];
  const foreignFields = [];
  const replacements = {};

  for (const field of CACHE_KEY_FIELDS) {
    if (!(field in options)) continue;
    const current = options[field];
    if (current === sessionID || current === stripped) {
      replacements[field] = value;
      appliedFields.push(field);
    } else {
      foreignFields.push(field);
    }
  }

  if (appliedFields.length === 0 && foreignFields.length === 0) {
    return { appliedFields, foreignFields, reason: "no-fields" };
  }
  if (appliedFields.length > 0) output.options = { ...options, ...replacements };
  return { appliedFields, foreignFields, reason: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 32 tests total.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode-context-cache.mjs test/unit/apply-cache-key.test.mjs
git commit -m "feat: replace the cache key only when it is core's own default

Field presence does not prove provenance; matching opencode's session ID
does. Reports applied and foreign fields separately so a mixed conflict
is visible rather than silently half-applied."
```

---

### Task 3: The operator warning channel

**Files:**
- Modify: `plugins/opencode-context-cache.mjs` (extend `createLogger`)
- Test: `test/unit/logger.test.mjs`

**Interfaces:**
- Consumes: `createLogger` from Task 1.
- Produces: `createLogger(...)` additionally exposing `warnOnce(key, message) -> boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/logger.test.mjs`:

```js
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  DEBUG_ENV_VAR,
  LOG_PATH_ENV_VAR,
  createLogger,
  defaultLogPath,
  fingerprint,
} from "../../plugins/opencode-context-cache.mjs";

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-"));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

test("default log path honours an explicit override", () => {
  assert.equal(defaultLogPath({ [LOG_PATH_ENV_VAR]: "/custom/x.log" }, "/home/u"), "/custom/x.log");
});

test("default log path honours XDG_STATE_HOME, else falls back under home", () => {
  assert.equal(defaultLogPath({ XDG_STATE_HOME: "/xdg" }, "/home/u"), "/xdg/opencode/context-cache.log");
  assert.equal(defaultLogPath({}, "/home/u"), "/home/u/.local/state/opencode/context-cache.log");
});

test("fingerprint is short, stable, and distinguishes inputs", () => {
  assert.equal(fingerprint("team-key").length, 8);
  assert.equal(fingerprint("team-key"), fingerprint("team-key"));
  assert.notEqual(fingerprint("team-key"), fingerprint("other-key"));
  assert.equal(fingerprint("team-key").includes("team-key"), false);
});

test("debug logging is off unless explicitly enabled", () => {
  const lines = [];
  const logger = createLogger({ env: {}, filePath: "/unused", write: (_p, l) => lines.push(l) });
  assert.equal(logger.enabled, false);
  logger.debug("hello");
  assert.deepEqual(lines, []);
});

test("debug logging writes one single-line entry when enabled", () => {
  const path = join(tempDir(), "nested", "context-cache.log");
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
    filePath: join(tempDir(), "x.log"),
    write: () => { throw new Error("EACCES"); },
    warn: (m) => warnings.push(m),
  });
  logger.debug("one");
  logger.debug("two");
  logger.debug("three");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
});

test("an unmakeable log directory warns once and never throws", () => {
  const dir = tempDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  const warnings = [];
  const logger = createLogger({
    env: { [DEBUG_ENV_VAR]: "1" },
    filePath: join(blocker, "sub", "x.log"),
    warn: (m) => warnings.push(m),
  });
  logger.debug("one");
  logger.debug("two");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot write debug log/);
});

test("a throwing warn sink cannot escape", () => {
  const logger = createLogger({
    env: { [DEBUG_ENV_VAR]: "1" },
    filePath: "/unused",
    write: () => { throw new Error("EACCES"); },
    warn: () => { throw new Error("stderr is gone"); },
  });
  logger.debug("boom");
  assert.equal(logger.warnOnce("k", "m"), true);
});

test("warnOnce deduplicates by key and ignores the debug flag", () => {
  const warnings = [];
  const logger = createLogger({ env: {}, filePath: "/unused", warn: (m) => warnings.push(m) });
  assert.equal(logger.enabled, false, "warnings must not require the debug flag");
  assert.equal(logger.warnOnce("absent:openai", "first"), true);
  assert.equal(logger.warnOnce("absent:openai", "again"), false);
  assert.equal(logger.warnOnce("absent:anthropic", "other"), true);
  assert.deepEqual(warnings, ["[context-cache] first", "[context-cache] other"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. `logger.warnOnce is not a function`.

- [ ] **Step 3: Add `warnOnce` to `createLogger`**

Inside `createLogger`, add `const warned = new Set();` beside the other state, and add this property to the returned object after `debug`:

```js
    /**
     * Always on, independent of the debug flag, and deduplicated. A
     * compatibility failure must be visible without the operator having first
     * guessed to turn debug logging on.
     */
    warnOnce(key, message) {
      if (warned.has(key)) return false;
      warned.add(key);
      emit(message);
      return true;
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 41 tests total.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode-context-cache.mjs test/unit/logger.test.mjs
git commit -m "feat: add an always-on deduplicated operator warning channel

Compatibility failures must not depend on the operator having already
enabled debug logging. The sink is wrapped so a failing stderr cannot
escape into the request path."
```

---

### Task 4: Wire application and warnings into the hook

**Files:**
- Modify: `plugins/opencode-context-cache.mjs` (replace the factory's hook)
- Test: `test/unit/plugin-hook.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a `chat.params` hook that applies the key and reports outcomes.

- [ ] **Step 1: Write the failing test**

Create `test/unit/plugin-hook.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import OpenCodeContextCacheDefault, {
  DEBUG_ENV_VAR,
  EnhancedCachePlugin,
  OpenCodeContextCachePlugin,
  PROMPT_CACHE_KEY_ENV_VAR,
  SCOPE_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  getUsername,
  safeHostname,
} from "../../plugins/opencode-context-cache.mjs";

const SESSION = "ses_" + "b".repeat(64);
const digest = (v) => createHash("sha256").update(v, "utf8").digest("hex");

/** Every plugin-owned env var, so an ambient value cannot silently change a result. */
const OWNED = [PROMPT_CACHE_KEY_ENV_VAR, STICKY_SESSION_ID_ENV_VAR, SCOPE_ENV_VAR, DEBUG_ENV_VAR];

async function withEnv(vars, run) {
  const saved = {};
  for (const key of OWNED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Awaited: restoring at the first suspension point would leak env into
    // the rest of the suite.
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function hookInput(extra = {}) {
  return {
    sessionID: SESSION,
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5", headers: { "x-existing": "keep" } },
    provider: { info: { id: "openai" } },
    ...extra,
  };
}

test("exports the factory under all three names", () => {
  assert.equal(typeof OpenCodeContextCachePlugin, "function");
  assert.equal(EnhancedCachePlugin, OpenCodeContextCachePlugin);
  assert.equal(OpenCodeContextCacheDefault, OpenCodeContextCachePlugin);
});

test("the hook applies the exact digest of user@host:worktree", async () => {
  await withEnv({}, async () => {
    const expected = digest(`${getUsername({ env: process.env })}@${safeHostname()}:/srv/repo`);
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo/pkg/a", worktree: "/srv/repo" });
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, expected);
  });
});

test("the hook never writes conversation headers", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const input = hookInput();
    const before = structuredClone(input.model.headers);
    await hooks["chat.params"](input, { options: { promptCacheKey: SESSION } });
    assert.deepEqual(input.model.headers, before);
    for (const banned of ["x-session-id", "session_id", "conversation_id", "X-Session-Id", "x-session-affinity"]) {
      assert.equal(banned in input.model.headers, false, `must not set ${banned}`);
    }
  });
});

test("the hook tolerates a model with no headers object at all", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const input = hookInput({ model: { providerID: "openai" } });
    await hooks["chat.params"](input, { options: { promptCacheKey: SESSION } });
    assert.equal("headers" in input.model, false, "must not create a headers object");
  });
});

test("the hook leaves a key it did not set", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const output = { options: { promptCacheKey: "operator-choice" } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, "operator-choice");
  });
});

test("the hook adds nothing when core placed no field", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const output = { options: { store: false } };
    await hooks["chat.params"](hookInput(), output);
    assert.deepEqual(output.options, { store: false });
  });
});

test("the hook is inert when scope disables the key", async () => {
  await withEnv({ [SCOPE_ENV_VAR]: "session" }, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, SESSION);
  });
});

test("the hook changes nothing when the session id is missing", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput({ sessionID: undefined }), output);
    assert.equal(output.options.promptCacheKey, SESSION, "provenance unprovable, so nothing may change");
  });
});

test("the hook does not throw on malformed input or output", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
    await hooks["chat.params"](hookInput(), {});
    await hooks["chat.params"](hookInput(), { options: null });
    await hooks["chat.params"]({}, { options: { promptCacheKey: SESSION } });
    await hooks["chat.params"](undefined, { options: { promptCacheKey: SESSION } });
    const hostile = { get sessionID() { throw new Error("hostile getter"); } };
    await hooks["chat.params"](hostile, { options: { promptCacheKey: SESSION } });
  });
});

test("two worktrees yield different keys, independent of process.cwd()", async () => {
  await withEnv({}, async () => {
    const a = await OpenCodeContextCachePlugin({ directory: "/srv/a/sub", worktree: "/srv/a" });
    const b = await OpenCodeContextCachePlugin({ directory: "/srv/b/sub", worktree: "/srv/b" });
    const outA = { options: { promptCacheKey: SESSION } };
    const outB = { options: { promptCacheKey: SESSION } };
    await a["chat.params"](hookInput(), outA);
    await b["chat.params"](hookInput(), outB);
    assert.notEqual(outA.options.promptCacheKey, outB.options.promptCacheKey);
    assert.notEqual(outA.options.promptCacheKey, digest(`x@y:${process.cwd()}`));
  });
});

test("a nested directory shares the key of its worktree root", async () => {
  await withEnv({}, async () => {
    const root = await OpenCodeContextCachePlugin({ directory: "/srv/a", worktree: "/srv/a" });
    const nested = await OpenCodeContextCachePlugin({ directory: "/srv/a/pkg/deep", worktree: "/srv/a" });
    const outRoot = { options: { promptCacheKey: SESSION } };
    const outNested = { options: { promptCacheKey: SESSION } };
    await root["chat.params"](hookInput(), outRoot);
    await nested["chat.params"](hookInput(), outNested);
    assert.equal(outRoot.options.promptCacheKey, outNested.options.promptCacheKey);
  });
});

test("a missing cache key field warns once per provider, with debug off", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"](hookInput(), { options: {} });
    await hooks["chat.params"](hookInput(), { options: {} });
    await hooks["chat.params"](hookInput({ model: { providerID: "anthropic" } }), { options: {} });
    assert.equal(warnings.length, 2, "one per provider, not one per request");
    assert.match(warnings[0], /openai/);
    assert.match(warnings[1], /anthropic/);
  });
});

test("a foreign key warns once, and a mixed conflict is not hidden", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"](hookInput(), {
      options: { promptCacheKey: SESSION, prompt_cache_key: "theirs" },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /prompt_cache_key/);
  });
});

test("malformed options and a missing session id produce no operator warning", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"](hookInput(), { options: null });
    await hooks["chat.params"](hookInput({ sessionID: undefined }), { options: { promptCacheKey: SESSION } });
    assert.deepEqual(warnings, [], "these are debug-only states, not compatibility failures");
  });
});

test("the deprecated sticky env warns once and its raw value is never logged", async () => {
  await withEnv({ [STICKY_SESSION_ID_ENV_VAR]: "secret-tenant-key" }, async () => {
    const warnings = [];
    await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /deprecated/i);
    assert.match(warnings[0], new RegExp(STICKY_SESSION_ID_ENV_VAR));
    for (const line of warnings) {
      assert.equal(line.includes("secret-tenant-key"), false, "raw override must never be logged");
    }
  });
});

test("an unrecognised scope warns once", async () => {
  await withEnv({ [SCOPE_ENV_VAR]: "sessions" }, async () => {
    const warnings = [];
    await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sessions/);
    assert.match(warnings[0], /worktree/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. The first assertion to break is `the hook applies the exact digest of user@host:worktree`, because the Task 1 hook is a deliberate no-op.

- [ ] **Step 3: Replace the factory**

Replace the whole `OpenCodeContextCachePlugin` definition with:

```js
export const OpenCodeContextCachePlugin = async (input = {}, options = {}) => {
  const env = process.env;
  const logger = createLogger({ env, warn: typeof options?.warn === "function" ? options.warn : undefined });
  const resolved = resolveCacheKey({
    env,
    options,
    worktree: input?.worktree,
    directory: input?.directory,
    user: getUsername({ env }),
    host: safeHostname(),
  });

  if (resolved?.unknownScope) {
    logger.warnOnce(
      "scope",
      `unrecognised ${SCOPE_ENV_VAR} value "${resolved.unknownScope}"; expected one of ` +
        `${SCOPES.join(", ")}. Falling back to worktree scope.`,
    );
  }
  if (resolved?.deprecated) {
    logger.warnOnce(
      "deprecated-env",
      `${STICKY_SESSION_ID_ENV_VAR} is deprecated; use ${PROMPT_CACHE_KEY_ENV_VAR} instead.`,
    );
  }

  if (!resolved) logger.debug("no stable cache key resolved; leaving opencode's session default in place");
  else {
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
      // Everything, including reading the provider label off possibly hostile
      // input, sits inside the try. A cache optimization must never be able to
      // fail the user's request.
      let provider = "unknown";
      try {
        provider = hookInput?.model?.providerID ?? hookInput?.provider?.info?.id ?? "unknown";
        const { appliedFields, foreignFields, reason } = applyCacheKey(output, resolved.value, hookInput?.sessionID);

        if (foreignFields.length > 0) {
          logger.warnOnce(
            `foreign:${provider}:${foreignFields.join(",")}`,
            `provider ${provider} carries a prompt cache key this plugin did not set ` +
              `(${foreignFields.join(", ")}); leaving those fields unchanged.`,
          );
        }
        if (reason === "no-fields") {
          logger.warnOnce(
            `absent:${provider}`,
            `provider ${provider} exposes no prompt cache key field, so none was applied. ` +
              "This is expected for providers that do not support one; if it used to work, " +
              "opencode may have renamed the field.",
          );
          return;
        }
        logger.debug(
          `provider=${provider} applied=[${appliedFields.join(",")}] ` +
            `foreign=[${foreignFields.join(",")}] reason=${reason ?? "none"}`,
        );
      } catch (error) {
        logger.warnOnce(`error:${provider}`, `unexpected error applying cache key: ${error?.stack ?? error}`);
      }
    },
  };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 57 tests total.

- [ ] **Step 5: Verify no header writing survives**

Run: `grep -nE "x-session-id|session_id|conversation_id|model\.headers|x-session-affinity" plugins/opencode-context-cache.mjs`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add plugins/opencode-context-cache.mjs test/unit/plugin-hook.test.mjs
git commit -m "feat: apply the resolved cache key and report outcomes

Wires provenance-checked application into chat.params, warns once per
provider on a missing or foreign field, and keeps debug-only states out
of the operator channel."
```

---

### Task 5: Opt-in opencode contract probe

This is a **contract probe, not a red-green task**: it asserts facts about opencode that the design depends on and that no product change of ours can affect. It may be green the moment it is written. It exists as a compatibility gate: the installed plugin types are 1.18.21 while the binary is 1.18.25, so this design was verified against compiled behavior rather than a published contract. Run it before upgrading opencode.

**Files:**
- Create: `test/integration/probe-plugin.mjs`, `test/integration/plugin-input-contract.test.mjs`

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

- [ ] **Step 2: Write the contract test**

Create `test/integration/plugin-input-contract.test.mjs`. Each test gets its own temp root, its own probe file and an ephemeral port; startup is polled rather than slept on; shutdown is awaited in a `finally` and escalates to `SIGKILL`.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveCacheKey, getUsername, safeHostname } from "../../plugins/opencode-context-cache.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = [process.env.OPENCODE_BIN, join(process.env.HOME ?? "", ".opencode", "bin", "opencode")]
  .filter(Boolean)
  .find((p) => existsSync(p)) ?? null;
const skip = BIN ? false : "no opencode binary found; set OPENCODE_BIN to run this suite";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function makeProject(root, name) {
  const dir = join(root, name);
  mkdirSync(join(dir, "pkg", "deep"), { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
  };
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv });
  cpSync(join(HERE, "probe-plugin.mjs"), join(dir, "probe-plugin.mjs"));
  writeFileSync(
    join(dir, "opencode.jsonc"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["./probe-plugin.mjs"] }, null, 2),
  );
  return dir;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = sleep(5000).then(() => "timeout");
  if ((await Promise.race([exited.then(() => "exited"), timer])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

/** Boot one server, ask it for each directory, and return the probe records. */
async function probe(directories, cwd) {
  const root = mkdtempSync(join(tmpdir(), "ctx-cache-it-"));
  const out = join(root, "probe.jsonl");
  const port = await freePort();
  const stderr = [];
  const child = spawn(BIN, ["serve", "--port", String(port)], {
    cwd,
    env: { ...process.env, CONTEXT_CACHE_PROBE_OUT: out },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (b) => stderr.push(String(b)));
  let exitedEarly = null;
  child.once("exit", (code, signal) => { exitedEarly = `code=${code} signal=${signal}`; });

  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      if (exitedEarly) throw new Error(`opencode exited during startup: ${exitedEarly}\n${stderr.join("")}`);
      if (Date.now() > deadline) throw new Error(`opencode did not become ready\n${stderr.join("")}`);
      const ok = await fetch(`http://127.0.0.1:${port}/app`).then((r) => r.ok).catch(() => false);
      if (ok) break;
      await sleep(250);
    }
    for (const dir of directories) {
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        headers: { "x-opencode-directory": encodeURIComponent(dir) },
      });
      assert.ok(res.ok, `instance request for ${dir} failed with ${res.status}`);
    }
    await sleep(1000);
    const raw = existsSync(out) ? readFileSync(out, "utf8").trim() : "";
    return raw ? raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}

test("one server process gives each project its own PluginInput", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-cache-proj-"));
  try {
    const a = makeProject(root, "alpha");
    const b = makeProject(root, "beta");
    // Serve from a directory that is neither project, so any implementation
    // reading process.cwd() is demonstrably wrong.
    const records = await probe([a, b], root);

    const forA = records.filter((r) => r.worktree === a);
    const forB = records.filter((r) => r.worktree === b);
    assert.equal(forA.length, 1, "expected exactly one plugin invocation for alpha");
    assert.equal(forB.length, 1, "expected exactly one plugin invocation for beta");
    assert.equal(forA[0].cwd, forB[0].cwd, "both invocations share one process cwd");
    assert.notEqual(forA[0].cwd, forA[0].worktree, "process.cwd() is not the project path");

    // The contract that matters: our resolver turns these into distinct keys,
    // where a cwd-based resolver would produce one.
    const keyFor = (r) =>
      resolveCacheKey({
        env: {}, worktree: r.worktree, directory: r.directory,
        user: getUsername({ env: process.env }), host: safeHostname(),
      }).value;
    assert.notEqual(keyFor(forA[0]), keyFor(forB[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree is the VCS root, and a nested session shares the root's key", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-cache-proj-"));
  try {
    const project = makeProject(root, "gamma");
    const nested = join(project, "pkg", "deep");
    const records = await probe([project, nested], root);

    const atRoot = records.find((r) => r.directory === project);
    const atNested = records.find((r) => r.directory === nested);
    assert.ok(atRoot && atNested, "expected an invocation for both the root and the nested directory");
    assert.equal(atNested.hasWorktree, true, "PluginInput.worktree must exist");
    assert.equal(atNested.worktree, project, "worktree must be the git root, not the cwd");
    assert.equal(atNested.vcs, "git");

    const keyFor = (r) =>
      resolveCacheKey({
        env: {}, worktree: r.worktree, directory: r.directory,
        user: getUsername({ env: process.env }), host: safeHostname(),
      }).value;
    assert.equal(keyFor(atRoot), keyFor(atNested), "a nested session must reuse the worktree key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the integration suite**

Run: `npm run test:integration`
Expected: PASS with 2 tests when an opencode binary is present; both reported as skipped otherwise. It may be green on the first run - that is correct for a contract probe.

- [ ] **Step 4: Confirm the unit suite is unaffected**

Run: `npm test`
Expected: still 57 tests. The `test` script names files explicitly, so integration cannot leak in.

- [ ] **Step 5: Commit**

```bash
git add test/integration
git commit -m "test: add an opt-in opencode contract probe

Asserts the two facts this design rests on - one plugin instance per
project, and worktree as the VCS root - against the real binary, and
checks the resolver turns them into distinct keys. Skips when no binary
is installed, so CI stays green."
```

---

### Task 6: CI, README, changelog

**Files:**
- Create: `.github/workflows/test.yml`, `CHANGELOG.md`
- Modify: `README.md` (rewrite)

- [ ] **Step 1: Create the CI workflow**

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

- [ ] **Step 2: Create `CHANGELOG.md`**

```markdown
# Changelog

## 0.2.0

### Breaking

- The plugin no longer writes the `x-session-id`, `conversation_id` or
  `session_id` headers. Those names identify a *conversation*, and a
  project-stable value is wrong in them: on opencode's OpenAI/Codex path,
  `x-session-affinity` keys a WebSocket connection pool whose `busy` and
  `fallback` state would then be shared by every concurrent session in the
  project. opencode core already sends `x-session-affinity` and `X-Session-Id`
  derived from the real session ID. A gateway that parsed the underscore names
  must be reconfigured to read core's headers instead.

### Fixed

- The cache key is derived from `PluginInput.worktree` rather than
  `process.cwd()`. One `opencode serve` process serving several projects
  previously gave all of them the same key.
- `prompt_cache_key` (deepinfra, cerebras) is now handled; previously only the
  camelCase spelling was written, so those providers were unaffected.
- The key is replaced only when it still holds opencode's own session-ID
  default, so an explicit operator setting or another plugin's value is no
  longer overwritten.
- Explicit overrides longer than 64 characters or containing non-printable
  characters are hashed rather than sent verbatim.
- The debug log moved out of the plugin directory to
  `$XDG_STATE_HOME/opencode/context-cache.log`.

### Added

- `OPENCODE_CONTEXT_CACHE_SCOPE` (`worktree` default, `directory`, `session`).
  `session` is a full opt-out.
- `OPENCODE_CONTEXT_CACHE_LOG` to relocate the debug log.
- Always-on, deduplicated operator warnings for compatibility failures.
- A test suite and CI.
```

- [ ] **Step 3: Rewrite `README.md`**

Replace the file. Required content, in order:

1. **Title and one-paragraph summary.** The plugin sets a prompt cache key stable across sessions in one git worktree, replacing opencode's per-session default.
2. **A "Breaking change in 0.2.0" section near the top**, summarising the changelog entry above and linking to `CHANGELOG.md`.
3. **How it works.** Core sets the cache key to the session ID; this plugin replaces that value, and only that value, with `sha256(user@host:<worktree>)`.
4. **Install.** Both routes: npm identifier in the `plugin` array, and copying the single file. Keep the existing warning that the `plugin` entry is required.
5. **Configuration.** A table of all five env vars with defaults, plus the `opencode.jsonc` options form (`["opencode-context-cache", { "scope": "directory" }]`) and the precedence rule: env beats options beats defaults, except `scope: session`, which disables the key outright.
6. **Provider support.** Honest: this sets OpenAI-family `promptCacheKey` / `prompt_cache_key`. Anthropic uses `cache_control` breakpoints and ignores a cache key, so the plugin is inert there and says so once **on stderr**. Remove every "works with ALL providers" claim.
7. **Hashing.** Describe as keeping the local username, hostname and path off the wire. Do not call it privacy: the pre-image space is small enough to enumerate.
8. **Observed impact.** Keep the 97.99% figure, labelled explicitly as a single anecdotal run on one provider with no controlled baseline.
9. **Troubleshooting.** Debug flag, log location, and what each operator warning means.

Delete: the `isSha256Hex` digest-detection bullet, the five-level precedence list (it is three levels now), and every reference to setting session headers.

- [ ] **Step 4: Verify no stale claims survive**

Run: `grep -niE "all providers|privacy|sticky session header" README.md`
Expected: no output.

Run: `grep -niE "conversation_id|x-session-id" README.md`
Expected: matches only inside the "Breaking change" section.

- [ ] **Step 5: Run everything one last time**

Run: `npm test && npm run test:integration`
Expected: 57 unit tests pass; integration passes or skips.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/test.yml README.md CHANGELOG.md
git commit -m "docs: rewrite README, add changelog and CI

Documents the header removal as a breaking change with migration
guidance, drops the all-providers and privacy claims, and labels the
cache hit figure as a single uncontrolled run."
```

---

## Self-Review

**Spec coverage.** 3.1 shape -> Task 1 Step 5. 3.2 resolution, scope, override bounds -> Task 1. 3.3 provenance and replacement -> Task 2. 3.4 hook wiring -> Task 4. 3.5 logging and warning channel -> Tasks 1 and 3. 3.6 error handling -> every row now has a test, listed below. Section 4 unit tests -> Tasks 1-4; hook-level -> Task 4; integration -> Task 5. Section 5 deliverables -> all six tasks, plus `CHANGELOG.md`, which section 6 of the spec requires for the upstream disclosure and the first draft omitted.

**Spec 3.6 error table, row by row.** `hostname()` throws -> Task 1, `safeHostname falls back`. `userInfo()` throws -> Task 1, `getUsername falls back`. Both paths empty -> Task 1, `no usable path yields null`. Options absent/not object -> Task 2 `invalid-options`, Task 4 no-warning test. Neither field present -> Task 2 `no-fields`, Task 4 dedup warning test. Foreign value -> Task 2, Task 4 mixed-conflict test. Value `undefined` -> Task 2. Missing `sessionID` -> Task 2 `missing-session`, Task 4 no-change and no-warning tests. Unsafe override -> Task 1, both overlong and non-printable. Unwritable log -> Task 3, both write and mkdir failure.

**Placeholder scan.** Every code step carries complete code. Task 6 Step 3 specifies README content as required sections; each item states what it must say and what must be deleted, with two grep gates in Step 4.

**Type consistency.** `resolveCacheKey` returns `{raw, value, source, hashed, sensitive, deprecated, unknownScope}` in Task 1 and Task 4 reads exactly those. `applyCacheKey(output, value, sessionID)` returns `{appliedFields, foreignFields, reason}` in Task 2 and is destructured for exactly those in Task 4. `createLogger` exposes `enabled`, `path`, `debug` from Task 1 and gains `warnOnce` in Task 3; Task 4 uses only those four. `getUsername({env, readUserInfo})` and `safeHostname({readHostname})` take option bags in Task 1 and are called that way in Tasks 4 and 5. `readEnv`, `usablePath` and `safeJson` are module-private, defined once each in Task 1.

**Loadability at every commit.** Task 1 ships an inert but valid plugin; Tasks 2 and 3 only add exports; Task 4 replaces the hook body. Task 1 Step 7 checks this explicitly.
