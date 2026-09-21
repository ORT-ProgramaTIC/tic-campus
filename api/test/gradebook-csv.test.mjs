import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCsv,
  diffImport,
  exportGradebook,
  parseCsv,
  parseHeader,
  studentKeys,
} from "../dist/offerings/gradebook-csv.js";

// F27's file, on its own: the dialect, the headers, the spellings and the diff.
// The reads around it and the one transaction the apply runs in are in
// `db.test.mjs`.

const TP = "00000000-0000-4000-8000-000000000001";
const CLASE = "00000000-0000-4000-8000-000000000002";
const CONCEPTO = "00000000-0000-4000-8000-000000000003";
const TERM = "00000000-0000-4000-8000-000000000004";
const SCALE = "00000000-0000-4000-8000-000000000005";
const MB = "00000000-0000-4000-8000-000000000006";
const E = "00000000-0000-4000-8000-000000000007";

const SETUP = {
  groups: [],
  terms: [{ id: TERM, name: "1er trimestre", position: 0, formula: null }],
  scales: [
    {
      id: SCALE,
      name: "Concepto",
      position: 0,
      levels: [
        { id: MB, name: "MB", position: 0, value: 8.5 },
        { id: E, name: "E", position: 1, value: 10 },
      ],
    },
  ],
  finalFormula: null,
  redoPolicy: "max",
};

const activity = (id, slug, title, valueType, scaleId = null) => ({
  id,
  articleId: id,
  slug,
  title,
  groupId: null,
  termId: null,
  valueType,
  scaleId,
  dueAt: null,
  resultsPublishedAt: null,
  position: 0,
  covers: [],
});

const mark = (studentId, activityId, value, extra = {}) => ({
  activityId,
  studentId,
  value,
  scaleLevelId: null,
  feedback: null,
  recordedBy: 1,
  recordedAt: new Date(0),
  ...extra,
});

const GRID = {
  activities: [
    activity(TP, "tp-sql", "=TP SQL", "numeric"),
    activity(CLASE, "clase-1", "Clase 1", "done"),
    activity(CONCEPTO, "concepto", "Concepto", "scale", SCALE),
  ],
  students: [
    { id: 10, name: "Ana", surname: "Pérez", enrolled: true },
    { id: 11, name: "Beto", surname: "Gómez", enrolled: true },
    { id: 12, name: "Ido", surname: "Se", enrolled: false },
  ],
  results: [
    mark(10, TP, 7.5, { feedback: "bien" }),
    mark(10, CLASE, 1),
    mark(10, CONCEPTO, 8.5, { scaleLevelId: MB }),
    mark(12, TP, 4),
  ],
};

const OFFICIAL = [
  {
    termId: TERM,
    studentId: 10,
    value: 8,
    observation: "atenta",
    suggestion: null,
    recordedBy: 1,
    recordedAt: new Date(0),
  },
];

const PEOPLE = [
  { id: 10, dni: "30111222" },
  { id: 11, dni: "30111333" },
  { id: 12, dni: "30111444" },
  { id: 99, dni: "30999999" },
];
const WRITABLE = new Set([10, 11, 12]);

const diff = (text) =>
  diffImport({
    rows: parseCsv(text),
    setup: SETUP,
    grid: GRID,
    officialGrades: OFFICIAL,
    people: PEOPLE,
    writable: WRITABLE,
  });

const exported = () =>
  exportGradebook(
    SETUP,
    GRID,
    OFFICIAL,
    new Map([
      [10, "30111222"],
      [11, "30111333"],
    ]),
  );

/* ── Bytes and cells ─────────────────────────────────────────────────────── */

test("UTF-8 loses its BOM, and Latin-1 is read as Latin-1", () => {
  const utf8 = Buffer.from("\uFEFFApellido;Pérez", "utf8");
  assert.equal(decodeCsv(utf8), "Apellido;Pérez");
  const latin1 = Buffer.from("Apellido;Pérez", "latin1");
  assert.equal(decodeCsv(latin1), "Apellido;Pérez");
});

test("the separator is the header's, and quotes hold anything", () => {
  assert.deepEqual(parseCsv("a;b\r\n1,5;2\r\n"), [
    ["a", "b"],
    ["1,5", "2"],
  ]);
  assert.deepEqual(parseCsv('a,b\n"x, ""y""\nz",2\n\n'), [
    ["a", "b"],
    ['x, "y"\nz', "2"],
  ]);
});

