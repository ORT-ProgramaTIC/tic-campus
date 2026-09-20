import assert from "node:assert/strict";
import test from "node:test";
import { checkSlug } from "../dist/library/articles.js";
import { checkUnits, isUuid } from "../dist/library/program.js";

// What the library accepts from a client, with no database in it. A slug lands
// in a public URL and is set once (F32), so it is the one input here that is a
// trust boundary rather than a convenience. The writes themselves are in
// `db.test.mjs`.

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

test("a slug that is already a slug passes through unchanged", () => {
  assert.equal(checkSlug("tp-sql"), "tp-sql");
  assert.equal(checkSlug("clase-1"), "clase-1");
});

test("a slug is rejected, never quietly repaired", () => {
  // Normalizing "TP SQL" and "tp sql" to one row would make the second author
  // hit a 409 naming a slug neither of them typed.
  assert.throws(() => checkSlug("TP SQL"), /minúsculas/);
  assert.throws(() => checkSlug("intro a Python"), /minúsculas/);
  assert.throws(() => checkSlug("../../etc"), /minúsculas/);
  assert.throws(() => checkSlug("acentúado"), /minúsculas/);
});

test("the rejection says what to type instead", () => {
  assert.throws(() => checkSlug("TP SQL"), /"tp-sql"/);
});

test("a slug is a non-empty string and nothing else", () => {
  assert.throws(() => checkSlug(""), /vacía/);
  assert.throws(() => checkSlug(undefined), /vacía/);
  assert.throws(() => checkSlug(42), /vacía/);
  assert.throws(() => checkSlug("a".repeat(81)), /80/);
});

test("a program is a list of titled units", () => {
  const units = checkUnits([
    { title: "Unidad 1", contents: "# Variables" },
    { id: UUID, title: "Unidad 2", contents: "" },
  ]);
  assert.equal(units.length, 2);
  assert.equal(units[0].id, undefined, "a new unit carries no id");
  assert.equal(units[1].id, UUID);
  assert.equal(
    units[1].contents,
    "",
    "empty contents is a unit not written yet",
  );
});

test("a unit without a title is refused", () => {
  assert.throws(() => checkUnits([{ contents: "x" }]), /título/);
  assert.throws(() => checkUnits([{ title: "   ", contents: "x" }]), /título/);
});

test("a program that is not a list is refused", () => {
  assert.throws(() => checkUnits(undefined), /lista/);
  assert.throws(() => checkUnits({ units: [] }), /lista/);
  assert.throws(() => checkUnits([null]), /objeto/);
});

test("a unit id that is not a uuid is refused", () => {
  // The id decides whether a unit is updated or created, and an id from another
  // subject would reparent one — `writeProgram` checks that, this checks shape.
  assert.throws(
    () => checkUnits([{ id: "1", title: "U", contents: "" }]),
    /id/,
  );
});

test("isUuid is the shape, not a lookup", () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid(UUID.toUpperCase()), true);
  assert.equal(isUuid("3f2504e0-4f89-11d3-9a0c"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(null), false);
});
