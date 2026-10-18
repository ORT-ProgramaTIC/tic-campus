import assert from "node:assert/strict";
import { test } from "node:test";
import { surnames } from "../src/labels.ts";

const m = (name, surname) => ({ name, surname, track: "backend" });

test("a team reads as its surnames; a shared one gets the initial", () => {
  const team = {
    projectId: 1,
    name: "EcoRiego",
    members: [m("Mora", "García"), m("Lucas", "López"), m("Tomás", "García")],
  };
  assert.equal(surnames(team), "García M. · López · García T.");
});

test("no members, no surname, no team", () => {
  assert.equal(surnames({ projectId: 1, name: "EcoRiego", members: [] }), "EcoRiego");
  assert.equal(
    surnames({ projectId: 1, name: "X", members: [m("Ana", null)] }),
    "Ana",
  );
  assert.equal(surnames(undefined), "Grupo eliminado");
});
