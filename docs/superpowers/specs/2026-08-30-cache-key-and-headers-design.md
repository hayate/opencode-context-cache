# Design: stable prompt cache key, without conversation-identity headers

Date: 2026-08-30
Status: approved; revised after two Codex adversarial reviews (see section 8)
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

One demonstrated consumer makes the cost concrete. On opencode's built-in
OpenAI/Codex path, `x-session-affinity` keys a WebSocket connection pool:

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

On that path, pinning a conversation identity to a per-directory constant
would:

1. Force every concurrent session in one project through a single socket. The
   second concurrent request observes `busy` and silently drops to the slower
   HTTP fallback path.
2. Let one oversized message in any session set the sticky `fallback` flag for
   the whole directory (`MESSAGE_TOO_BIG_CLOSE_CODE` sets `D.fallback = true`),
   degrading every other session sharing that key rather than only its own.

This pool is **not** universal - it does not establish behavior for Azure, xAI,
Mistral, DeepInfra, Cerebras, or third-party relays. It is an existence proof
that the cost is real, not the whole argument. The general argument is that
these header names mean "this conversation", so a project-stable value is
semantically wrong in them whoever consumes it, and core already sends
`x-session-affinity` and `X-Session-Id` derived from the real session ID, which
makes the plugin's versions redundant where they are understood at all.

**Decision: the plugin stops writing conversation-identity headers entirely.**
It sets only the prompt cache key.

**This is a breaking change.** The current README advertises sticky-session
headers for relay/gateway use, including the non-standard `conversation_id` and
`session_id` names. A gateway parsing those underscore names loses them. This
must be called out in the README, the changelog and the upstream PR rather than
shipped quietly; the replacement guidance is that core's own
`x-session-affinity` / `X-Session-Id` already carry per-session identity.

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

`getUserHostDirectoryKey()` calls `process.cwd()` instead.

This was verified empirically rather than inferred. A probe plugin recording its
`PluginInput`, loaded into one `opencode serve` process started from
`/home/andrea` and then asked for two separate projects, produced:

```
--- invocation 1 ---            --- invocation 2 ---
  directory: .../probe            directory: .../probe2
  worktree:  .../probe            worktree:  .../probe2
  cwd:       /home/andrea         cwd:       /home/andrea
```

So the factory is invoked once per project with correct per-project values,
while `process.cwd()` is the server's launch directory for both. Upstream
therefore computes the identical key `andrea@host:/home/andrea` for two
unrelated projects, collapsing them onto one cache identity. The same probe
confirms `worktree` is populated and is the VCS root, and that a session started
in a nested subdirectory reports that subdirectory as `directory` while still
reporting the repo root as `worktree`.

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
`src/` tree would break it.

**The file must export exactly one value: the plugin factory.** This is a hard
constraint imposed by opencode's loader, discovered by running the plugin under
a real opencode rather than by any review or test. For a file-path plugin,
opencode walks `Object.values(module)`:

```js
function Gy(x){ if (typeof x === "function") return x;
                if (!x || typeof x !== "object" || !("server" in x)) return;
                if (typeof x.server !== "function") return;  return x.server }
function Wy(m){ const seen = new Set(), out = [];
                for (const x of Object.values(m)) {
                  if (seen.has(x)) continue; seen.add(x);
                  const f = Gy(x);
                  if (!f) throw TypeError("Plugin export is not a function");
                  out.push(f); }
                return out }
```

Two consequences. A single non-function export - one exported constant - makes
opencode refuse the **entire plugin**. And every distinct exported *function* is
then invoked as a plugin factory with `(PluginInput, options)`, so an exported
`sha256` would be called as `sha256(pluginInput, options)` and its return value
treated as a hooks object. The `{ server }` module shape does not help here; that
path is only taken for npm-package plugins.

Helpers therefore hang off the factory as a frozen `internals` property, which
`Object.values` does not see, and tests reach them there. The three exports
(`OpenCodeContextCachePlugin`, `EnhancedCachePlugin`, `default`) are deliberately
the same function object, which the loader's `Set` deduplicates into one plugin.
`test/unit/export-shape.test.mjs` reproduces the check above so this cannot
regress.

