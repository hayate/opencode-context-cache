# Design: stable prompt cache key, without conversation-identity headers

Date: 2026-08-30
Status: approved, pending adversarial review
Branch: `rework-cache-key-and-headers`

## 1. Problem

opencode derives the upstream prompt cache key from the opencode session ID.
From the shipped binary (`~/.opencode/bin/opencode`):

```js
if ($.providerOptions?.setCacheKey !== false) {
  if ($.model.api.npm === "@ai-sdk/deepinfra" || $.model.api.npm === "@ai-sdk/cerebras")
    Z.prompt_cache_key = $.sessionID;
  else if ($.model.api.npm === "@ai-sdk/openai" || "@ai-sdk/azure" || "@ai-sdk/xai"
        || "@ai-sdk/mistral" || "venice-ai-sdk-provider" || $.providerOptions?.setCacheKey === true)
    Z.promptCacheKey = $.sessionID;
}
```

A session ID is new on every session, so every new session starts with a cold
prompt cache even when the prompt prefix (system prompt, AGENTS.md, tool
schemas) is byte-identical to the previous one. Pinning the key to something
stable per project is the correct fix, and is the premise this plugin was
forked for.

## 2. What the current implementation gets wrong

### 2.1 It conflates two identities that need opposite lifetimes

The plugin derives one value and writes it to both the prompt cache key and to
three conversation-identity headers (`x-session-id`, `conversation_id`,
`session_id`).

Those are not the same kind of identifier:

- A prompt cache key is a **routing hint**. A stale or over-broad value can
  only cause a cache miss. Sharing it widely is safe and is the entire win.
- A session/conversation ID keys **mutable server-side state**. Sharing it
  across concurrent sessions is a correctness bug.

The consuming code in opencode settles it. `x-session-affinity` keys a
WebSocket connection pool:

```js
let N = A["x-session-affinity"] ?? A["session-id"];
if (!N) return Z(H, O);
let V = `${N}:conversation`;
let D = Q.get(V) ?? { lastUsedAt: Date.now(), busy: false, fallback: false, streamFailures: 0 };
if (D.fallback) return Z(H, O);
if (D.busy)     return Z(H, O);
D.busy = true;
D.socket = await NA(D, ...);
```

Pinning a conversation identity to a per-directory constant would therefore:

1. Force every concurrent session in one project through a single socket. The
   second concurrent request observes `busy` and silently drops to the slower
   HTTP fallback path.
2. Let one oversized message in any session set the sticky `fallback` flag for
   the whole directory (`MESSAGE_TOO_BIG_CLOSE_CODE` sets `D.fallback = true`),
   degrading every other session sharing that key rather than only its own.

**Decision: the plugin stops writing conversation-identity headers entirely.**
It sets only the prompt cache key.

### 2.2 The headers it writes collide with core's

Core assembles outbound headers as:

```js
headers: {
  ...providerID.startsWith("opencode")
    ? { "x-opencode-session": e.sessionID, ... }
    : { "x-session-affinity": e.sessionID, "X-Session-Id": e.sessionID, "User-Agent": _i },
  ...e.parentSessionID ? { "x-parent-session-id": e.parentSessionID } : {},
  ...e.model.headers,
  ...g
}
```

Core writes `X-Session-Id`; the plugin writes `x-session-id`. In a JS object
spread these are distinct keys, so both survive into the request and only
collapse at the HTTP layer, yielding either a comma-joined value or
last-write-wins depending on the runtime. Resolved by 2.1 (we write no
headers), and recorded here so the removal is not re-litigated.

### 2.3 It mutates shared provider state via the wrong hook

The plugin writes to `input.model.headers` inside `chat.params`. That object is
the model entry from the provider registry, not per-request state. opencode
exposes a dedicated `chat.headers` hook whose output is spread *after*
`model.headers`, so `chat.params` header writes are also lower precedence than
core's own (opencode's built-in OpenAI plugin sets `session-id` from
`chat.headers`, which the plugin cannot override from where it sits).

Resolved by 2.1.

### 2.4 The cache key ignores the API and reads `process.cwd()`

`PluginInput` provides the right values:

```ts
type PluginInput = { client, project, directory: string, worktree: string, serverUrl, $ }
```

