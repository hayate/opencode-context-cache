import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import OpenCodeContextCacheDefault, {
  EnhancedCachePlugin,
  OpenCodeContextCachePlugin,
} from "../../plugins/opencode-context-cache.mjs";

const {
  DEBUG_ENV_VAR,
  LOG_PATH_ENV_VAR,
  PROMPT_CACHE_KEY_ENV_VAR,
  SCOPE_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  getUsername,
  safeHostname,
} = OpenCodeContextCachePlugin.internals;

const SESSION = "ses_" + "b".repeat(64);
const digest = (v) => createHash("sha256").update(v, "utf8").digest("hex");

/**
 * Every env var that can steer the plugin, so an ambient value cannot change a
 * result - or, in the log path's case, make a test write into an operator's file.
 */
const OWNED = [
  PROMPT_CACHE_KEY_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  SCOPE_ENV_VAR,
  DEBUG_ENV_VAR,
  LOG_PATH_ENV_VAR,
  "XDG_STATE_HOME",
];

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

/** Tests assert on collected warnings, so nothing should reach the real stderr. */
function quiet() {
  return { warn: () => {} };
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
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
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
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
    const input = hookInput({ model: { providerID: "openai" } });
    await hooks["chat.params"](input, { options: { promptCacheKey: SESSION } });
    assert.equal("headers" in input.model, false, "must not create a headers object");
  });
});

test("the hook leaves a key it did not set", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
    const output = { options: { promptCacheKey: "operator-choice" } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, "operator-choice");
  });
});

test("the hook adds nothing when core placed no field", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
    const output = { options: { store: false } };
    await hooks["chat.params"](hookInput(), output);
    assert.deepEqual(output.options, { store: false });
  });
});

test("the hook is inert and silent when scope disables the key", async () => {
  await withEnv({ [SCOPE_ENV_VAR]: "session" }, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    const output = { options: { promptCacheKey: SESSION } };
    for (let i = 0; i < 3; i++) await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, SESSION);
    // Without the early return the hook dereferences a null resolution, throws
    // into its own catch, and turns a deliberate opt-out into a warning storm.
    assert.deepEqual(warnings, [], "opting out must not produce per-request warnings");
  });
});

test("the hook changes nothing when the session id is missing", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput({ sessionID: undefined }), output);
    assert.equal(output.options.promptCacheKey, SESSION, "provenance unprovable, so nothing may change");
  });
});

test("the hook does not throw on malformed input or output", async () => {
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
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
    const a = await OpenCodeContextCachePlugin({ directory: "/srv/a/sub", worktree: "/srv/a" }, quiet());
    const b = await OpenCodeContextCachePlugin({ directory: "/srv/b/sub", worktree: "/srv/b" }, quiet());
    const outA = { options: { promptCacheKey: SESSION } };
    const outB = { options: { promptCacheKey: SESSION } };
    await a["chat.params"](hookInput(), outA);
    await b["chat.params"](hookInput(), outB);
    assert.notEqual(outA.options.promptCacheKey, outB.options.promptCacheKey);
    assert.notEqual(
      outA.options.promptCacheKey,
      digest(`${getUsername({ env: process.env })}@${safeHostname()}:${process.cwd()}`),
      "the key must not be derived from the process working directory",
    );
  });
});

test("a nested directory shares the key of its worktree root", async () => {
  await withEnv({}, async () => {
    const root = await OpenCodeContextCachePlugin({ directory: "/srv/a", worktree: "/srv/a" }, quiet());
    const nested = await OpenCodeContextCachePlugin({ directory: "/srv/a/pkg/deep", worktree: "/srv/a" }, quiet());
    const outRoot = { options: { promptCacheKey: SESSION } };
    const outNested = { options: { promptCacheKey: SESSION } };
    await root["chat.params"](hookInput(), outRoot);
    await nested["chat.params"](hookInput(), outNested);
    assert.notEqual(outRoot.options.promptCacheKey, SESSION, "the hook must actually have run");
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

test("an upstream shape change is loud, not silent", async () => {
  // These states cannot occur against a correct opencode. When they do, the
  // plugin is permanently inert and prompt caching has silently reverted to a
  // per-session key - the exact regression this plugin exists to prevent. An
  // earlier revision asserted silence here; that was wrong.
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"](hookInput(), { options: null });
    await hooks["chat.params"](hookInput({ sessionID: undefined }), { options: { promptCacheKey: SESSION } });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /no options object/);
    assert.match(warnings[0], /reverted to a per-session key/);
    assert.match(warnings[1], /no sessionID/);
    assert.match(warnings[1], /renamed/);
  });
});

test("a PluginInput with no usable path warns, while scope=session stays quiet", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    await OpenCodeContextCachePlugin({ directory: "", worktree: "" }, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1, "an opt-out and a derive failure must not look the same");
    assert.match(warnings[0], /could not derive a project path/);
  });
  await withEnv({ [SCOPE_ENV_VAR]: "session" }, async () => {
    const warnings = [];
    await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, { warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, [], "opting out is intentional and must be silent");
  });
});

test("an empty cache key field gets its own message, not the conflict one", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"](hookInput(), { options: { promptCacheKey: undefined } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /left it empty/);
    assert.equal(/did not set/.test(warnings[0]), false, "nobody set it, so do not say somebody did");
  });
});

