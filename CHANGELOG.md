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

  The plugin also previously wrote `x-session-id` while core writes
  `X-Session-Id`. Those are distinct keys in a JavaScript object and only
  collapse at the HTTP layer, so both values were reaching the wire.

### Fixed

- The cache key is derived from `PluginInput.worktree` rather than
  `process.cwd()`. One `opencode serve` process serving several projects
  previously gave all of them the same key, because the plugin factory is
  invoked per project while `process.cwd()` stays the server's launch
  directory.
- `prompt_cache_key` (deepinfra, cerebras) is now handled. Only the camelCase
  spelling was written before, so those providers were unaffected by the plugin.
- The key is replaced only when it still holds opencode's own session-ID
  default, so an explicit operator setting, a model or agent option, or another
  plugin's value is no longer overwritten.
- Explicit overrides longer than 64 characters or containing non-printable
  characters are hashed rather than sent verbatim.
- A degenerate `/` worktree falls back to the session directory, mirroring
  opencode's own guard, instead of collapsing every project onto one key.
- The debug log moved out of the plugin directory to
  `$XDG_STATE_HOME/opencode/context-cache.log`, so the documented
  `./plugins/...` install no longer writes a log file into your repository.

### Added

- `OPENCODE_CONTEXT_CACHE_SCOPE` (`worktree` default, `directory`, `session`).
  `session` is a full opt-out and takes precedence over an explicit key.
- `OPENCODE_CONTEXT_CACHE_LOG` to relocate the debug log.
- Plugin `options` support, so scope and key can be set from `opencode.jsonc`.
  Environment variables take precedence over options.
- Always-on, deduplicated operator warnings for compatibility failures, so a
  renamed upstream field surfaces without the debug flag being on first. A
  provider that simply has no cache key field is **not** one of those failures
  and is silent: Anthropic and every `@ai-sdk/openai-compatible` provider
  (DeepSeek among them) have no such setting, so warning there would fire on a
  routine configuration and teach operators to tune out the channel. That case
  is recorded in the debug log as `reason=no-fields`.
- A README section stating exactly which providers the plugin does and does not
  affect, so its scope is knowable without reading the source.
- A `package.json`, so the plugin can be installed by npm identifier.
- A test suite and CI.

### Removed

- The "digest detection to avoid double-hashing" behavior, which could never
  fire: it was only reachable from a precedence level that was itself
  unreachable. Explicit overrides are now used verbatim when they are safe.