`getUserHostDirectoryKey()` calls `process.cwd()` instead. Combined with
module-level singletons constructed outside the plugin factory, any deployment
where one server process serves more than one project collapses every project
onto a single cache identity.

### 2.5 Two of five documented precedence levels are unreachable

`getUserHostDirectoryKey()` returns `null` only if `hostname()` or
`process.cwd()` throws. Levels 4 (model headers) and 5 (session ID) are
therefore dead, and `alreadyHashed` is only ever set in level 4, so the
advertised "digest detection to avoid double-hashing" can never fire.

### 2.6 Overstated claims

- "Works with ALL providers" - the mechanism is OpenAI-family only. Anthropic
  caching uses `cache_control` breakpoints on content blocks and ignores a
  cache key entirely.
- "SHA256 hashed cache key for privacy" - the pre-image is
  `user@host:/absolute/path`. Given username and hostname, candidate paths are
  trivially enumerable. This is obfuscation, not privacy.
- `97.99%` is a single anecdotal run with no stated baseline methodology.

### 2.7 Minor

- `ensureLogDirectory()` creates the dirname of a file inside `__dirname`,
  which necessarily already exists. It is a no-op.
- The log file is written beside the plugin, so the README's own
  `"./plugins/..."` install example writes it into the user's repository. The
  repo ships no `.gitignore`.
- No `package.json`, so the plugin cannot be installed by npm identifier, which
  is how opencode's `plugin` config array normally references plugins.
- No tests, no CI.

## 3. Design

### 3.1 Shape

The plugin remains a **single self-contained `.mjs` file**. Upstream's install
path is "copy this one file into your plugins directory"; splitting into a
`src/` tree would break it. The file exports its pure functions as named
exports so tests import them directly.

All state is constructed inside the plugin factory. No module-level mutable
state.

### 3.2 Key resolution (pure)

```
resolveCacheKey({ env, worktree, directory, user, host })
  -> { raw, value, source } | null
```

`raw` is the pre-image, used only in debug logs. `value` is what is sent
upstream: equal to `raw` for explicit overrides, and `sha256(raw)` for the
generated key.

Precedence:

| # | Source | Hashed? |
|---|--------|---------|
| 1 | `OPENCODE_PROMPT_CACHE_KEY` | no, used verbatim |
| 2 | `OPENCODE_STICKY_SESSION_ID` (compat, logged as deprecated) | no, used verbatim |
| 3 | `user@host:<worktree \|\| directory>` | sha256 |
| 4 | none available | returns `null`, plugin no-ops |

Two changes from upstream:

- **Explicit overrides are never hashed.** The operator chose that string; they
  get that string. This deletes the `isSha256Hex` digest-sniffing branch.
- **Level 4 is reachable.** opencode can pass `worktree: ""` (observed in the
  binary: `worktree:"",directory:j.directory??""`), so "no key available" is a
  real state with a real test, not dead code.

Scope is the **worktree**, falling back to `directory` when empty. All sessions
inside one checkout share a key, which is where the reuse is: the system
prompt, AGENTS.md/CLAUDE.md and tool schemas are identical across
subdirectories. Separate git worktrees get separate keys, which is correct
since they hold different branches. An over-broad key can only cause a miss,
never a correctness bug, now that no mutable state hangs off it.

Hashing is retained for the auto-generated key only, on the honest rationale
that it keeps the local username, hostname and home directory layout from
reaching a third-party gateway.

### 3.3 Applying the key

```
applyCacheKey(options, key) -> boolean   // mutates `options` in place, returns whether it applied
```

```js
if ("promptCacheKey"   in options) { options.promptCacheKey   = key; applied = true }
if ("prompt_cache_key" in options) { options.prompt_cache_key = key; applied = true }
```

**Only replace a field core already placed.** This inherits core's entire
provider table and opt-in logic rather than duplicating a table that will drift
as opencode adds providers:

- `setCacheKey: false` is respected automatically - core places no field, so we
  place none.
- `setCacheKey: true` on an exotic relay makes core place `promptCacheKey`, and
  we swap in the stable value.
- deepinfra and cerebras get `prompt_cache_key`, which upstream misses entirely
  by hardcoding the camelCase name.

This depends on core populating `output.options` before triggering the hook,
which is verified:

```js
plugin.trigger("chat.params",
  { sessionID, agent, model, provider, message },
  { temperature, topP, topK, maxOutputTokens, options: d })
```

