import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRADE_TONE,
  searchRows,
  shortCourse,
  sortRows,
  studentGradeTone,
  trackTone,
} from "../src/grades.ts";

const row = (surname, name, course, projects = [], grade = null) => ({
  studentId: Math.random(),
  surname,
  name,
  course,
  projects,
  enrolled: true,
  grade,
});
const rows = [
  row("Pérez", "Luz", "NR4C", [{ name: "Beta", track: "ux-ui" }]),
  row("Álvarez", "Ana", "NR4A", [{ name: "Alfa", track: "backend" }]),
  row("Muñoz", "Iván", "NR4A"),
];
const surnames = (list) => list.map((one) => one.surname);

test("sort by a column both ways, blanks last in both directions", () => {
  assert.deepEqual(surnames(sortRows(rows, { key: "surname", dir: "asc" })), [
    "Álvarez",
    "Muñoz",
    "Pérez",
  ]);
  assert.deepEqual(surnames(sortRows(rows, { key: "project", dir: "asc" })), [
    "Álvarez",
    "Pérez",
    "Muñoz",
  ]);
  assert.deepEqual(surnames(sortRows(rows, { key: "project", dir: "desc" })), [
    "Pérez",
    "Álvarez",
    "Muñoz",
  ]);
  // Ties fall back to surname: two in NR4A.
  assert.deepEqual(surnames(sortRows(rows, { key: "course", dir: "desc" })), [
    "Pérez",
    "Álvarez",
    "Muñoz",
  ]);
});

test("search by student or by project", () => {
  assert.deepEqual(surnames(searchRows(rows, "student", "ivan munoz")), [
    "Muñoz",
  ]);
  assert.deepEqual(surnames(searchRows(rows, "project", "alfa")), ["Álvarez"]);
  assert.deepEqual(surnames(searchRows(rows, "project", "")), surnames(rows));
});

test("students see every number green; PIA and DICIEMBRE keep theirs", () => {
  for (const value of ["10", "9", "8", "7", "6"]) {
    assert.equal(studentGradeTone(value), GRADE_TONE["10"]);
  }
  assert.equal(studentGradeTone("pia"), GRADE_TONE.pia);
  assert.equal(studentGradeTone("diciembre"), GRADE_TONE.diciembre);
});

test("tracks take tic-registry's colours; an unmapped one is stable", () => {
  assert.equal(trackTone("backend"), "bg-tag-app text-tag-ink");
  assert.equal(trackTone("ux-ui"), "bg-tag-impacto-social text-white");
  assert.equal(trackTone("fullstack"), trackTone("fullstack"));
  assert.equal(shortCourse("NR4A"), "4A");
  assert.equal(shortCourse(null), "");
});
