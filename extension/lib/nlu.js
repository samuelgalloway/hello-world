// Pure, non-AI helpers for the voice-browser decision loop.
//
// TypeSafe's Jev model returns typed judgments (choice/noul/score), not
// generated text (see SKILL.md: "Keep known rules, calculations, exact
// lookups, and execution in code"). So anything that's really just string
// wrangling -- pulling a literal value out of an utterance, recognizing a
// URL, building the request payload, applying the model's answer -- lives
// here as ordinary code, not as a model call. The model is only asked to
// judge things that need real language/page understanding: which action,
// and which candidate element or shortcut the user means.

import { choice } from "./typesafe.js";

const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

/**
 * Best-effort extraction of the literal value a "type" instruction should
 * enter, plus whether that extraction is confident enough to use as-is.
 * `exact: false` means we only have the raw transcript to go on -- the
 * caller should treat that as a candidate for composition by a real
 * generative model (see lib/anthropic.js) rather than typing it verbatim.
 */
export function extractTypedValueDetailed(transcript) {
  const text = (transcript ?? "").trim();
  if (!text) return { value: "", exact: true };

  for (const [open, close] of QUOTE_PAIRS) {
    const start = text.indexOf(open);
    const end = start >= 0 ? text.indexOf(close, start + 1) : -1;
    if (start >= 0 && end > start) {
      return { value: text.slice(start + 1, end).trim(), exact: true };
    }
  }

  const patterns = [
    /^(?:please\s+)?(?:type|enter|input)\s+(?:in\s+)?(.+?)(?:\s+(?:into|in|on)\s+the\s+\S.*)?$/i,
    /^(?:please\s+)?fill\s+in\s+(.+?)(?:\s+(?:into|in|on)\s+the\s+\S.*)?$/i,
    /^(?:please\s+)?search\s+for\s+(.+)$/i,
    /(?:name|value|email|text|it)\s+is\s+(.+)$/i,
    /^set\s+(?:it|this|that|the\s+\S+)\s+to\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) return { value: m[1].trim(), exact: true };
  }

  return { value: text, exact: false };
}

/** Convenience wrapper over extractTypedValueDetailed() for callers that just want the string. */
export function extractTypedValue(transcript) {
  return extractTypedValueDetailed(transcript).value;
}

/** Strip a leading navigation verb phrase, e.g. "go to X" -> "X". */
export function extractNavigationPhrase(transcript) {
  const text = (transcript ?? "").trim();
  const m = text.match(
    /^(?:please\s+)?(?:go\s+to|navigate\s+to|open|pull\s+up|visit|take\s+me\s+to)\s+(.+)$/i,
  );
  return (m ? m[1] : text).trim();
}

const DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i;

export function looksLikeUrl(text) {
  return DOMAIN_RE.test((text ?? "").trim());
}

