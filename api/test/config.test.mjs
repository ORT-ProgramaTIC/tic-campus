// The config parser's one job is to refuse at boot rather than at the first
// query, so that is what this asserts. Runs against the BUILT dist, so it also
// catches a build that did not emit — `pnpm --filter tic-campus-api test`.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

const URL_ = "postgresql://campus_svc@tic-db:5432/tic_auth";

test("a missing DATABASE_URL fails, and the message names it", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: "  " }), /DATABASE_URL/);
});

test("the password comes from the file, trimmed", () => {
  const file = join(mkdtempSync(join(tmpdir(), "campus-")), "db_svc_password");
  writeFileSync(file, "s3cret\n");
  const config = loadConfig({
    DATABASE_URL: URL_,
    DATABASE_PASSWORD_FILE: file,
  });
  assert.equal(config.databasePassword, "s3cret");
  assert.equal(config.port, 3000);
});

test("an unreadable or empty password file fails, naming the path", () => {
  const missing = join(tmpdir(), "no-such-campus-secret");
  assert.throws(
    () => loadConfig({ DATABASE_URL: URL_, DATABASE_PASSWORD_FILE: missing }),
    /no-such-campus-secret/,
  );
  const empty = join(mkdtempSync(join(tmpdir(), "campus-")), "db_svc_password");
  writeFileSync(empty, "\n");
  assert.throws(
    () => loadConfig({ DATABASE_URL: URL_, DATABASE_PASSWORD_FILE: empty }),
    /vacío/,
  );
});

// No password file is the local-dev shape: the URL carries its own credential.
test("no password file is allowed", () => {
  assert.equal(loadConfig({ DATABASE_URL: URL_ }).databasePassword, undefined);
});

test("YEAR_LOCK defaults to 31 December, and a date that does not exist fails", () => {
  assert.deepEqual(loadConfig({ DATABASE_URL: URL_ }).yearLock, {
    month: 12,
    day: 31,
  });
  assert.deepEqual(
    loadConfig({ DATABASE_URL: URL_, YEAR_LOCK: "02-28" }).yearLock,
    { month: 2, day: 28 },
  );
  for (const bad of ["02-30", "02-29", "13-01", "00-10", "1231", "12-1"]) {
    assert.throws(
      () => loadConfig({ DATABASE_URL: URL_, YEAR_LOCK: bad }),
      /YEAR_LOCK/,
      bad,
    );
  }
});
