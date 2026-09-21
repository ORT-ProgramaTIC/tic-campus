import assert from "node:assert/strict";
import test from "node:test";
import { checkRead } from "../dist/offerings/notifications.js";

const ID = "0b8c2a6e-5f1d-4c3a-9e7b-2d4f6a8c0e12";

test("checkRead takes kinds and uuids, and nothing else", () => {
  assert.deepEqual(
    checkRead({
      items: [
        { kind: "result_published", target: ID.toUpperCase() },
        { kind: "result_published", target: ID },
        { kind: "article_published", target: ID },
      ],
    }),
    [
      { kind: "result_published", target: ID },
      { kind: "article_published", target: ID },
    ],
    "lowercased and deduplicated, or one upsert names a row twice",
  );
  for (const body of [
    null,
    {},
    { items: [] },
    { items: [{ kind: "due_soon", target: ID }] },
    { items: [{ kind: "result_published", target: "1" }] },
    { items: [null] },
    {
      items: Array.from({ length: 201 }, () => ({
        kind: "result_published",
        target: ID,
      })),
    },
  ]) {
    assert.throws(() => checkRead(body), { status: 400 }, JSON.stringify(body));
  }
});
