import assert from "node:assert/strict";
import { test } from "node:test";
import { fold, matches } from "../src/text.ts";

// Ported with tic-registry's own cases (`web/src/lib/text.test.ts`, F48).

test("fold strips the accents Spanish uses, and ñ", () => {
  assert.equal(fold("Gómez"), "gomez");
  assert.equal(fold("MARTÍNEZ"), "martinez");
  assert.equal(fold("Ángel Jesús"), "angel jesus");
  assert.equal(fold("Muñoz"), "munoz");
});

test("fold collapses pasted double spaces", () => {
  assert.equal(fold("Ana  María  "), "ana maria");
});

test("a decomposed string folds like a composed one", () => {
  const composed = "José";
  const decomposed = "José";
  assert.notEqual(composed, decomposed);
  assert.equal(fold(composed), fold(decomposed));
});

test("matches: accents, any order, empty shows all, absent word fails", () => {
  assert.equal(matches("Muñoz Iván", "munoz"), true);
  assert.equal(matches("Ana Muñoz", "munoz ana"), true);
  assert.equal(matches("Ana Muñoz", "ana munoz"), true);
  assert.equal(matches("cualquiera", "   "), true);
  assert.equal(matches("Ana Gómez", "gomez pedro"), false);
});
