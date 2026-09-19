import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText, AnthropicAPIError, DEFAULT_MODEL, ANTHROPIC_VERSION } from "../lib/anthropic.js";

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test("generateText sends the documented request and returns the text block", async () => {
  let seenUrl, seenInit;
  const fetchImpl = fakeFetch(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "  Jane Doe  " }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 4 },
      }),
      { status: 200 },
    );
  });

  const value = await generateText({
    apiKey: "sk-ant-test",
    system: "Return only the literal value to type, nothing else.",
    prompt: 'Field "Full name". Utterance: "her name is jane doe"',
    fetchImpl,
  });

  assert.equal(seenUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(seenInit.headers["x-api-key"], "sk-ant-test");
  assert.equal(seenInit.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(seenInit.headers["anthropic-dangerous-direct-browser-access"], "true");
  const sentBody = JSON.parse(seenInit.body);
  assert.equal(sentBody.model, DEFAULT_MODEL);
  assert.equal(sentBody.messages[0].role, "user");
  assert.equal(value, "Jane Doe");
});

test("generateText throws AnthropicAPIError on a non-2xx response", async () => {
  const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }));
  await assert.rejects(
    generateText({ apiKey: "bad", prompt: "x", fetchImpl }),
    (err) => {
      assert.ok(err instanceof AnthropicAPIError);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("generateText requires an apiKey and a prompt", async () => {
  await assert.rejects(generateText({ prompt: "x", fetchImpl: fakeFetch(async () => new Response("{}")) }), /apiKey/);
  await assert.rejects(generateText({ apiKey: "k", fetchImpl: fakeFetch(async () => new Response("{}")) }), /prompt/);
});
