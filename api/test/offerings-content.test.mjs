import assert from "node:assert/strict";
import test from "node:test";
import { mayRead } from "../dist/offerings/content.js";
import { arrangeUnits, checkHome } from "../dist/offerings/home.js";

// F4's visibility rule on its own — the half that is a decision rather than a
// join. That it is one function is the point: the home's article list and the
// article's own page both call it, so they cannot disagree about what a visitor
// is allowed to see. The queries around it are in `db.test.mjs`.

const ANON = { editLibrary: false, manageOffering: false, seeOwnMarks: false };
const STUDENT = { ...ANON, seeOwnMarks: true };
const TEACHER = { ...ANON, manageOffering: true };
const LIBRARIAN = { ...ANON, editLibrary: true };

/** A use of an article that is published in the library and shown since 2020. */
function use(overrides = {}) {
  return {
    published: true,
    publishedAt: new Date("2020-01-01T00:00:00Z"),
    restricted: false,
    ...overrides,
  };
}

test("a published, unrestricted article is readable by nobody in particular", () => {
  assert.equal(mayRead(use(), ANON), true);
});

test("an article the library never published is not readable, however it is used", () => {
  // The offering can date its use whenever it likes; there is still no body to
  // serve, because the body is the library's published version (F8).
  assert.equal(mayRead(use({ published: false }), ANON), false);
  assert.equal(mayRead(use({ published: false }), STUDENT), false);
});

test("a use with no publish date is the teacher's alone", () => {
  const unpublished = use({ publishedAt: null });
  assert.equal(mayRead(unpublished, ANON), false);
  assert.equal(mayRead(unpublished, STUDENT), false, "not even the class");
  assert.equal(mayRead(unpublished, TEACHER), true);
});

test("a publish date in the future has not happened yet", () => {
  const now = new Date("2027-03-01T00:00:00Z");
  const soon = use({ publishedAt: new Date("2027-03-02T00:00:00Z") });
  assert.equal(mayRead(soon, ANON, now), false);
  // The same row, a day later. Nothing was written in between: the rule reads
  // the clock so a teacher can file next week's work today.
  assert.equal(mayRead(soon, ANON, new Date("2027-03-03T00:00:00Z")), true);
});

test("restricted is the enrolled and the staff, and nobody else", () => {
  const exam = use({ restricted: true });
  assert.equal(mayRead(exam, ANON), false, "an exam statement is not public");
  assert.equal(mayRead(exam, STUDENT), true, "seeOwnMarks is enrolment (F5)");
  assert.equal(mayRead(exam, TEACHER), true);
});

test("editing the subject's library is enough to preview any of its offerings", () => {
  // F5's `editLibrary` is teaching *any* offering of the subject, in any year.
  // Someone who can change the article can see how it is being used.
  const hidden = use({ publishedAt: null, restricted: true });
  assert.equal(mayRead(hidden, LIBRARIAN), true);
});

test("staff read past the clock, so there is no preview mode to build", () => {
  const next = use({ publishedAt: new Date("2030-01-01T00:00:00Z") });
  assert.equal(mayRead(next, TEACHER), true);
  assert.equal(mayRead(next, ANON), false);
});

/* ── F14, F15: the home's configuration ──────────────────────────────────── */

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const U3 = "00000000-0000-4000-8000-000000000003";
const program = [U1, U2, U3].map((id, position) => ({
  id,
  title: `Unidad ${position + 1}`,
  contents: "",
  position,
}));
const ids = (units) => units.map((unit) => unit.id);

function home(overrides = {}) {
  return { sections: ["program", "links"], links: [], ...overrides };
}

test("an offering's order wins, and a unit it never listed goes last in library order", () => {
  // U1 and U3 unlisted: a unit added to the library after the offering was
  // arranged still reaches it (F15's propagation).
  assert.deepEqual(ids(arrangeUnits(program, [U2], [], false)), [U2, U1, U3]);
  assert.deepEqual(ids(arrangeUnits(program, [], [], false)), [U1, U2, U3]);
});

test("an id left behind by a deleted unit matches nothing", () => {
  const gone = "00000000-0000-4000-8000-00000000dead";
  assert.deepEqual(ids(arrangeUnits(program, [gone, U3, U1], [gone], false)), [
    U3,
    U1,
    U2,
  ]);
});

test("a hidden unit is absent for students and flagged for staff", () => {
  assert.deepEqual(ids(arrangeUnits(program, [], [U2], false)), [U1, U3]);
  const staff = arrangeUnits(program, [], [U2], true);
  assert.deepEqual(
    staff.map((unit) => unit.hidden),
    [false, true, false],
  );
});

test("checkHome takes a whole configuration and hands it back clean", () => {
  const saved = checkHome(
    home({
      links: [{ title: "  Grupo ", url: "https://chat.whatsapp.com/abc" }],
      unitOrder: [U2.toUpperCase(), U2],
    }),
  );
  assert.deepEqual(saved, {
    sections: ["program", "links"],
    links: [{ title: "Grupo", url: "https://chat.whatsapp.com/abc" }],
    unitOrder: [U2],
    hiddenUnits: [],
  });
});

test("a link is http or https, and nothing else gets to be an href", () => {
  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/relative/path",
    "chat.whatsapp.com/abc",
    "ftp://example.com/x",
  ]) {
    assert.throws(
      () => checkHome(home({ links: [{ title: "x", url }] })),
      { status: 400 },
      url,
    );
  }
  assert.throws(
    () => checkHome(home({ links: [{ title: " ", url: "https://a.b" }] })),
    { status: 400 },
  );
});

test("sections are the api's four names, each once", () => {
  assert.throws(() => checkHome(home({ sections: ["timetable"] })), {
    status: 400,
  });
  assert.throws(() => checkHome(home({ sections: ["links", "links"] })), {
    status: 400,
  });
  assert.throws(() => checkHome(home({ sections: undefined })), {
    status: 400,
  });
  assert.deepEqual(checkHome(home({ sections: [] })).sections, []);
});

test("the lists have ceilings", () => {
  const link = { title: "x", url: "https://a.b" };
  assert.throws(
    () => checkHome(home({ links: Array.from({ length: 51 }, () => link) })),
    { status: 400 },
  );
  assert.throws(() => checkHome(home({ hiddenUnits: ["not-a-uuid"] })), {
    status: 400,
  });
});
