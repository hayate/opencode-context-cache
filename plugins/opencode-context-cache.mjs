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

function parseScope(raw) {
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

function defaultLogPath(env = {}, home = homedir()) {
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

function createLogger({ env = {}, filePath, write = appendFileSync, warn = console.warn } = {}) {
  const flag = String(env?.[DEBUG_ENV_VAR] ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const path = filePath ?? defaultLogPath(env);
  const warned = new Set();
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
  };
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

const OpenCodeContextCachePlugin = async (input = {}, options = {}) => {
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
  parseScope,
  selectScopePath,
  resolveCacheKey,
  getUsername,
  safeHostname,
  defaultLogPath,
  createLogger,
  stripSesPrefix,
  applyCacheKey,
});

/** Kept so existing configs importing the old name keep working. */
const EnhancedCachePlugin = OpenCodeContextCachePlugin;

export { OpenCodeContextCachePlugin, EnhancedCachePlugin };
export default OpenCodeContextCachePlugin;
