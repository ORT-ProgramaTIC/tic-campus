import assert from "node:assert/strict";
import test from "node:test";
import { mayRead } from "../dist/offerings/content.js";

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
