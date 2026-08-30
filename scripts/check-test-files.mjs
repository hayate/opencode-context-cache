/**
 * Guard against a silently green test run.
 *
 * `node --test <file>` ignores a path that does not exist and still exits 0,
 * and `node --test <dir>` no longer scans directories on Node 24. Either way a
 * renamed or deleted suite disappears without failing CI. This reads the file
 * list back out of package.json and fails if any of it is missing.
 *
 * Dev tooling only: `scripts/` is not in the package.json `files` allowlist,
 * so it is never published.
 */

import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const target = process.argv[2] ?? "test";
const script = pkg.scripts?.[target];

if (!script) {
  console.error(`check-test-files: package.json has no "${target}" script`);
  process.exit(1);
}

const files = script.split(/\s+/).filter((token) => token.endsWith(".test.mjs"));

if (files.length === 0) {
  console.error(`check-test-files: the "${target}" script names no test files`);
  process.exit(1);
}

const missing = files.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)));

if (missing.length > 0) {
  console.error(`check-test-files: the "${target}" script names files that do not exist:`);
  for (const file of missing) console.error(`  - ${file}`);
  console.error("node --test would skip these and still exit 0.");
  process.exit(1);
}

console.log(`check-test-files: ${files.length} test file(s) present for "${target}"`);
