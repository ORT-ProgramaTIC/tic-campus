import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  checkFilename,
  checkMediaType,
  contentDisposition,
  pathFor,
  serveAs,
} from "../dist/library/uploads.js";

// F9's decisions, without the volume or the database — the writing and the
// reading are in `db.test.mjs`. What is here is the part that would still be
// wrong if every query worked: what a browser is told an uploaded file is, and
// what reaches a path and a response header.

test("what a browser renders is served as itself", () => {
  assert.deepEqual(serveAs("image/png"), {
    contentType: "image/png",
    disposition: "inline",
  });
  assert.deepEqual(serveAs("application/pdf"), {
    contentType: "application/pdf",
    disposition: "inline",
  });
});

// The whole reason `serveAs` exists. Uploads are served from the origin the app
// runs on, so an SVG or an HTML file served inline with the type its uploader
// claimed runs script against a logged-in teacher's session. An allowlist and
// not a denylist: the next format nobody thought about lands on this side.
test("anything a browser might execute is an octet-stream download", () => {
  for (const type of [
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "text/javascript",
    "application/zip",
  ]) {
    assert.deepEqual(
      serveAs(type),
      { contentType: "application/octet-stream", disposition: "attachment" },
      `${type} must not be served inline`,
    );
  }
});

test("a Spanish filename survives Content-Disposition", () => {
  const header = contentDisposition("Guía de TPs.pdf", "inline");
  assert.match(header, /^inline; filename\*=UTF-8''/);
  const encoded = header.slice(header.indexOf("''") + 2);
  assert.equal(decodeURIComponent(encoded), "Guía de TPs.pdf");
  // No raw quotes, semicolons or newlines to end the parameter early.
  assert.doesNotMatch(encoded, /[";\r\n ]/);
});

test("a filename is a name, never a path", () => {
  assert.equal(checkFilename("../../etc/passwd"), "passwd");
  assert.equal(checkFilename("/home/ana/TP 3.pdf"), "TP 3.pdf");
  // A header injection, had the name gone into Content-Disposition raw.
  assert.equal(checkFilename("tp\r\nX-Evil: 1.pdf"), "tpX-Evil: 1.pdf");
});

test("a filename that is not one is refused", () => {
  assert.throws(() => checkFilename(""), /nombre del archivo/);
  assert.throws(() => checkFilename(".."), /nombre del archivo/);
  assert.throws(() => checkFilename(undefined), /nombre del archivo/);
  assert.throws(() => checkFilename("a".repeat(201)), /demasiado largo/);
});

test("a media type campus does not recognise as one is not repeated back", () => {
  assert.equal(checkMediaType("IMAGE/PNG"), "image/png");
  assert.equal(checkMediaType("application/pdf"), "application/pdf");
  assert.equal(
    checkMediaType('text/html; charset="><script>'),
    "application/octet-stream",
  );
  assert.equal(checkMediaType(undefined), "application/octet-stream");
});

test("the path is the id inside the directory, and the id is checked first", () => {
  const dir = "/var/lib/tic-campus/uploads";
  const id = "0f2b7f54-6b5e-4c9e-9f1a-8b0b2d3c4e5f";
  assert.equal(pathFor(dir, id), join(dir, id));
  // `routes/uploads.ts` refuses anything that is not a uuid before it gets
  // here, which is what keeps this from being a traversal.
  assert.equal(pathFor(dir, "../../etc/passwd"), "/var/lib/etc/passwd");
});
