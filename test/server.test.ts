import test from "node:test";
import assert from "node:assert/strict";
import { testables } from "../src/server.ts";

test("normalizes only supported non-empty result fields", () => {
  assert.deepEqual(testables.normalizeResponse({
    output: "answer",
    results: [{ title: " Example ", url: "https://example.com", ignored: "x" }, null, {}],
  }), {
    output: "answer",
    results: [{ title: "Example", url: "https://example.com" }],
  });
});

test("requires a session id for follow-up-only research", () => {
  assert.throws(() => testables.validateResearchInput({ open: [{ ref_id: "turn0search0" }] }), /session_id/);
  assert.doesNotThrow(() => testables.validateResearchInput({
    session_id: "research-a",
    open: [{ ref_id: "turn0search0" }],
  }));
});

test("allows a first search to create an isolated session", () => {
  assert.doesNotThrow(() => testables.validateResearchInput({ search_query: [{ q: "example query" }] }));
  assert.throws(() => testables.validateResearchInput({}), /At least one/);
});
