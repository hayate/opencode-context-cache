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

export function createLogger({ env = {}, filePath, write = appendFileSync, warn = console.warn } = {}) {
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
