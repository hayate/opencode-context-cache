import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import plugin from "../../plugins/opencode-context-cache.mjs";

const { DEBUG_ENV_VAR, LOG_PATH_ENV_VAR, createLogger, defaultLogPath, fingerprint, safeHomedir } =
  plugin.internals;

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ctx-cache-"));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

test("default log path honours an explicit override", () => {
  assert.equal(defaultLogPath({ [LOG_PATH_ENV_VAR]: "/custom/x.log" }, "/home/u"), "/custom/x.log");
});

test("default log path honours XDG_STATE_HOME, else falls back under home", () => {
  assert.equal(defaultLogPath({ XDG_STATE_HOME: "/xdg" }, "/home/u"), "/xdg/opencode/context-cache.log");
  assert.equal(defaultLogPath({}, "/home/u"), "/home/u/.local/state/opencode/context-cache.log");
});

test("fingerprint is short, stable, and distinguishes inputs", () => {
  assert.equal(fingerprint("team-key").length, 8);
  assert.equal(fingerprint("team-key"), fingerprint("team-key"));
  assert.notEqual(fingerprint("team-key"), fingerprint("other-key"));
  assert.equal(fingerprint("team-key").includes("team-key"), false);
});

test("debug logging is off unless explicitly enabled", () => {
  const lines = [];
  const logger = createLogger({ env: {}, filePath: "/unused", write: (_p, l) => lines.push(l) });
  assert.equal(logger.enabled, false);
  logger.debug("hello");
  assert.deepEqual(lines, []);
});

test("debug logging writes one single-line entry when enabled", () => {
  const path = join(tempDir(), "nested", "context-cache.log");
  const logger = createLogger({ env: { [DEBUG_ENV_VAR]: "1" }, filePath: path });
  assert.equal(logger.enabled, true);
  logger.debug("hello", "multi\nline");
  const body = readFileSync(path, "utf8");
  assert.equal(body.split("\n").filter(Boolean).length, 1);
  assert.match(body, /\[context-cache\] hello multi\\nline/);
});

test("an unwritable log warns exactly once and never throws", () => {
  const warnings = [];
  const logger = createLogger({
    env: { [DEBUG_ENV_VAR]: "true" },
    filePath: join(tempDir(), "x.log"),
    write: () => { throw new Error("EACCES"); },
    warn: (m) => warnings.push(m),
  });
  logger.debug("one");
  logger.debug("two");
  logger.debug("three");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
});

test("an unmakeable log directory warns once and never throws", () => {
  const dir = tempDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  const warnings = [];
  const logger = createLogger({
    env: { [DEBUG_ENV_VAR]: "1" },
    filePath: join(blocker, "sub", "x.log"),
    warn: (m) => warnings.push(m),
  });
  logger.debug("one");
  logger.debug("two");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot write debug log/);
});

test("a throwing warn sink cannot escape", () => {
  const logger = createLogger({
    env: { [DEBUG_ENV_VAR]: "1" },
    filePath: "/unused",
    write: () => { throw new Error("EACCES"); },
    warn: () => { throw new Error("stderr is gone"); },
  });
  assert.doesNotThrow(() => logger.debug("boom"));
  assert.doesNotThrow(() => logger.warnOnce("k", "m"));
});

test("a warning that could not be delivered is not marked as spent", () => {
  const delivered = [];
  let sinkUp = false;
  const logger = createLogger({
    env: {},
    filePath: "/unused",
    warn: (m) => {
      if (!sinkUp) throw new Error("stderr is gone");
      delivered.push(m);
    },
  });
  assert.equal(logger.warnOnce("k", "important"), false, "not delivered, so not spent");
  sinkUp = true;
  assert.equal(logger.warnOnce("k", "important"), true, "a recovered sink still gets the message");
  assert.deepEqual(delivered, ["[context-cache] important"]);
  assert.equal(logger.warnOnce("k", "important"), false, "and only once thereafter");
});

test("warnings are mirrored into the debug log so it is a complete record", () => {
  const path = join(tempDir(), "context-cache.log");
  const logger = createLogger({ env: { [DEBUG_ENV_VAR]: "1" }, filePath: path, warn: () => {} });
  logger.warnOnce("k", "something the operator needs");
  assert.match(readFileSync(path, "utf8"), /WARN something the operator needs/);
});

test("safeHomedir survives a throwing homedir, and an explicit path never calls it", () => {
  assert.equal(safeHomedir({ readHomedir: () => { throw new Error("no passwd entry"); } }), "");
  assert.equal(safeHomedir({ readHomedir: () => "" }), "");
  let called = 0;
  const path = defaultLogPath({ [LOG_PATH_ENV_VAR]: "/custom/x.log" }, (() => { called++; return "/h"; })());
  assert.equal(path, "/custom/x.log");
  assert.equal(called, 1, "the caller evaluated its own argument; the point is the default no longer does");
  assert.doesNotThrow(() => defaultLogPath({}));
});

test("warnOnce deduplicates by key and ignores the debug flag", () => {
  const warnings = [];
  const logger = createLogger({ env: {}, filePath: "/unused", warn: (m) => warnings.push(m) });
  assert.equal(logger.enabled, false, "warnings must not require the debug flag");
  assert.equal(logger.warnOnce("absent:openai", "first"), true);
  assert.equal(logger.warnOnce("absent:openai", "again"), false);
  assert.equal(logger.warnOnce("absent:anthropic", "other"), true);
  assert.deepEqual(warnings, ["[context-cache] first", "[context-cache] other"]);
});
