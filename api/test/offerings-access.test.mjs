import assert from "node:assert/strict";
import test from "node:test";
import {
  actorFrom,
  capabilitiesFor,
  isAdmin,
  NONE,
} from "../dist/offerings/access.js";

// The part of F5 that is a decision about the token rather than a query. The
// queries are in `db.test.mjs`, where there is a directory to run them against.

test("admin is a role key, not a prefix", () => {
  assert.equal(isAdmin(["admin"]), true);
  assert.equal(isAdmin(["teacher", "admin"]), true);
  // tic-hosting's operators. tic-auth's `0008` is explicit that it grants
  // nothing in the directory, and a `startsWith` here would hand every VM
  // operator the gradebook.
  assert.equal(isAdmin(["admin-hosting"]), false);
  assert.equal(isAdmin([]), false);
});

test("an actor carries the roles whole", () => {
  const actor = actorFrom(42, { roles: ["teacher", "mep"], email: null });
  assert.deepEqual(actor, {
    userId: 42,
    roles: ["teacher", "mep"],
    isAdmin: false,
  });
});

test("an admin is granted everything without asking the database", async () => {
  // The `db` below would throw on any use: reaching it at all is the failure
  // this asserts against.
  const unusable = new Proxy(
    {},
    {
      get() {
        throw new Error("an admin must not need a query");
      },
    },
  );
  assert.deepEqual(
    await capabilitiesFor(unusable, actorFrom(1, { roles: ["admin"] }), 7, 3),
    { editLibrary: true, manageOffering: true, seeOwnMarks: true },
  );
});

test("nobody signed in still has a shape", () => {
  // The public offering read projects this rather than omitting the key, so a
  // client has one thing to render and no branch on whether it is there.
  assert.deepEqual(NONE, {
    editLibrary: false,
    manageOffering: false,
    seeOwnMarks: false,
  });
});
