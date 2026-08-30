import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import OpenCodeContextCacheDefault, {
  EnhancedCachePlugin,
  OpenCodeContextCachePlugin,
} from "../../plugins/opencode-context-cache.mjs";

const {
  DEBUG_ENV_VAR,
  PROMPT_CACHE_KEY_ENV_VAR,
  SCOPE_ENV_VAR,
  STICKY_SESSION_ID_ENV_VAR,
  getUsername,
  safeHostname,
} = OpenCodeContextCachePlugin.internals;

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
    assert.notEqual(
      outA.options.promptCacheKey,
      digest(`${getUsername({ env: process.env })}@${safeHostname()}:${process.cwd()}`),
      "the key must not be derived from the process working directory",
    );
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
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" });
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
    const hostileOptions = {
      get scope() { throw new Error("config blew up"); },
      warn: () => {},
    };
    const hooks = await OpenCodeContextCachePlugin({ directory: "/srv/repo", worktree: "/srv/repo" }, hostileOptions);
    assert.equal(typeof hooks["chat.params"], "function", "must still hand opencode a usable plugin");
    const output = { options: { promptCacheKey: SESSION } };
    await hooks["chat.params"](hookInput(), output);
    assert.equal(output.options.promptCacheKey, SESSION, "an inert plugin changes nothing");
  });
});
