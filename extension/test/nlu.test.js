import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTypedValue,
  extractNavigationPhrase,
  looksLikeUrl,
  normalizeToUrl,
  buildDecisionRequest,
  parseDecision,
} from "../lib/nlu.js";

test("extractTypedValue prefers quoted content", () => {
  assert.equal(extractTypedValue('type "John Smith" into the name field'), "John Smith");
  assert.equal(extractTypedValue("enter 'jane@example.com'"), "jane@example.com");
});

test("extractTypedValue strips common command verbs and trailing field phrase", () => {
  assert.equal(extractTypedValue("type John Smith into the name field"), "John Smith");
  assert.equal(extractTypedValue("enter John Smith"), "John Smith");
  assert.equal(extractTypedValue("fill in John Smith"), "John Smith");
  assert.equal(extractTypedValue("search for wireless headphones"), "wireless headphones");
  assert.equal(extractTypedValue("her name is Jane Doe"), "Jane Doe");
});

test("extractTypedValue falls back to the whole transcript", () => {
  assert.equal(extractTypedValue("John Smith"), "John Smith");
});

test("extractNavigationPhrase strips leading navigation verbs", () => {
  assert.equal(extractNavigationPhrase("go to gmail"), "gmail");
  assert.equal(extractNavigationPhrase("pull up the permissions dashboard"), "the permissions dashboard");
  assert.equal(extractNavigationPhrase("gmail"), "gmail");
});

test("looksLikeUrl recognizes domains but not plain phrases", () => {
  assert.equal(looksLikeUrl("example.com"), true);
  assert.equal(looksLikeUrl("https://docs.typesafe.ai/api"), true);
  assert.equal(looksLikeUrl("www.example.com/path"), true);
  assert.equal(looksLikeUrl("the permissions dashboard"), false);
});

test("normalizeToUrl builds a search URL for non-domain text", () => {
  assert.equal(normalizeToUrl("example.com"), "https://example.com");
  assert.equal(normalizeToUrl("https://example.com"), "https://example.com");
  assert.equal(
    normalizeToUrl("wireless headphones"),
    "https://www.google.com/search?q=wireless%20headphones",
  );
});

test("buildDecisionRequest omits target_element/navigate_target when empty", () => {
  const { questions } = buildDecisionRequest({
    transcript: "go to gmail",
    page: { url: "https://example.com", title: "Example" },
    candidates: [],
    shortcuts: [],
  });
  assert.ok(questions.action);
  assert.equal(questions.target_element, undefined);
  assert.equal(questions.navigate_target, undefined);
});

test("buildDecisionRequest includes candidate/shortcut criteria when present", () => {
  const { questions } = buildDecisionRequest({
    transcript: "click create user",
    page: { url: "https://example.com", title: "Example" },
    candidates: [{ id: 1, tag: "button", role: null, label: "Create user" }],
    shortcuts: [{ name: "permissions", url: "https://internal.example.com/permissions" }],
  });
  assert.deepEqual(Object.keys(questions.target_element.criteria).sort(), ["1", "none"]);
  assert.deepEqual(Object.keys(questions.navigate_target.criteria).sort(), ["other", "permissions"]);
});

test("parseDecision resolves a click against candidates", () => {
  const decision = parseDecision({
    answers: {
      action: { choice: "click", confidence: 0.9 },
      target_element: { choice: "3", confidence: 0.8 },
    },
    transcript: "click create user",
    candidates: [{ id: 3, tag: "button", role: null, label: "Create user" }],
    shortcuts: [],
  });
  assert.equal(decision.action, "click");
  assert.equal(decision.targetId, 3);
  assert.equal(decision.targetLabel, "Create user");
});

test("parseDecision downgrades to unclear when no candidate matches", () => {
  const decision = parseDecision({
    answers: { action: { choice: "click", confidence: 0.4 }, target_element: { choice: "none" } },
    transcript: "click the thing",
    candidates: [{ id: 1, tag: "button", role: null, label: "Save" }],
    shortcuts: [],
  });
  assert.equal(decision.action, "unclear");
});

test("parseDecision resolves navigate via shortcut, then via heuristic fallback", () => {
  const viaShortcut = parseDecision({
    answers: {
      action: { choice: "navigate", confidence: 0.95 },
      navigate_target: { choice: "permissions" },
    },
    transcript: "open the permissions tool",
    candidates: [],
    shortcuts: [{ name: "permissions", url: "https://internal.example.com/permissions" }],
  });
  assert.equal(viaShortcut.navigateUrl, "https://internal.example.com/permissions");

  const viaHeuristic = parseDecision({
    answers: { action: { choice: "navigate", confidence: 0.7 } },
    transcript: "go to gmail.com",
    candidates: [],
    shortcuts: [],
  });
  assert.equal(viaHeuristic.navigateUrl, "https://gmail.com");
});

test("parseDecision extracts a typed value", () => {
  const decision = parseDecision({
    answers: {
      action: { choice: "type", confidence: 0.9 },
      target_element: { choice: "1" },
    },
    transcript: 'type "Jane Doe" into the name field',
    candidates: [{ id: 1, tag: "input", role: null, label: "Full name" }],
    shortcuts: [],
  });
  assert.equal(decision.value, "Jane Doe");
});