Note what happened here: exporting the helpers was itself the fix for an earlier
review finding about testability. It made the plugin unloadable while all 57
tests stayed green, because tests import a module the way the test needs it, not
the way the host does.

All state is constructed inside the plugin factory, and the factory body is
wrapped so that an unexpected startup failure yields an inert plugin rather than
a rejected promise that fails the load. No module-level mutable state.

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

- **Explicit overrides are used verbatim when safe.** The operator chose that
  string; they get that string. This deletes the `isSha256Hex` digest-sniffing
  branch. "Safe" means at most 64 characters and printable ASCII: OpenAI is
  reported to cap `prompt_cache_key` at 64 characters (not verified against a
  live API here, so treated as a cheap defensive bound rather than an
  established fact), and a sha256 hex digest is exactly 64. An override that
  exceeds the bound or carries non-printable characters is hashed instead, and
  the substitution is logged, so the plugin can never emit a value the provider
  will reject.
- **Level 4 is reachable.** opencode can pass `worktree: ""` (observed in the
  binary: `worktree:"",directory:j.directory??""`), so "no key available" is a
  real state with a real test, not dead code.

Scope is the **worktree**, falling back to `directory` when the worktree is
empty or `"/"`. That guard mirrors opencode's own, which picks a project path
with `e.vcs === "git" && e.worktree !== "/" ? e.worktree : e.directory` - a
degenerate `/` worktree would otherwise collapse every project on the machine
onto a single key, which is the exact bug class this change exists to fix. All sessions
inside one checkout share a key, which is where the reuse is: the system
prompt, AGENTS.md/CLAUDE.md and tool schemas are identical across
subdirectories. Separate git worktrees get separate keys, which is correct
since they hold different branches.

An over-broad key is low-risk but not risk-free, and the earlier draft of this
spec overclaimed by calling it "never a correctness bug". Two qualifications:

- For OpenAI, `prompt_cache_key` is a routing hint and exact prefix matching
  protects correctness, so the failure mode is degraded hit rate rather than
  wrong output. But concurrent agents in one worktree can hold unrelated system
  prompts and tool sets, and OpenAI's own guidance is to split a busy group when
  hit rate degrades. Cache thrash under concurrency is a real cost.
- DeepInfra documents `prompt_cache_key` as an explicit KV-cache lookup key and
  suggests a per-session value. That is a stronger contract than "routing hint",
  and this design cannot claim universal safety across every backend and relay
  implementing the field.

Mitigation: scope is configurable via `OPENCODE_CONTEXT_CACHE_SCOPE`, or the
`scope` key of the plugin's `options` object in `opencode.jsonc`, taking
`worktree` | `directory` | `session` and defaulting to `worktree`. Operators
running many concurrent divergent sessions, or a provider with lookup-key
semantics, can narrow it without patching the plugin.

`session` resolves to `null` so core's own per-session default stands
untouched, and **it is parsed before the explicit overrides, so it beats them**.
It is the safety valve for a provider whose cache key carries stronger
semantics than routing, and a safety valve a forgotten stale
`OPENCODE_PROMPT_CACHE_KEY` can silently defeat is not one. An unrecognised
scope value warns once and falls back to `worktree` rather than silently
widening scope.

Hashing is retained for the auto-generated key only, on the honest rationale
that it keeps the local username, hostname and home directory layout from
reaching a third-party gateway.

### 3.3 Applying the key

```
applyCacheKey(output, key, sessionID)
  -> { appliedFields: string[],
       foreignFields: string[],
       emptyFields:   string[],
       reason: "invalid-options" | "missing-session" | "no-fields" | null }
```

A three-value return cannot express "replaced one field and found the other
foreign", and collapsing malformed options, a missing session ID and a genuinely
absent field into one value makes the operator warning lie about which happened.
The result is therefore a record, and **every distinguished state gets its own
accurate warning**.

