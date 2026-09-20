#!/usr/bin/env node
/**
 * Generates — or checks — the directory stand-ins `make test-db` applies before campus's
 * own migrations.
 *
 *   node scripts/gen-directory-standins.mjs            # regenerate the committed artifacts
 *   node scripts/gen-directory-standins.mjs --check    # fail if they are stale
 *
 * **The test suite never runs this.** It reads the committed `.sql`, so a laptop with no
 * Python and no tic-auth checkout runs every integration test unchanged. Only regenerating
 * needs Python; only the check needs tic-auth on disk, and it skips rather than fails when
 * it is absent — a contributor without the sibling repo should not be blocked by a drift
 * check they cannot run.
 *
 * Why generated at all: hand-written stand-ins would be a second definition of tic-auth's
 * schema, free to drift without anything noticing — and drifting is precisely what the
 * directory contract must not do unnoticed, since campus reads it for every permission it
 * grants (F5). Ported from `MEV/api/scripts/gen-directory-standins.mjs`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(API_ROOT, "..");

/**
 * Two candidates, because this repo is not where its siblings are: the VM workspace holds
 * `tic-auth/` and `MEV/` at the top and this repo at `tic-campus/new/`, so tic-auth is a
 * sibling of the *parent*. Both are tried so a flatter checkout works unchanged, and
 * `TIC_AUTH_REPO` overrides either.
 */
const CANDIDATES = [
  process.env.TIC_AUTH_REPO,
  resolve(REPO_ROOT, "..", "tic-auth"),
  resolve(REPO_ROOT, "..", "..", "tic-auth"),
].filter(Boolean);
const TIC_AUTH = resolve(
  CANDIDATES.find((path) => existsSync(path)) ?? CANDIDATES[0],
);

const OUT_DIR = resolve(API_ROOT, "test/support/directory");
const SQL_PATH = resolve(OUT_DIR, "standins.generated.sql");
const META_PATH = resolve(OUT_DIR, "standins.generated.json");
const GENERATOR = resolve(HERE, "directory-standins.py");

const check = process.argv.includes("--check");

function fail(message) {
  console.error(`gen-directory-standins: ${message}`);
  process.exit(1);
}

function skip(message) {
  console.log(`gen-directory-standins: skipped — ${message}`);
  process.exit(0);
}

if (!existsSync(TIC_AUTH)) {
  const how = `set TIC_AUTH_REPO, or check out tic-auth in the VM workspace (looked in ${CANDIDATES.join(", ")})`;
  if (check)
    skip(`tic-auth is not on disk, so drift cannot be checked. ${how}.`);
  fail(`tic-auth is not on disk. ${how}.`);
}

// tic-auth's own venv first: it already has the pinned SQLAlchemy this generator compiles
// DDL with, and a system python almost certainly does not.
const venvPython = resolve(TIC_AUTH, ".venv/bin/python");
const [command, leadingArgs] = existsSync(venvPython)
  ? [venvPython, []]
  : ["uv", ["run", "python"]];

const run = spawnSync(command, [...leadingArgs, GENERATOR, TIC_AUTH], {
  cwd: TIC_AUTH,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (run.error && run.error.code === "ENOENT") {
  const message = `neither ${venvPython} nor \`uv\` is available to run the generator`;
  if (check) skip(`${message}, so drift cannot be checked.`);
  fail(message);
}
if (run.status !== 0) {
  fail(`the generator exited ${String(run.status)}:\n${run.stderr.trim()}`);
}

let generated;
try {
  generated = JSON.parse(run.stdout);
} catch {
  fail(
    `the generator did not return JSON. It said:\n${run.stdout.slice(0, 2000)}`,
  );
}

if (check) {
  if (!existsSync(SQL_PATH)) {
    fail(`${SQL_PATH} does not exist. Run \`pnpm db:stubs:generate\`.`);
  }
  const committedSql = readFileSync(SQL_PATH, "utf8");
  const committedMeta = JSON.parse(readFileSync(META_PATH, "utf8"));

  // `generatedAt` and `upstreamRevision` move on their own, so neither is compared: an
  // unrelated tic-auth commit must not fail this. The SQL and the source hashes are what
  // actually carry the contract.
  const sqlMatches = committedSql === generated.sql;
  const hashesMatch =
    JSON.stringify(committedMeta.sourceHashes) ===
    JSON.stringify(generated.provenance.sourceHashes);

  if (sqlMatches && hashesMatch) {
    console.log(
      "gen-directory-standins: the committed stand-ins match tic-auth.",
    );
    process.exit(0);
  }

  const what = !sqlMatches
    ? "the generated SQL differs from the committed file"
    : "the SQL is unchanged but tic-auth's source files have moved";
  fail(
    `${what}.\n` +
      `  tic-auth's directory contract has changed and campus's stand-ins are stale.\n` +
      `  Run \`pnpm db:stubs:generate\`, read the diff, and check whether anything campus\n` +
      `  reads (api/src/db/schema/directory.ts) has to change with it.`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SQL_PATH, generated.sql);
writeFileSync(META_PATH, `${JSON.stringify(generated.provenance, null, 2)}\n`);
console.log(
  `gen-directory-standins: wrote ${generated.provenance.baseTables.length} tables and ` +
    `${generated.provenance.views.length} views from ${TIC_AUTH}`,
);
