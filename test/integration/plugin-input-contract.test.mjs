/**
 * Opt-in compatibility gate.
 *
 * This is a contract probe, not a red-green test: it asserts facts about
 * opencode that this plugin's design depends on and that no change of ours can
 * affect. The installed plugin types are 1.18.21 while the binary here is
 * 1.18.25, so the design was verified against compiled behavior rather than a
 * published contract. Run this before upgrading opencode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import plugin from "../../plugins/opencode-context-cache.mjs";

const { resolveCacheKey, getUsername, safeHostname } = plugin.internals;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN =
  [process.env.OPENCODE_BIN, join(process.env.HOME ?? "", ".opencode", "bin", "opencode")]
    .filter(Boolean)
    .find((p) => existsSync(p)) ?? null;
const skip = BIN ? false : "no opencode binary found; set OPENCODE_BIN to run this suite";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function makeProject(root, name) {
  const dir = join(root, name);
  mkdirSync(join(dir, "pkg", "deep"), { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv });
  cpSync(join(HERE, "probe-plugin.mjs"), join(dir, "probe-plugin.mjs"));
  writeFileSync(
    join(dir, "opencode.jsonc"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["./probe-plugin.mjs"] }, null, 2),
  );
  return dir;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = sleep(5000).then(() => "timeout");
  if ((await Promise.race([exited.then(() => "exited"), timer])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

/** Boot one server, ask it for each directory, and return the probe records. */
async function probe(directories, cwd) {
  const root = mkdtempSync(join(tmpdir(), "ctx-cache-it-"));
  const out = join(root, "probe.jsonl");
  const port = await freePort();
  const stderr = [];
  const child = spawn(BIN, ["serve", "--port", String(port)], {
    cwd,
    env: { ...process.env, CONTEXT_CACHE_PROBE_OUT: out },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (b) => stderr.push(String(b)));
  let exitedEarly = null;
  child.once("exit", (code, signal) => {
    exitedEarly = `code=${code} signal=${signal}`;
  });

  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      if (exitedEarly) throw new Error(`opencode exited during startup: ${exitedEarly}\n${stderr.join("")}`);
      if (Date.now() > deadline) throw new Error(`opencode did not become ready\n${stderr.join("")}`);
      const ok = await fetch(`http://127.0.0.1:${port}/app`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      await sleep(250);
    }
    for (const dir of directories) {
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        headers: { "x-opencode-directory": encodeURIComponent(dir) },
      });
      assert.ok(res.ok, `instance request for ${dir} failed with ${res.status}`);
    }
    await sleep(1000);
    const raw = existsSync(out) ? readFileSync(out, "utf8").trim() : "";
    return raw ? raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}

const keyFor = (record) =>
  resolveCacheKey({
    env: {},
    worktree: record.worktree,
    directory: record.directory,
    user: getUsername({ env: process.env }),
    host: safeHostname(),
  }).value;

test("one server process gives each project its own PluginInput", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-cache-proj-"));
  try {
    const a = makeProject(root, "alpha");
    const b = makeProject(root, "beta");
    // Serve from a directory that is neither project, so any implementation
    // reading process.cwd() is demonstrably wrong.
    const records = await probe([a, b], root);

    const forA = records.filter((r) => r.worktree === a);
    const forB = records.filter((r) => r.worktree === b);
    assert.equal(forA.length, 1, "expected exactly one plugin invocation for alpha");
    assert.equal(forB.length, 1, "expected exactly one plugin invocation for beta");
    assert.equal(forA[0].cwd, forB[0].cwd, "both invocations share one process cwd");
    assert.notEqual(forA[0].cwd, forA[0].worktree, "process.cwd() is not the project path");

    // The contract that matters: our resolver turns these into distinct keys,
    // where a cwd-based resolver would produce one.
    assert.notEqual(keyFor(forA[0]), keyFor(forB[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree is the VCS root, and a nested session shares the root's key", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-cache-proj-"));
  try {
    const project = makeProject(root, "gamma");
    const nested = join(project, "pkg", "deep");
    const records = await probe([project, nested], root);

    const atRoot = records.find((r) => r.directory === project);
    const atNested = records.find((r) => r.directory === nested);
    assert.ok(atRoot && atNested, "expected an invocation for both the root and the nested directory");
    assert.equal(atNested.hasWorktree, true, "PluginInput.worktree must exist");
    assert.equal(atNested.worktree, project, "worktree must be the git root, not the cwd");
    assert.equal(atNested.vcs, "git");

    assert.equal(keyFor(atRoot), keyFor(atNested), "a nested session must reuse the worktree key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
