import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTypedValue,
  extractTypedValueDetailed,
  extractNavigationPhrase,
  looksLikeUrl,
  normalizeToUrl,
  buildDecisionRequest,
  parseDecision,
  assessRisk,
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

test("extractTypedValueDetailed marks quoted/pattern matches exact, raw fallback inexact", () => {
  assert.deepEqual(extractTypedValueDetailed('type "Jane Doe"'), { value: "Jane Doe", exact: true });
  assert.deepEqual(extractTypedValueDetailed("enter Jane Doe"), { value: "Jane Doe", exact: true });
  assert.equal(extractTypedValueDetailed("tell them the meeting moved to 3pm tomorrow").exact, false);
});

test("buildDecisionRequest includes a macro question only when macros exist", () => {
  const withoutMacros = buildDecisionRequest({
    transcript: "create a new user",
    page: { url: "https://example.com", title: "Example" },
    candidates: [],
    shortcuts: [],
  });
  assert.equal(withoutMacros.questions.macro, undefined);

  const withMacros = buildDecisionRequest({
    transcript: "create a new user",
    page: { url: "https://example.com", title: "Example" },
    candidates: [],
    shortcuts: [],
    macros: [{ name: "create a new user", steps: ["go to users", "click new user"] }],
  });
  assert.deepEqual(Object.keys(withMacros.questions.macro.criteria).sort(), ["create a new user", "none"]);
});

test("parseDecision runs a macro when matched, before considering action/target", () => {
  const macros = [{ name: "create a new user", steps: ["go to users", "click new user"] }];
  const decision = parseDecision({
    answers: {
      action: { choice: "unclear", confidence: 0.3 },
      macro: { choice: "create a new user", confidence: 0.88 },
    },
    transcript: "create a new user",
    candidates: [],
    shortcuts: [],
    macros,
  });
  assert.equal(decision.action, "macro");
  assert.equal(decision.macroName, "create a new user");
  assert.deepEqual(decision.steps, macros[0].steps);
});

test("assessRisk flags destructive-sounding targets and low confidence", () => {
  assert.equal(
    assessRisk({ action: "click", targetLabel: "Delete user", confidence: 0.95 }, "click delete user").risky,
    true,
  );
  assert.equal(
    assessRisk({ action: "click", targetLabel: "Save", confidence: 0.9 }, "click save").risky,
    false,
  );
  assert.equal(
    assessRisk({ action: "click", targetLabel: "Save", confidence: 0.3 }, "click save").risky,
    true,
  );
  assert.equal(assessRisk({ action: "scroll", targetLabel: "Delete user", confidence: 0.2 }, "scroll").risky, false);
});