An earlier revision of this spec drew the wrong conclusion here: it made
`invalid-options` and `missing-session` debug-only. That is backwards. Those two
states cannot occur against a correct opencode, so when they do occur the shape
upstream has changed and the plugin is permanently inert - prompt caching has
silently reverted to a per-session key, the exact regression this plugin exists
to prevent. Meanwhile `no-fields` warns, and it is the *benign* case (an
Anthropic user, working as designed). Loud on the expected, silent on the
unprecedented.

The original finding was that a coarse return made the message *lie about which
state occurred*. The fix for that is to distinguish the states, which the record
does. Silence was never the required consequence.

`emptyFields` exists for the same reason: a field present but `undefined` or
`null` was not set by a third party, and telling the operator that "something
else set your key" sends them hunting for a conflicting plugin that does not
exist.

Replace a cache-key field **only when its current value is provably the one
core just put there**. Core's default is the session ID:

```js
Z.prompt_cache_key = $.sessionID;                      // deepinfra, cerebras
Z.promptCacheKey   = $.sessionID;                      // openai, azure, xai, mistral, venice, setCacheKey:true
Z.promptCacheKey   = /^ses_[0-9a-f]{64}$/.test(id) ? id.slice(4) : id;   // opencode zen path
```

so the provenance test is exact:

```js
const isCoreDefault = (v) => v === sessionID || v === stripSesPrefix(sessionID);
```

For each of `promptCacheKey` and `prompt_cache_key` independently: if absent,
skip. If present and `isCoreDefault`, replace and record it in `appliedFields`.
If present and anything else, leave it alone and record it in `foreignFields`.
Per-field accounting matters: a request carrying core's value in one spelling and
a third party's in the other is a real conflict, and reporting only an aggregate
would hide it behind the successful half.

An earlier draft used bare presence (`"promptCacheKey" in options`) as the
signal. That is wrong, and the adversarial review was right to reject it:
presence does not prove core set the value. Model, agent or variant options can
carry the field; a plugin ordered before this one can add it; a merge can leave
it present with value `undefined`. Overwriting on presence alone would defeat an
explicit operator setting and make behavior depend on plugin order.

Matching against the session ID fixes that precisely, and keeps the property
that made the presence check attractive in the first place: no provider table to
duplicate and no drift as opencode adds providers. It inherits core's entire
opt-in decision tree, because we only ever replace core's own output.

- `setCacheKey: false` -> core writes nothing -> nothing to match -> we skip.
- `setCacheKey: true` on a relay -> core writes the session ID -> we replace it.
- deepinfra/cerebras -> core writes `prompt_cache_key` -> we replace that name,
  which upstream misses entirely by hardcoding the camelCase spelling.
- A user or plugin set their own key -> not the session ID -> untouched.

**Replacement, not in-place mutation.** `output.options` is reassigned to a new
object rather than mutated:

```js
output.options = { ...options, ...replacements };
```

The review established that core builds a fresh options object per request via a
non-mutating merge, so in-place mutation would be safe today. Replacement is
kept anyway because it is free and stays correct if that ever changes: `_y()`
returns `Object.values(model.variants)[0]` directly on its fallthrough path, and
nothing in the plugin should be one refactor away from writing a cache key into
shared model config. That is the same bug class as upstream's `model.headers`
mutation, and it is not worth being clever about.

This depends on core populating `output.options` before triggering the hook,
which is verified - `Plugin.trigger` passes the caller's output object straight
through to every hook and returns it unchanged:

```js
J = y.fn("Plugin.trigger")(function*(W, K, U) {
  if (!W) return U;
  for (let z of (yield* c0.get(X)).hooks) { let M = z[W]; if (!M) continue;
    yield* y.promise(async () => M(K, U)); }
  return U;
})
```

If that ever changes, the plugin degrades to doing nothing rather than to doing
something wrong.

### 3.4 Hook wiring

