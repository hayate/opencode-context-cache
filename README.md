# opencode-context-cache

An [opencode](https://opencode.ai) plugin that gives your sessions a **prompt
cache key that stays stable across sessions in the same git worktree**, instead
of opencode's default of a fresh key per session.

opencode derives the upstream prompt cache key from the session ID, which is new
every session. That means each new session starts with a cold prompt cache even
when the prompt prefix - system prompt, `AGENTS.md`, tool schemas - is
byte-identical to the last one. This plugin replaces that value, and only that
value, with a digest of your worktree path.

## Breaking change in 0.2.0

**The plugin no longer writes the `x-session-id`, `conversation_id` or
`session_id` headers.** If you run behind a relay or gateway that reads those
underscore-spelled names, reconfigure it to read the headers opencode core
already sends: `x-session-affinity` and `X-Session-Id`, both derived from the
real session ID.

Those header names identify a *conversation*, and a project-stable value is
wrong in them. On opencode's OpenAI/Codex path, `x-session-affinity` keys a
WebSocket connection pool with per-conversation `busy` and `fallback` state, so
a per-project value would make every concurrent session in a project share one
socket, and would let one oversized message disable the fast path for all of
them.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## How it works

1. opencode core sets the prompt cache key to the current session ID.
2. This plugin's `chat.params` hook replaces that value with
   `sha256("<user>@<host>:<worktree>")`.
3. It replaces the value **only if it still equals the session ID**. Anything
   else - your own setting, a model or agent option, another plugin's value - is
   left untouched.

That last rule is what makes the plugin provider-agnostic without carrying a
provider table: it only ever overwrites opencode's own output, so opencode's
decision about *whether* a given provider gets a cache key, and under which
spelling, is inherited for free.

## Install

### From npm

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-context-cache"]
}
```

### By copying the file

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/opencode-context-cache.mjs ~/.config/opencode/plugins/
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugins/opencode-context-cache.mjs"]
}
```

For the global config at `~/.config/opencode/opencode.jsonc`, a `./plugins/...`
path resolves relative to `~/.config/opencode/`.

**The `plugin` entry is required either way.** Dropping the file into a plugins
directory does not load it. Restart opencode after editing the config.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `OPENCODE_CONTEXT_CACHE_SCOPE` | `worktree` | `worktree`, `directory`, or `session`. |
| `OPENCODE_PROMPT_CACHE_KEY` | unset | Use this exact key instead of a derived one. |
| `OPENCODE_STICKY_SESSION_ID` | unset | Deprecated alias for the above. Warns once. |
| `OPENCODE_CONTEXT_CACHE_DEBUG` | unset | `1` or `true` enables the debug log. |
| `OPENCODE_CONTEXT_CACHE_LOG` | `$XDG_STATE_HOME/opencode/context-cache.log` | Debug log location. |

The same settings can come from the config file:

```jsonc
{
  "plugin": [["opencode-context-cache", { "scope": "directory" }]]
}
```

**Precedence:** environment variables beat plugin options, which beat defaults.
The one exception is `scope: session`, which is parsed first and disables the
plugin's key outright, even if an explicit key is set. It is the opt-out switch,
so a forgotten `OPENCODE_PROMPT_CACHE_KEY` must not be able to defeat it.

### Choosing a scope

`worktree` shares one key across every session inside a checkout, which is where
the reuse is - subdirectories of one repo have identical system prompts and tool
schemas. Separate git worktrees get separate keys, since they hold different
branches.

Narrow to `directory`, or opt out with `session`, if you run many concurrent
sessions with genuinely different prompt prefixes in one repo, or if your
provider treats this field as a cache *lookup* key rather than a routing hint
(DeepInfra documents it that way and suggests a per-session value).

## Provider support

This sets the OpenAI-family fields `promptCacheKey` and `prompt_cache_key`. It
applies wherever opencode itself sets one: OpenAI, Azure, xAI, Mistral, Venice,
DeepInfra, Cerebras, opencode's own provider, and anything you enable with
`setCacheKey: true`.

It does **not** apply to Anthropic, which caches via `cache_control` breakpoints
on message content and ignores a cache key entirely. With an Anthropic provider
the plugin is inert and says so once on stderr.

## About the hashing

The key is hashed so your local username, hostname and absolute path do not
travel to whatever gateway you use. That is all it is for. It is not a privacy
control: the pre-image is `user@host:/path`, and anyone who knows your username
and hostname can enumerate candidate paths cheaply.

An explicit `OPENCODE_PROMPT_CACHE_KEY` is passed through verbatim, since you
chose it - unless it exceeds 64 characters or contains non-printable characters,
in which case it is hashed so the provider cannot reject it.

## Observed impact

One run on one provider reported a 97.99% input cache hit rate
(`164736 / 168112` tokens) after enabling a stable key, against a near-zero
baseline before it.

Treat that as an anecdote, not a benchmark: it is a single uncontrolled
observation, with no matched workload and no repetition, and the gain depends
entirely on how much of your prompt prefix is actually stable between sessions.

## Troubleshooting

Set `OPENCODE_CONTEXT_CACHE_DEBUG=1` and read the log (path in the table above).
A working setup logs the resolved key source at startup and one line per
request naming the fields it applied.

Two warnings go to stderr regardless of the debug flag, once each:

- **"exposes no prompt cache key field"** - opencode placed no cache key field
  for this provider. Expected for Anthropic and anything else that does not use
  one. If it used to work and now does not, opencode may have renamed the field.
- **"carries a prompt cache key this plugin did not set"** - something else set
  the key first, and the plugin left it alone. Check for a conflicting
  `providerOptions` entry or another plugin.

If nothing is logged at all, the plugin is not loaded: check the `plugin` entry
in your config and restart.

## Development

```bash
npm test              # unit suite, no dependencies to install
npm run test:integration   # opt-in; needs a local opencode binary, else skips
```

The integration suite is a compatibility gate against the real opencode binary.
Run it before upgrading opencode: it asserts the two facts this plugin depends
on, that the plugin factory is invoked once per project and that
`PluginInput.worktree` is the VCS root.

## License

MIT. See [LICENSE](LICENSE).