/** Resolve free text to a navigable URL: a real URL/domain, or a search query. */
export function normalizeToUrl(text) {
  const value = (text ?? "").trim();
  if (!value) return "https://www.google.com";
  if (looksLikeUrl(value)) {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

const ACTION_CRITERIA = {
  click: "Click a specific interactive element on the page (button, link, tab, checkbox, etc.).",
  type: "Type or dictate text into a specific input field, textarea, or editable area on the page.",
  navigate: "Go to a different website or a saved shortcut; not an element on the current page.",
  scroll: "Scroll the page to bring an element into view, without clicking or typing.",
  go_back: "Go back to the previous page in browser history.",
  go_forward: "Go forward to the next page in browser history.",
  submit: "Submit the current form, e.g. after filling fields, or pressing search/save/continue.",
  undo: "Undo the previous action: restore the last typed value, or go back after the last navigation/click.",
  unclear:
    "The instruction doesn't map to a concrete browser action, or is missing information needed to act.",
};

const RISKY_KEYWORDS = [
  "delete",
  "remove",
  "revoke",
  "deactivate",
  "disable",
  "deny",
  "reject",
  "ban",
  "terminate",
  "cancel",
  "charge",
  "pay",
  "purchase",
  "refund",
  "suspend",
  "block",
];
const CONFIDENCE_THRESHOLD = 0.55;
const RISK_GATED_ACTIONS = ["click", "submit", "navigate", "type"];

/**
 * Decide whether a decision should be confirmed out loud before acting,
 * based on plain keyword matching and the model's own reported confidence
 * -- not a model call, since "does this word appear" and "is this number
 * below a threshold" are exact rules, not judgments.
 */
export function assessRisk(decision, transcript) {
  if (!RISK_GATED_ACTIONS.includes(decision.action)) return { risky: false };

  const haystack = `${decision.targetLabel || ""} ${transcript || ""}`.toLowerCase();
  const keywordHit = RISKY_KEYWORDS.find((k) => haystack.includes(k));
  if (keywordHit) {
    return { risky: true, reason: `that looks like it might ${keywordHit} something` };
  }

  if (typeof decision.confidence === "number" && decision.confidence < CONFIDENCE_THRESHOLD) {
    return { risky: true, reason: "I'm not fully sure that's what you meant" };
  }

  return { risky: false };
}

/**
 * Build the systemOne request for one voice turn.
 *
 * @param {object} args
 * @param {string} args.transcript
 * @param {{url: string, title: string}} args.page
 * @param {Array<{id: number, tag: string, role: string|null, label: string}>} args.candidates
 * @param {Array<{name: string, url: string}>} args.shortcuts
 * @param {Array<{name: string, steps: string[]}>} [args.macros]
 * @param {Array<{transcript: string, action: string, targetLabel?: string}>} [args.history]
 */
export function buildDecisionRequest({ transcript, page, candidates, shortcuts, macros = [], history = [] }) {
  const state = {
    transcript,
    page,
    recent_actions: history.slice(-5),
    candidates: candidates.map((c) => ({ id: c.id, tag: c.tag, role: c.role, label: c.label })),
    site_shortcuts: shortcuts.map((s) => s.name),
  };

  const questions = {
    action: choice(
      "Given the user's spoken instruction, the current page, and recent actions, what should the browser do next?",
      ACTION_CRITERIA,
    ),
  };

  if (candidates.length > 0) {
    const criteria = { none: "No listed candidate matches, or no page element is needed." };
    for (const c of candidates) {
      criteria[String(c.id)] = `<${c.tag}${c.role ? ` role="${c.role}"` : ""}> ${c.label || "(no visible label)"}`;
    }
    questions.target_element = choice(
      "If the action targets an element on the page (click/type/scroll/submit), which candidate id matches the user's instruction?",
      criteria,
    );
  }

  if (shortcuts.length > 0) {
    const criteria = { other: "None of the saved shortcuts match, or the action isn't navigation." };
    for (const s of shortcuts) criteria[s.name] = `Saved shortcut for ${s.url}`;
    questions.navigate_target = choice(
      "If the action is navigate, which saved shortcut is the user asking for?",
      criteria,
    );
  }

  if (macros.length > 0) {
    const criteria = {
      none: "Not asking to run any saved macro; treat this as a normal single-step instruction.",
    };
    for (const m of macros) criteria[m.name] = `Run the saved "${m.name}" macro (${m.steps.length} recorded steps).`;
    questions.macro = choice(
      "Is the user's instruction asking to run one of these saved macros (a named recorded sequence)?",
      criteria,
    );
  }

  return { state, questions };
}

/**
 * Turn a systemOne response into a concrete decision, applying the
 * code-side rules (value extraction, URL resolution) around the model's
 * typed judgments.
 */
export function parseDecision({ answers, transcript, candidates, shortcuts, macros = [] }) {
  if (answers.macro && answers.macro.choice !== "none") {
    const macro = macros.find((m) => m.name === answers.macro.choice);
    if (macro) {
      return { action: "macro", macroName: macro.name, steps: macro.steps, confidence: answers.macro.confidence };
    }
  }

  const action = answers.action.choice;
  const decision = { action, confidence: answers.action.confidence };

  const needsTarget = ["click", "type", "scroll", "submit"].includes(action);
  if (needsTarget) {
    const targetAnswer = answers.target_element;
    const chosenId = targetAnswer && targetAnswer.choice !== "none" ? Number(targetAnswer.choice) : null;
    const target = chosenId !== null ? candidates.find((c) => c.id === chosenId) : null;
    if (!target) {
      return { action: "unclear", reason: `No matching page element found for "${transcript}".` };
    }
    decision.targetId = target.id;
    decision.targetLabel = target.label;
  }

  if (action === "navigate") {
    const navAnswer = answers.navigate_target;
    const shortcutName = navAnswer && navAnswer.choice !== "other" ? navAnswer.choice : null;
    const shortcut = shortcutName ? shortcuts.find((s) => s.name === shortcutName) : null;
    decision.navigateUrl = shortcut ? shortcut.url : normalizeToUrl(extractNavigationPhrase(transcript));
  }

  if (action === "type") {
    const { value, exact } = extractTypedValueDetailed(transcript);
    decision.value = value;
    decision.valueIsExact = exact;
  }

  return decision;
}