```js
export const OpenCodeContextCachePlugin = async ({ directory, worktree }) => {
  const logger = createLogger({ env: process.env });
  const resolved = resolveCacheKey({ env: process.env, directory, worktree,
                                     user: getUsername(), host: safeHostname() });
  // ... log resolution outcome once
  return {
    "chat.params": async (input, output) => {
      if (!resolved) return;
      const outcome = applyCacheKey(output, resolved.value, input?.sessionID);
      report(outcome, input);   // debug log always; one deduped operator warning, see 3.5
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
  error, then disable file logging. Not silent, and not TUI-spamming.

**Operator-visible warnings are a separate channel from the debug log.** The
earlier draft claimed compatibility failures would be "visible rather than
silent" while routing them through the debug-gated logger, which means silent by
default - the review was right to call that a silent failure. A future opencode
field rename could disable the plugin indefinitely with nobody noticing.

So: a `console.warn` fires independently of `OPENCODE_CONTEXT_CACHE_DEBUG`,
**deduplicated to at most one per (plugin instance, provider, category)**, for:

- `absent`  - a key was resolved but neither cache-key field was present. Names
  the provider and states that this is expected for providers that do not use a
  prompt cache key, so an Anthropic user sees one informative line, once, and a
  field rename is still surfaced.
- `foreign` - a field was present but held a value that was not core's default,
  so it was left alone. Names what was found, so an operator can tell a
  deliberate override from a conflict.

Per-request detail stays in the debug log. Nothing warns per request.

### 3.6 Error handling

| Condition | Behavior |
|---|---|
| `hostname()` throws | fall back to `"unknown-host"`; key still stable per machine-user-path |
| `userInfo()` throws | fall back to `USER`/`USERNAME`/`LOGNAME`, then `"unknown"` |
| `worktree` and `directory` both empty | resolve to `null`; hook no-ops; core's session-ID default stands |
| `output.options` absent or not an object | no-op; one deduped warning naming a possible upstream shape change |
| neither cache key field present | no-op; one deduped operator warning (`absent`) |
| field present, value is not core's default | leave it; one deduped operator warning (`foreign`) |
| field present with value `undefined` or `null` | leave it; one deduped `empty` warning, distinct from `foreign` |
| `input.sessionID` missing | no replacement; one deduped warning naming a possible upstream rename |
| no path derivable from `PluginInput` | inert; one deduped warning (distinct from a `scope: session` opt-out, which is silent) |
| `user` or `host` fell back to a placeholder | key still set; one deduped warning that the key is not machine-unique |
| `providerID` is not a string | coerced to `"unknown"`; never interpolated raw |
| anything throws inside the factory | plugin loads inert rather than failing to load |
| explicit override >64 chars or non-printable | hashed instead, substitution logged |
| log file unwritable | one stderr warning, then file logging disabled |

The plugin never throws out of the hook. A cache-key optimization must not be
able to fail a user's request.

## 4. Testing

`node --test`, zero devDependencies, so CI runs with no install step.

The review's sharpest criticism of the first draft was that most listed tests
would pass an implementation whose hook never runs. Unit tests of the pure
helpers are necessary but not sufficient; the suite must drive the real exported
factory and the hook it returns.

**`resolveCacheKey` (pure)**
- each precedence level selects the expected source
- `OPENCODE_PROMPT_CACHE_KEY` wins over `OPENCODE_STICKY_SESSION_ID`
- safe explicit overrides returned verbatim, not hashed
- an override >64 chars is hashed instead, and reports that it was
- an override with non-printable characters is hashed instead
- whitespace-only env values are ignored, not treated as a key
- auto key is sha256 of `user@host:path`
- worktree preferred; directory used when worktree is `""` or `"/"`
  (mirrors core's own `e.vcs === "git" && e.worktree !== "/"` guard, so a
  degenerate `/` worktree cannot collapse every project onto one key)
- `OPENCODE_CONTEXT_CACHE_SCOPE` of `directory` forces directory scope;
  `session` resolves to `null`
- returns `null` when both paths are empty
- deterministic; differs across differing user, host, or path

**`applyCacheKey` (pure, provenance)**
- replaces `promptCacheKey` when it equals `sessionID`
- replaces `prompt_cache_key` when it equals `sessionID`
- replaces a value equal to the `ses_`-stripped session ID (zen path)
- returns `foreign` and changes nothing when the value is a third party's key
- returns `foreign` and changes nothing when the value is `undefined`
- returns `absent` and adds nothing when neither field is present
- leaves unrelated options untouched
- does not mutate the object it was given (asserts a new object identity)

**Hook-level tests, driving the real factory**

These exist specifically to fail an implementation whose hook never runs or
wires the wrong key.

- factory returns an object exposing `chat.params`
- invoking that hook on an options object seeded with `sessionID` yields exactly
  the key `resolveCacheKey` would have produced for the same `PluginInput` -
  binds the hook to the resolver, so a hook that no-ops or passes a wrong value
  fails
- invoking it with a foreign value leaves the options untouched
- `input.model.headers` is deeply unchanged after the hook runs
- the hook does not throw when `output.options` is missing, when `input` is
  missing, or when `sessionID` is absent
- two factory instances built with different worktrees produce different keys,
  and neither depends on `process.cwd()` (asserted by running the factory from a
  third, unrelated cwd - upstream returns the same key for both here)

**Warning channel**
- `absent` and `foreign` each warn once and then stay quiet across repeated
  hook invocations for the same provider
- warnings fire with `OPENCODE_CONTEXT_CACHE_DEBUG` unset
- the raw value of an explicit override never appears in any log line; only its
  source and a short fingerprint do

**Logger**
- disabled by default; writes when enabled
- an unwritable path produces exactly one warning and does not throw

**Integration, opt-in (`test/integration/`)**

Skipped automatically when no opencode binary is present, so CI stays green;
run locally and before an opencode upgrade as a compatibility gate. This is the
review's requested lifecycle test, and the harness is already proven: a probe
plugin recording its `PluginInput` under `opencode serve`.

- one server process, started from an unrelated cwd, serving two projects:
  asserts the factory is invoked once per project with that project's own
  `directory`/`worktree`, and that the resulting keys differ
- a session started in a nested subdirectory of a repo produces the same key as
  one started at the repo root
- asserts `PluginInput.worktree` is still populated and is the VCS root, which
  is the contract the whole design rests on and the thing most likely to break
  across an opencode upgrade

Note the version skew this guards against: the installed plugin types are
1.18.21 while the binary is 1.18.25, so the compiled behavior this design was
verified against is not fully described by the shipped type definitions.

## 5. Deliverables

- rewritten `plugins/opencode-context-cache.mjs`
- `test/*.test.mjs` and `test/integration/*.test.mjs` (the latter self-skipping
  when no opencode binary is present)
- `package.json` (`type: module`, `scripts.test`, `files`, exports)
- `.gitignore` (log file, `node_modules`)
- `.github/workflows/test.yml`
- README rewritten: drop "all providers" and "privacy" claims, reframe the
  97.99% figure as one anecdotal run, document the removal of header writing as
  a breaking change with migration guidance, and document
  `OPENCODE_CONTEXT_CACHE_SCOPE` and `OPENCODE_CONTEXT_CACHE_LOG`

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

## 8. Adversarial review record

Codex reviewed this spec (job `task-mtflow5i-9oguil`, effort high) against a
seven-point attack list. Recorded here so a later round does not re-derive it.

**Cleared.**

- *Stale key lifetime.* Feared that resolving once per factory invocation goes
  stale if one plugin instance serves several projects or a worktree is
  retargeted. Codex found plugin state is created via `InstanceState.make`, keyed
  by resolved directory; `/experimental/worktree` creates a new directory-backed
  instance and `/experimental/worktree/reset` resets git state within the same
  directory without retargeting. Independently confirmed by the probe in 2.4.
  Factory-time resolution stands. The residual risk - reliance on compiled
  behavior rather than a documented contract, with types at 1.18.21 and the
  binary at 1.18.25 - is addressed by the opt-in integration test in section 4.
- *Shared options object.* Feared in-place mutation could leak into shared model
  config. Codex established core builds a fresh options object per request via a
  non-mutating merge. Replacement is retained anyway as a free hedge (3.3).
- *JSON injection via explicit overrides.* Not a risk; serialization escapes.

**Accepted and folded in.**

- *Presence does not prove provenance* - the strongest finding. Rewrote 3.3 to
  match against `sessionID` instead of testing field presence. Codex proposed a
  maintained provider table or a presence heuristic; the session-ID match is
  better than both, and the finding is what made it visible.
- *Over-broad key claim overstated* - softened in 3.2, with the DeepInfra
  lookup-key semantics and OpenAI cache-thrash concerns recorded, and
  `OPENCODE_CONTEXT_CACHE_SCOPE` added so scope can be narrowed without a patch.
- *Header-removal evidence too narrow* - the WebSocket pool is opencode's
  OpenAI/Codex path, not universal. 2.1 now presents it as an existence proof
  and rests the argument on semantic mismatch plus redundancy with core's own
  headers, and labels the removal a breaking change with migration guidance.
- *Unbounded verbatim overrides* - 64-character and printable-ASCII bound added,
  falling back to hashing (3.2).
- *Raw override in debug logs* - only source plus a short fingerprint is logged
  for explicit overrides (3.5).
- *"Visible rather than silent" routed through a debug-gated logger* - a
  separate, deduplicated, always-on operator warning channel added (3.5).
- *Tests would pass a hook that never runs* - section 4 rewritten around
  hook-level and integration tests.

**Considered and not taken.**

- *Populate conversation headers from per-request `sessionID` instead of
  removing them.* Declined: that option was explicitly weighed and rejected
  before this spec was written, and core already emits `x-session-affinity` and
  `X-Session-Id` from the session ID, so the plugin's versions would duplicate
  core for every consumer that understands them.
- *Provider-specific cache scope with a prompt-version component.* Declined as
  over-engineering for this plugin's purpose, and it reintroduces the provider
  table that 3.3 exists to avoid. The scope env var covers the real need.

### 8.1 Second review: the implementation plan

Codex reviewed the plan (job `task-mtfmc8hc-gsxi9e`, effort high). It confirmed
the first round's findings were folded in, and found that three of them were
folded in *nominally* rather than correctly. Folded in:

- **The tri-state return could not represent the states this spec distinguishes.**
  Malformed options, a missing session ID and a genuinely absent field all
  returned `"absent"`, so the operator warning claimed a provider field had
  disappeared when the real cause was something else. Section 3.3 now returns a
  record. This is the same class of defect as the original presence check: an
  API too narrow to carry the distinction the design depends on.
- **A mixed core/foreign conflict was hidden**, and the plan's test blessed it.
  Per-field accounting added.
- **`scope: session` did not actually opt out**, because explicit overrides were
  parsed first, contradicting this spec's own unqualified claim. Resolved in
  3.2 by parsing scope first.
- **"The hook never throws" was not implemented**: the provider label was read
  outside the `try`, and the warning sink itself could throw, including from
  inside the catch handler.
- **The promised deprecation notice for `OPENCODE_STICKY_SESSION_ID` existed
  only in prose**, with no code and no test.
- **Tasks 1-3 each committed a product that would not load.** The plan now
  requires every commit to leave a loadable plugin, with an explicit check.
- **`node --test test/*.test.mjs` can pass with zero tests.** Codex verified on
  Node 24 that an unmatched quoted glob exits 0 having run nothing, and the glob
  does not expand on Windows at all. Test files are now listed explicitly.
- Smaller: paths were being trimmed (a path may legitimately end in whitespace);
  `withEnv` restored the environment at the first `await` rather than after the
  body; temp directories were never cleaned up; the integration suite used fixed
  ports, fixed sleeps, a shared output file, and never awaited process exit; and
  the plan's claim that every row of the 3.6 error table had a test was false.

Also folded in from that round: the plugin `options` argument, which opencode
really does pass as the second parameter (`J(Z, $.options)`), is now honoured
with env taking precedence over it; and `CHANGELOG.md` is a required deliverable
so the breaking header removal is disclosed somewhere durable rather than only
in a PR description.

Not taken: rewriting the integration probe to drive a live provider. It asserts
the opencode-side contract plus the key our resolver derives from it, which is
the part that can break under an opencode upgrade; asserting provider-side cache
behavior needs credentials and a controlled baseline, and belongs to the
measurement work in section 7, not to a compatibility gate.