If that ever changes, the plugin degrades to doing nothing rather than to doing
something wrong. `applyCacheKey` returns whether it applied, and the hook logs
a warning when it did not, so the degradation is visible rather than silent.

### 3.4 Hook wiring

```js
export const OpenCodeContextCachePlugin = async ({ directory, worktree }) => {
  const logger = createLogger({ env: process.env });
  const resolved = resolveCacheKey({ env: process.env, directory, worktree,
                                     user: getUsername(), host: safeHostname() });
  // ... log resolution outcome once
  return {
    "chat.params": async (_input, output) => {
      if (!resolved) return;
      if (!applyCacheKey(output.options, resolved.value)) logger.warn(...);
    },
  };
};
export const EnhancedCachePlugin = OpenCodeContextCachePlugin;  // compat
export default OpenCodeContextCachePlugin;
```

The key is resolved once per plugin instance rather than per request:
`directory` and `worktree` are fixed for the life of an instance.

### 3.5 Logging

- Default path `${XDG_STATE_HOME:-~/.local/state}/opencode/context-cache.log`,
  overridable via `OPENCODE_CONTEXT_CACHE_LOG`.
- Enabled by `OPENCODE_CONTEXT_CACHE_DEBUG` in `{1, true}`.
- `ensureLogDirectory` becomes real (`mkdir -p` on a directory that may not exist).
- On write failure: emit exactly one stderr warning naming the path and the
  error, then disable logging. Not silent, and not TUI-spamming.

### 3.6 Error handling

| Condition | Behavior |
|---|---|
| `hostname()` throws | fall back to `"unknown-host"`; key still stable per machine-user-path |
| `userInfo()` throws | fall back to `USER`/`USERNAME`/`LOGNAME`, then `"unknown"` |
| `worktree` and `directory` both empty | resolve to `null`; hook no-ops; core's session-ID default stands |
| `output.options` absent or not an object | no-op; log a warning |
| neither cache key field present | no-op; log a warning naming the provider |
| log file unwritable | one stderr warning, then logging disabled |

The plugin never throws out of the hook. A cache-key optimization must not be
able to fail a user's request.

## 4. Testing

`node --test`, zero devDependencies, so CI runs with no install step.

**`resolveCacheKey`**
- each precedence level selects the expected source
- `OPENCODE_PROMPT_CACHE_KEY` wins over `OPENCODE_STICKY_SESSION_ID`
- explicit overrides are returned verbatim, not hashed
- whitespace-only env values are ignored, not treated as a key
- auto key is sha256 of `user@host:path`
- worktree preferred over directory; directory used when worktree is `""`
- returns `null` when both are `""`
- deterministic across calls; differs across differing user, host, or path

**`applyCacheKey`**
- replaces `promptCacheKey` when present
- replaces `prompt_cache_key` when present
- replaces both when both present
- adds nothing when neither is present, and returns `false`
- leaves unrelated options untouched

**Plugin factory (regression tests for the bugs found)**
- two instances built with different worktrees produce different keys
  (upstream's `process.cwd()` plus module singletons produce the same key here)
- `input.model.headers` is deeply unchanged after the hook runs
- `output.options` gains no new key when core placed none
- the hook does not throw when `output.options` is missing

**Logger**
- disabled by default
- writes when enabled
- an unwritable path produces one warning and does not throw

## 5. Deliverables

- rewritten `plugins/opencode-context-cache.mjs`
- `test/*.test.mjs`
- `package.json` (`type: module`, `scripts.test`, `files`, exports)
- `.gitignore` (log file, `node_modules`)
- `.github/workflows/test.yml`
- README rewritten: drop "all providers" and "privacy" claims, reframe the
  97.99% figure as one anecdotal run, document the removal of header writing
  and why

## 6. Upstream

Two pull requests. The fork gets the change directly. Upstream gets a PR whose
body leads with the `x-session-affinity` connection-pool evidence, since it
asks the maintainer to accept the removal of an advertised feature.

## 7. Explicitly out of scope

- Anthropic `cache_control` breakpoint injection. That is a different mechanism
  with a different hook surface and a different failure mode; folding it in
  would destabilize this change.
- Publishing to npm. `package.json` makes it installable; the publish decision
  is the maintainer's.
