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

const PROMPT_CACHE_KEY_ENV_VAR = "OPENCODE_PROMPT_CACHE_KEY";
const STICKY_SESSION_ID_ENV_VAR = "OPENCODE_STICKY_SESSION_ID";
const SCOPE_ENV_VAR = "OPENCODE_CONTEXT_CACHE_SCOPE";
const DEBUG_ENV_VAR = "OPENCODE_CONTEXT_CACHE_DEBUG";
const LOG_PATH_ENV_VAR = "OPENCODE_CONTEXT_CACHE_LOG";

/** OpenAI is reported to cap prompt_cache_key at 64 characters; a sha256 hex digest is exactly 64. */
const MAX_CACHE_KEY_LENGTH = 64;

const SCOPES = ["worktree", "directory", "session"];

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * Ceiling on distinct warning keys held per plugin instance. The error key
 * embeds the error text so that a second, unrelated failure is not suppressed
 * forever - which means a fault producing a unique message per request would
 * otherwise grow the set without bound in a long-lived server.
 */
const WARNING_KEY_LIMIT = 64;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(value) {
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

function isSafeOverride(value) {
  return value.length <= MAX_CACHE_KEY_LENGTH && PRINTABLE_ASCII.test(value);
}

/** Single source of truth for where a scope setting may come from. */
function scopeSetting(env, options) {
  return readEnv(env, SCOPE_ENV_VAR) || (typeof options?.scope === "string" ? options.scope : "");
}

function parseScope(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "") return { scope: "worktree", unknown: null };
  if (SCOPES.includes(value)) return { scope: value, unknown: null };
  return { scope: "worktree", unknown: value };
}

/**
 * Guards against a degenerate "/" worktree, which would otherwise collapse
 * every project on the machine onto a single key.
 *
 * Core's own project-path helper is `vcs === "git" && worktree !== "/"`. Only
 * the second clause is reproduced here: opencode sets `worktree` to the session
 * directory when there is no VCS, so a non-git project already falls through to
 * the same value, and consulting `project.vcs` would add a branch with no
 * behavioural difference.
 */
function selectScopePath({ scope, worktree, directory }) {
  const tree = usablePath(worktree);
  const dir = usablePath(directory);
  if (scope === "session") return "";
  if (scope === "directory") return dir;
  if (tree && tree.trim() !== "/") return tree;
  return dir;
}