test("a non-string providerID cannot make the hook throw", async () => {
  // ToString on a null-prototype object or a Symbol throws, and every use of
  // the provider label is a template literal.
  await withEnv({}, async () => {
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, quiet());
    const hostile = [
      Object.create(null),
      Symbol("provider"),
      { toString() { throw new Error("boom"); } },
      42,
      null,
    ];
    for (const providerID of hostile) {
      await hooks["chat.params"](hookInput({ model: { providerID } }), { options: {} });
      await hooks["chat.params"](hookInput({ model: { providerID } }), { options: { promptCacheKey: "theirs" } });
    }
  });
});

test("a second, unrelated error on one provider is not suppressed by the first", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    const boom = (message) => ({
      options: { get promptCacheKey() { throw new Error(message); } },
    });
    await hooks["chat.params"](hookInput(), boom("FIRST PROBLEM"));
    await hooks["chat.params"](hookInput(), boom("FIRST PROBLEM"));
    await hooks["chat.params"](hookInput(), boom("SECOND, DIFFERENT PROBLEM"));
    assert.equal(warnings.length, 2, "same error deduped, different error still reported");
    assert.match(warnings[0], /FIRST PROBLEM/);
    assert.match(warnings[1], /SECOND, DIFFERENT PROBLEM/);
  });
});

test("a startup failure disables the plugin instead of failing the load", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hostileOptions = {
      get scope() { throw new Error("config blew up"); },
      warn: (m) => warnings.push(m),
    };
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, hostileOptions);
    assert.equal(typeof hooks["chat.params"], "function", "must still hand opencode a usable plugin");
    assert.equal(warnings.length, 1, "and say why, through the caller's sink");
    assert.match(warnings[0], /disabled by an unexpected startup error/);
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, SESSION, "an inert plugin changes nothing");
  });
});

test("plugin options from opencode.jsonc reach the resolver", async () => {
  // Deleting `options` from the factory's resolveCacheKey call left the whole
  // suite green, so config-driven cacheKey and scope were dead in practice.
  await withEnv({}, async () => {
    const fromConfig = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo/pkg/a", worktree: "/srv/repo" },
      { cacheKey: "from-config", warn: () => {} },
    );
    const out = { options: { promptCacheKey: SESSION } };
    await fromConfig["chat.params"](hookInput(), out);
    assert.equal(out.options.promptCacheKey, "from-config");
  });

  await withEnv({}, async () => {
    const user = getUsername({ env: process.env });
    const host = safeHostname();
    const scoped = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo/pkg/a", worktree: "/srv/repo" },
      { scope: "directory", warn: () => {} },
    );
    const out = { options: { promptCacheKey: SESSION } };
    await scoped["chat.params"](hookInput(), out);
    assert.equal(out.options.promptCacheKey, digest(`${user}@${host}:/srv/repo/pkg/a`));
  });
});

test("env beats plugin options through the factory", async () => {
  await withEnv({ [PROMPT_CACHE_KEY_ENV_VAR]: "from-env" }, async () => {
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { cacheKey: "from-config", warn: () => {} },
    );
    const out = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), out);
    assert.equal(out.options.promptCacheKey, "from-env");
  });
});

test("the debug log records a fingerprint, never the raw override", async () => {
  // The earlier assertion looked only at warnOnce output, which never contains
  // the value, so it was structurally incapable of failing.
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-hook-"));
  try {
    const logPath = join(dir, "context-cache.log");
    const secret = "secret-tenant-key";
    await withEnv(
      { [PROMPT_CACHE_KEY_ENV_VAR]: secret, [DEBUG_ENV_VAR]: "1", [LOG_PATH_ENV_VAR]: logPath },
      async () => {
        const hooks = await OpenCodeContextCachePlugin(
          { directory: "/srv/repo", worktree: "/srv/repo" },
          { warn: () => {} },
        );
        await hooks["chat.params"](hookInput(), { options: { promptCacheKey: SESSION } });
      },
    );
    const log = readFileSync(logPath, "utf8");
    assert.equal(log.includes(secret), false, "the raw override must never be written to the log");
    assert.match(log, /fingerprint=[0-9a-f]{8}/);
    assert.match(log, /provider=openai applied=\[promptCacheKey\]/, "the per-request line must be written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the debug log records the generated key's pre-image, which is not sensitive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-hook-"));
  try {
    const logPath = join(dir, "context-cache.log");
    await withEnv({ [DEBUG_ENV_VAR]: "1", [LOG_PATH_ENV_VAR]: logPath }, async () => {
      await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, { warn: () => {} });
    });
    assert.match(readFileSync(logPath, "utf8"), /raw=.+@.+:\/srv\/repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the provider label falls back to provider.info.id, then to unknown", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"]({ sessionID: SESSION, provider: { info: { id: "via-info" } } }, { options: {} });
    await hooks["chat.params"]({ sessionID: SESSION }, { options: {} });
    assert.match(warnings[0], /provider via-info/);
    assert.match(warnings[1], /provider unknown/);
  });
});

test("two different foreign field sets on one provider both warn", async () => {
  await withEnv({}, async () => {
    const warnings = [];
    const hooks = await OpenCodeContextCachePlugin(
      { directory: "/srv/repo", worktree: "/srv/repo" },
      { warn: (m) => warnings.push(m) },
    );
    await hooks["chat.params"](hookInput(), { options: { promptCacheKey: "a" } });
    await hooks["chat.params"](hookInput(), { options: { promptCacheKey: "a", prompt_cache_key: "b" } });
    assert.equal(warnings.length, 2, "the dedup key must include the field set, not just the provider");
  });
});
