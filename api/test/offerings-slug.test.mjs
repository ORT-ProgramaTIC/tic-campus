import assert from "node:assert/strict";
import test from "node:test";
import { offeringPath, offeringSlug, slugify } from "../dist/offerings/slug.js";

// The URL half of F32, which is pure and therefore cheap to pin. What it cannot
// prove is that the slug matches an offering — that needs the directory, and it
// is in `db.test.mjs`.

test("an accented subject name is a readable slug", () => {
  assert.equal(slugify("Bases de Datos"), "bases-de-datos");
  assert.equal(slugify("Programación"), "programacion");
  assert.equal(slugify("Diseño de Sistemas"), "diseno-de-sistemas");
  assert.equal(slugify("Inglés Técnico II"), "ingles-tecnico-ii");
});

test("punctuation and edges do not survive", () => {
  assert.equal(slugify("  TIC — avanzado  "), "tic-avanzado");
  assert.equal(slugify("Taller (2do)"), "taller-2do");
  assert.equal(slugify("///"), "");
});

test("an offering's own name wins, and its courses are the fallback", () => {
  assert.equal(offeringSlug("Frontend 2", ["NR5A"]), "frontend-2");
  assert.equal(offeringSlug(null, ["NR5A"]), "nr5a");
  assert.equal(
    offeringSlug("   ", ["NR5A"]),
    "nr5a",
    "a blank name is no name",
  );
});

test("the course order the database returned does not change the URL", () => {
  assert.equal(
    offeringSlug(null, ["NR5B", "NR5A"]),
    offeringSlug(null, ["NR5A", "NR5B"]),
  );
});

test("an offering with nothing to be named after yields an empty segment", () => {
  // Which `resolveBySlug` can never match, and that is the intended outcome:
  // there is no URL a person could have typed for it.
  assert.equal(offeringSlug(null, []), "");
});

test("the path is the year, the subject and the offering", () => {
  assert.equal(
    offeringPath(2027, "Bases de Datos", null, ["NR5A", "NR5B"]),
    "/2027/bases-de-datos/nr5a-nr5b",
  );
});

test("two offerings that slugify the same produce the same path", () => {
  // Not a bug to fix here — it is what makes `resolveBySlug` refuse rather than
  // pick one, and this is the shape of the input that gets it there.
  assert.equal(
    offeringPath(2027, "Proyecto", null, ["NR5A"]),
    offeringPath(2027, "Proyecto", "nr5a", ["NR5B"]),
  );
});