function resolveCacheKey({ env = {}, options = {}, worktree, directory, user, host } = {}) {
  // Scope is parsed first so that `session` is a genuine opt-out: a stale
  // override must not be able to defeat the safety valve.
  const { scope, unknown: unknownScope } = parseScope(scopeSetting(env, options));
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

function getUsername({ env = process.env, readUserInfo = userInfo } = {}) {
  try {
    const info = readUserInfo();
    if (info?.username) return info.username;
  } catch {
    // userInfo throws in some restricted environments; fall through to env.
  }
  return env?.USER || env?.USERNAME || env?.LOGNAME || "unknown";
}

function safeHostname({ readHostname = hostname } = {}) {
  try {
    return readHostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

function safeHomedir({ readHomedir = homedir } = {}) {
  try {
    return readHomedir() || "";
  } catch {
    // homedir throws in the same restricted environments userInfo does: no HOME
    // and a getpwuid that fails, which is an ordinary container setup.
    return "";
  }
}

function defaultLogPath(env = {}, home) {
  const explicit = readEnv(env, LOG_PATH_ENV_VAR);
  // Resolved lazily: as a default parameter this ran on every call, including
  // when an explicit path made it irrelevant.
  if (explicit) return explicit;
  const stateHome = readEnv(env, "XDG_STATE_HOME") || join(home ?? safeHomedir(), ".local", "state");
  return join(stateHome, "opencode", "context-cache.log");
}

/**
 * A generated key built on placeholder identity is not unique to this machine:
 * every host that fails the same way, in the same project path, derives the
 * same key. Returns the warning text, or null when identity is sound or the
 * key does not depend on it.
 */
function identityWarning({ user, host, sensitive }) {
  if (sensitive) return null;
  const badUser = user === "unknown";
  const badHost = host === "unknown-host";
  if (!badUser && !badHost) return null;
  const missing = badUser && badHost ? "username or hostname" : badUser ? "username" : "hostname";
  return (
    `could not determine the local ${missing}, so the cache key falls back to ` +
    `"${user}@${host}:<path>". Every machine with the same failure and the same project path ` +
    `will share it. Set ${PROMPT_CACHE_KEY_ENV_VAR} to pin a distinct key.`
  );
}

/** Stringify a thrown value that we did not create, without throwing. */
function describeError(error) {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  } catch {
    return "unstringifiable error";
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLogger({ env = {}, filePath, write = appendFileSync, warn = console.warn } = {}) {
  const flag = String(env?.[DEBUG_ENV_VAR] ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const path = filePath ?? defaultLogPath(env);
  const warned = new Set();
  let overflowed = false;
  let fileUsable = true;
  let dirReady = false;

  function emit(message) {
    try {
      warn(`[context-cache] ${message}`);
      return true;
    } catch {
      // A failing warning sink must never escape into the request path. The
      // caller declines to latch the key, so a sink that recovers still gets
      // the message.
      return false;
    }
  }

  const api = {
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
        emit(
          `cannot write debug log at ${path}: ${describeError(error)}; debug logging disabled ` +
            "for this process. Restart opencode after fixing it to re-enable.",
        );
      }
    },

    /**
     * Always on, independent of the debug flag, and deduplicated. A
     * compatibility failure must be visible without the operator having first
     * guessed to turn debug logging on.
     */
    warnOnce(key, message) {
      if (warned.has(key)) return false;
      if (warned.size >= WARNING_KEY_LIMIT) {
        // Past the ceiling, stop growing the set and stop competing for stderr.
        // Detail stays available in the debug log, which is opt-in.
        if (!overflowed) {
          overflowed = true;
          emit(
            `more than ${WARNING_KEY_LIMIT} distinct warnings; suppressing further ones on stderr. ` +
              `Set ${DEBUG_ENV_VAR}=1 for the full record.`,
          );
        }
        api.debug(`WARN (suppressed) ${message}`);
        return false;
      }
      if (!emit(message)) return false;
      warned.add(key);
      // The always-on channel writes to stderr, which under opencode's TUI can
      // be redrawn away. Mirror it into the durable log so an operator who
      // turns debug on gets a complete record rather than one with the
      // warnings missing. Called through `api`, not `this`, so a destructured
      // `const { warnOnce } = logger` keeps working.
      api.debug(`WARN ${message}`);
      return true;
    },
  };

  return api;
}

/** The two spellings opencode core uses, depending on provider. */
const CACHE_KEY_FIELDS = ["promptCacheKey", "prompt_cache_key"];

const SES_PREFIXED = /^ses_[0-9a-f]{64}$/;

/** Core sends the digest without the ses_ prefix on its own zen provider path. */
function stripSesPrefix(sessionID) {
  return SES_PREFIXED.test(sessionID) ? sessionID.slice(4) : sessionID;
}

/**
 * Replace a cache key field only when it still holds core's session-ID default.
 * Field presence alone does not prove core set the value: model, agent and
 * variant options can carry the field, and a plugin ordered before this one can
 * add it. Matching the session ID is exact provenance, and it inherits core's
 * whole provider table without duplicating it.
 */
function applyCacheKey(output, value, sessionID) {
  const options = output?.options;
  if (!options || typeof options !== "object") {
    return { appliedFields: [], foreignFields: [], emptyFields: [], reason: "invalid-options" };
  }
  if (typeof sessionID !== "string" || sessionID === "") {
    return { appliedFields: [], foreignFields: [], emptyFields: [], reason: "missing-session" };
  }

  const stripped = stripSesPrefix(sessionID);
  const appliedFields = [];
  const foreignFields = [];
  const emptyFields = [];
  const replacements = {};

  for (const field of CACHE_KEY_FIELDS) {
    // hasOwn, not `in`: the spread below copies only own properties, and a
    // polluted Object.prototype must not look like a field opencode set.
    if (!Object.hasOwn(options, field)) continue;
    const current = options[field];
    if (current === sessionID || current === stripped) {
      replacements[field] = value;
      appliedFields.push(field);
    } else if (current === undefined || current === null) {
      // Present but unset. Provenance is still unproven so we must not write,
      // but nobody "set" this, and saying so sends the operator hunting for a
      // conflicting plugin that does not exist.
      emptyFields.push(field);
    } else {
      foreignFields.push(field);
    }
  }

  if (appliedFields.length === 0 && foreignFields.length === 0 && emptyFields.length === 0) {
    return { appliedFields, foreignFields, emptyFields, reason: "no-fields" };
  }
  if (appliedFields.length > 0) output.options = { ...options, ...replacements };
  return { appliedFields, foreignFields, emptyFields, reason: null };
}

const OpenCodeContextCachePlugin = async (input = {}, options = {}) => {
  // The whole factory is guarded. An unguarded throw here rejects the promise
  // opencode is awaiting, so the plugin fails to load outright - strictly worse
  // than loading and doing nothing.
  try {
    const env = process.env;
    const logger = createLogger({ env, warn: typeof options?.warn === "function" ? options.warn : undefined });
    const user = getUsername({ env });
    const host = safeHostname();
    const { scope } = parseScope(scopeSetting(env, options));
    const resolved = resolveCacheKey({
      env,
      options,
      worktree: input?.worktree,
      directory: input?.directory,
      user,
      host,
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
    const identityIssue = resolved && identityWarning({ user, host, sensitive: resolved.sensitive });
    if (identityIssue) logger.warnOnce("identity-fallback", identityIssue);

    if (!resolved) {
      if (scope === "session") {
        logger.debug(`${SCOPE_ENV_VAR}=session: opted out, leaving opencode's session default in place`);
      } else {
        // Not an opt-out: we were asked for a stable key and could not build
        // one. Silently reverting to a per-session key is the exact regression
        // this plugin exists to prevent.
        logger.warnOnce(
          "no-path",
          `could not derive a project path from opencode's PluginInput ` +
            `(worktree=${safeJson(input?.worktree)}, directory=${safeJson(input?.directory)}), ` +
            `so no stable cache key was set and prompt caching stays per-session. ` +
            `Set ${PROMPT_CACHE_KEY_ENV_VAR} to pin one explicitly.`,
        );
      }
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
        let provider = "unknown";
        try {
          // Coerced, not just read: every use below is a template literal, and
          // ToString on a null-prototype object or a Symbol throws.
          const label = hookInput?.model?.providerID ?? hookInput?.provider?.info?.id;
          provider = typeof label === "string" && label !== "" ? label : "unknown";

          const { appliedFields, foreignFields, emptyFields, reason } = applyCacheKey(
            output,
            resolved.value,
            hookInput?.sessionID,
          );

          // invalid-options and missing-session cannot happen against a correct
          // opencode. When they do, the shape upstream changed and the plugin is
          // permanently inert, so they are exactly the states that must be loud.
          if (reason === "invalid-options") {
            logger.warnOnce(
              `invalid-options:${provider}`,
              "opencode gave this hook no options object to write to, so no cache key was applied. " +
                "This should not happen: opencode may have changed the chat.params output shape. " +
                "Prompt caching has reverted to a per-session key.",
            );
          } else if (reason === "missing-session") {
            logger.warnOnce(
              `missing-session:${provider}`,
              "opencode gave this hook no sessionID, so the cache key's provenance could not be " +
                "checked and nothing was changed. This should not happen: opencode may have renamed " +
                "the field. Prompt caching has reverted to a per-session key.",
            );
          } else if (reason === "no-fields") {
            // Not a fault, so not a warning. Core seeds a cache key field only
            // for a fixed set of provider SDKs; Anthropic caches by
            // `cache_control` breakpoint and the openai-compatible providers
            // have no cache key in their API at all, so for those there is
            // nothing correct to write. Warning on a routine configuration is
            // how an operator learns to ignore the channel that also carries
            // the states which do mean something. Kept in the debug log so
            // "why is no key applied here" still has an answer.
            logger.debug(
              `provider ${provider} exposes no prompt cache key field, so none was applied. ` +
                "This provider does not support one; if it used to work, opencode may have " +
                "renamed the field.",
            );
          }

          if (foreignFields.length > 0) {
            logger.warnOnce(
              `foreign:${provider}:${foreignFields.join(",")}`,
              `provider ${provider} carries a prompt cache key this plugin did not set ` +
                `(${foreignFields.join(", ")}); leaving those fields unchanged.`,
            );
          }
          if (emptyFields.length > 0) {
            logger.warnOnce(
              `empty:${provider}:${emptyFields.join(",")}`,
              `provider ${provider} exposes ${emptyFields.join(", ")} but opencode left it empty, ` +
                "so provenance could not be confirmed and no key was applied. If caching used to " +
                "work here, opencode may have changed how it seeds this field.",
            );
          }

          // Runs for every outcome: a debug log that goes quiet on the no-fields
          // path cannot be told apart from a hook that is not running at all.
          logger.debug(
            `provider=${provider} applied=[${appliedFields.join(",")}] ` +
              `foreign=[${foreignFields.join(",")}] empty=[${emptyFields.join(",")}] ` +
              `reason=${reason ?? "none"}`,
          );
        } catch (error) {
          // Last resort. Bounded by the error text so a second, unrelated
          // failure on the same provider is not suppressed forever, and itself
          // wrapped because there is nothing left to fall back to.
          try {
            const what = describeError(error);
            logger.warnOnce(
              `error:${provider}:${what.slice(0, 120)}`,
              `unexpected error applying cache key: ${what}`,
            );
          } catch {
            // Nothing further to try; the request must still proceed.
          }
        }
      },
    };
  } catch (error) {
    try {
      // The logger may not exist yet, so go direct - but still honour an
      // injected sink if the caller supplied one.
      const sink = typeof options?.warn === "function" ? options.warn : console.warn;
      sink(`[context-cache] disabled by an unexpected startup error: ${describeError(error)}`);
    } catch {
      // Nothing further to try; opencode must still get a usable plugin.
    }
    return { "chat.params": async () => {} };
  }
};

/**
 * Helpers hang off the plugin function instead of being exported.
 *
 * DO NOT turn these back into named exports. opencode's loader walks
 * `Object.values(module)` and requires every value to be a function (or an
 * object with a `server` function):
 *
 *   function Gy(x){ if (typeof x === "function") return x;
 *                   if (!x || typeof x !== "object" || !("server" in x)) return;
 *                   if (typeof x.server !== "function") return;  return x.server }
 *   function Wy(m){ for (const x of Object.values(m)) {
 *                     if (!Gy(x)) throw TypeError("Plugin export is not a function"); ... } }
 *
 * A single exported constant makes opencode refuse the whole plugin, and every
 * distinct exported *function* is then invoked as a plugin factory - so an
 * exported `sha256` would be called as `sha256(pluginInput, options)`. The
 * three exports below are deliberately the same function object, which the
 * loader deduplicates by identity into one plugin.
 *
 * `test/unit/export-shape.test.mjs` reproduces that check and will fail if this
 * is undone.
 */
OpenCodeContextCachePlugin.internals = Object.freeze({
  PROMPT_CACHE_KEY_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  SCOPE_ENV_VAR,
  DEBUG_ENV_VAR,
  LOG_PATH_ENV_VAR,
  MAX_CACHE_KEY_LENGTH,
  SCOPES,
  CACHE_KEY_FIELDS,
  sha256,
  fingerprint,
  isSafeOverride,
  scopeSetting,
  parseScope,
  selectScopePath,
  resolveCacheKey,
  getUsername,
  safeHostname,
  safeHomedir,
  identityWarning,
  defaultLogPath,
  describeError,
  WARNING_KEY_LIMIT,
  createLogger,
  stripSesPrefix,
  applyCacheKey,
});

/** Kept so existing configs importing the old name keep working. */
const EnhancedCachePlugin = OpenCodeContextCachePlugin;

export { OpenCodeContextCachePlugin, EnhancedCachePlugin };
export default OpenCodeContextCachePlugin;