test("a header is matched on its brackets", () => {
  assert.deepEqual(parseHeader(" DNI "), { kind: "dni" });
  assert.deepEqual(parseHeader("Nombre"), { kind: "ignored" });
  assert.deepEqual(parseHeader("Otro título [tp-sql]"), {
    kind: "activity",
    slug: "tp-sql",
  });
  assert.deepEqual(parseHeader("1er trimestre [Nota oficial]"), {
    kind: "official",
    term: "1er trimestre",
  });
  assert.deepEqual(parseHeader("'-raro [nota oficial]"), {
    kind: "official",
    term: "-raro",
  });
  assert.equal(parseHeader("TP [No Es Slug]"), null);
  assert.equal(parseHeader("Promedio"), null);
});

/* ── Export ──────────────────────────────────────────────────────────────── */

test("the export is the enrolled, spelled for es-AR Excel", () => {
  const text = exported();
  assert.ok(text.startsWith("\uFEFF"));
  const lines = text.slice(1).split("\r\n");
  assert.equal(
    lines[0],
    "Id;DNI;Apellido;Nombre;'=TP SQL [tp-sql];Clase 1 [clase-1];Concepto [concepto];1er trimestre [nota oficial]",
    "a title that looks like a formula is defused",
  );
  assert.equal(lines[1], "10;30111222;Pérez;Ana;7,5;hecho;MB;8");
  assert.equal(lines[2], "11;30111333;Gómez;Beto;;;;");
  assert.ok(!text.includes("Ido"), "somebody who left is not in the file");
});

test("an export imported back changes nothing", () => {
  const result = diff(decodeCsv(Buffer.from(exported(), "utf8")));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.changes, []);
  assert.equal(result.unchanged, 4);
});

/* ── Import ──────────────────────────────────────────────────────────────── */

test("only changed cells are the write set, and they keep their texts", () => {
  const result = diff(
    [
      "Id;DNI;Clase 1 [clase-1];Otro nombre [tp-sql];Concepto [concepto];1er trimestre [nota oficial]",
      "10;;hecho;8,25;e;9",
      ";30.111.333;No Hecho;;;7.5",
    ].join("\n"),
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.unchanged, 1, "Ana's hecho is already there");
  assert.deepEqual(
    result.changes.map((c) => [c.studentId, c.from, c.to]),
    [
      [10, "7,5", "8,25"],
      [10, "MB", "E"],
      [10, "8", "9"],
      [11, null, "no hecho"],
      [11, null, "7,5"],
    ],
  );
  assert.deepEqual(result.entries, [
    {
      studentId: 10,
      activityId: TP,
      clear: false,
      feedback: "bien",
      value: 8.25,
    },
    {
      studentId: 10,
      activityId: CONCEPTO,
      clear: false,
      feedback: null,
      scaleLevelId: E,
    },
    {
      studentId: 11,
      activityId: CLASE,
      clear: false,
      feedback: null,
      done: false,
    },
  ]);
  assert.deepEqual(result.grades, [
    {
      studentId: 10,
      termId: TERM,
      clear: false,
      value: 9,
      observation: "atenta",
      suggestion: null,
    },
    {
      studentId: 11,
      termId: TERM,
      clear: false,
      value: 7.5,
      observation: null,
      suggestion: null,
    },
  ]);
});

test("the id wins over the DNI, and names are ignored", () => {
  const result = diff("Id,DNI,Nombre,TP [tp-sql]\n11,30111222,Ana,9\n");
  assert.deepEqual(result.problems, []);
  assert.equal(result.changes[0].studentId, 11);
});

test("every problem is listed, and none of them is written", () => {
  const result = diff(
    [
      "Id;TP [tp-sql];TP [tp-sql];Viejo [borrada];Clase 1 [clase-1];2do [nota oficial]",
      "404;9;;;;",
      "99;9;;;;",
      "10;11;;;quizás;",
      "10;9;;;;",
      ";9;;;;",
    ].join("\n"),
  );
  assert.deepEqual(
    result.problems.map((p) => [p.row, p.code]),
    [
      [1, "duplicate_column"],
      [1, "unknown_column"],
      [1, "unknown_column"],
      [2, "unknown_student"],
      [3, "not_writable"],
      [4, "bad_value"],
      [4, "bad_value"],
      [5, "duplicate_student"],
      [6, "no_student_key"],
    ],
  );
});

test("a file without Id or DNI names nobody", () => {
  assert.deepEqual(
    diff("Nombre;TP [tp-sql]\nAna;9").problems.map((p) => p.code),
    ["no_student_key"],
  );
  assert.deepEqual(studentKeys(parseCsv("Id;DNI\n7;12.345.678\n;x")), {
    ids: [7],
    dnis: ["12345678"],
  });
});
