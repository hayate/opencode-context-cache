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
