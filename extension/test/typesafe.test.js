import { test } from "node:test";
import assert from "node:assert/strict";
import { systemOne, choice, noul, score, TypeSafeAPIError } from "../lib/typesafe.js";

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test("choice/noul/score build the documented question shapes", () => {
  assert.deepEqual(choice("pick one", { a: "A", b: "B" }), {
    type: "choice",
    instructions: "pick one",
    criteria: { a: "A", b: "B" },
  });
  assert.deepEqual(noul("is it billing?"), { type: "noul", instructions: "is it billing?" });
  assert.deepEqual(score("rate it", ["low", "high"]), {
    type: "score",
    instructions: "rate it",
    criteria: ["low", "high"],
  });
  assert.throws(() => score("rate it", ["only one"]), /at least two/);
  assert.throws(() => choice("pick", ["not", "an", "object"]), /label -> description/);
});

test("systemOne sends the documented request and parses a typed response", async () => {
  let seenUrl, seenInit;
  const fetchImpl = fakeFetch(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: { action: { type: "choice", choice: "click", confidence: 0.92, probabilities: { click: 0.92 } } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await systemOne({
    apiKey: "sk-test",
    state: { transcript: "click save" },
    questions: { action: choice("what next?", { click: "click something", type: null }) },
    fetchImpl,
  });

  assert.equal(seenUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seenInit.headers.Authorization, "Bearer sk-test");
  const sentBody = JSON.parse(seenInit.body);
  assert.equal(sentBody.model, "jev-latest");
  assert.equal(sentBody.questions.action.type, "choice");
  assert.equal(result.answers.action.choice, "click");
});

test("systemOne throws TypeSafeAPIError on a non-2xx response", async () => {
  const fetchImpl = fakeFetch(
    async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
  );
  await assert.rejects(
    systemOne({ apiKey: "sk-test", questions: { a: choice("x", { a: null }) }, fetchImpl }),
    (err) => {
      assert.ok(err instanceof TypeSafeAPIError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("systemOne rejects empty questions without making a request", async () => {
  let called = false;
  const fetchImpl = fakeFetch(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(systemOne({ apiKey: "sk-test", questions: {}, fetchImpl }), /non-empty/);
  assert.equal(called, false);
});
