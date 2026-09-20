// The two things about the session cookie that are security properties rather
// than formatting, and the `next` sanitiser.
import assert from "node:assert/strict";
import test from "node:test";
import { clear, cookieSpec, read, serialize } from "../dist/auth/cookies.js";
import { idFor, newSecret } from "../dist/auth/session-store.js";
import { sanitizeNext } from "../dist/routes/auth.js";

test("production gets __Host- and Secure; a laptop gets neither, under another name", () => {
  const live = cookieSpec({ production: true }, "session");
  assert.equal(live.name, "__Host-tic_campus_session");
  const header = serialize(live, "abc", 3600);
  assert.match(header, /^__Host-tic_campus_session=abc; Path=\/; /);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Secure/);
  // `__Host-` is refused by browsers if a Domain is named, so there must be none.
  assert.doesNotMatch(header, /Domain/);

  // A different NAME rather than a flag: there is no configuration that could
  // serve the weak form on a real origin, because the weak name is never read
  // there.
  const dev = cookieSpec({ production: false }, "session");
  assert.equal(dev.name, "tic_campus_session_dev");
  assert.doesNotMatch(serialize(dev, "abc", 3600), /Secure/);
});

test("clearing a cookie is Max-Age=0", () => {
  assert.match(clear(cookieSpec({ production: true }, "login")), /Max-Age=0/);
});

test("read picks one cookie out of a header and ignores the rest", () => {
  const header = "other=1; __Host-tic_campus_session=wanted; third=3";
  assert.equal(read(header, "__Host-tic_campus_session"), "wanted");
  assert.equal(read(header, "absent"), null);
  assert.equal(read(undefined, "anything"), null);
});

// `//evil.test` and `/\evil.test` are the two that look like paths and are not:
// every browser reads both as protocol-relative authorities. `startsWith('/')`
// alone is the open redirect.
test("next takes a path on this app and nothing else", () => {
  assert.equal(
    sanitizeNext("/2027/bases-de-datos/5to/tp-sql"),
    "/2027/bases-de-datos/5to/tp-sql",
  );
  assert.equal(sanitizeNext("//evil.test"), "");
  assert.equal(sanitizeNext("/\\evil.test"), "");
  assert.equal(sanitizeNext("https://evil.test"), "");
  assert.equal(sanitizeNext(undefined), "");
  assert.equal(sanitizeNext(["/a", "/b"]), "");
});

// What the browser holds and what the database holds are deliberately not the
// same string: a dump of `campus.session` yields nothing anybody can present.
test("the stored id is a digest of the cookie value, not the value", () => {
  const secret = newSecret();
  const id = idFor(secret);
  assert.notEqual(id, secret);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(idFor(secret), id, "y es estable");
  assert.notEqual(idFor(newSecret()), id);
});
