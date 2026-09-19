// Manifest V3 service worker. No `window`/`document`/`navigator` exist here,
// so this is the one place API keys (TypeSafe, Anthropic) are read and used
// -- never in a content script that runs inside third-party pages.
import { systemOne, TypeSafeAPIError } from "./lib/typesafe.js";
import { buildDecisionRequest, parseDecision, assessRisk } from "./lib/nlu.js";
import { generateText } from "./lib/anthropic.js";

const MAX_HISTORY = 5;
const MAX_CANDIDATES = 60;
const TAB_IDLE_TIMEOUT_MS = 6000;

/** @type {Map<number, Array<{transcript: string, action: string, targetLabel?: string}>>} */
const historyByTab = new Map();

function enablePanelOnActionClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enablePanelOnActionClick);
chrome.runtime.onStartup.addListener(enablePanelOnActionClick);
enablePanelOnActionClick();

// --- settings -----------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get([
    "typesafeApiKey",
    "typesafeModel",
    "shortcuts",
    "anthropicApiKey",
    "macros",
  ]);
  return {
    apiKey: stored.typesafeApiKey || "",
    model: stored.typesafeModel || undefined,
    shortcuts: Array.isArray(stored.shortcuts) ? stored.shortcuts : [],
    anthropicApiKey: stored.anthropicApiKey || "",
    macros: Array.isArray(stored.macros) ? stored.macros : [],
  };
}

// --- pending confirmations, kept in session storage (not module memory) so
// they survive the service worker being killed for inactivity between the
// question and the user's spoken answer -------------------------------

async function getPending(tabId) {
  const key = `pending_${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}
async function setPending(tabId, value) {
  await chrome.storage.session.set({ [`pending_${tabId}`]: value });
}
async function clearPending(tabId) {
  await chrome.storage.session.remove(`pending_${tabId}`);
}

function pushHistory(tabId, entry) {
  const list = historyByTab.get(tabId) || [];
  list.push(entry);
  while (list.length > MAX_HISTORY) list.shift();
  historyByTab.set(tabId, list);
}

// --- multi-frame page state ----------------------------------------------

async function getFrameState(tabId, frameId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, { frameId });
  } catch {
    return null; // no content script there (cross-origin iframe, chrome:// frame, etc.)
  }
}

async function getAllFrameStates(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }
  const frameIds = frames && frames.length ? frames.map((f) => f.frameId) : [0];

  const results = [];
  for (const frameId of frameIds) {
    const state = await getFrameState(tabId, frameId);
    if (state) results.push({ frameId, ...state });
  }
  return results;
}

/** Flatten per-frame candidate lists into one global list with frame-routed ids. */
function aggregateFrameStates(frameStates) {
  const all = [];
  for (const fs of frameStates) {
    for (const el of fs.elements) {
      all.push({ frameId: fs.frameId, localId: el.id, tag: el.tag, role: el.role, label: el.label });
    }
  }
  const capped = all.slice(0, MAX_CANDIDATES);

  const routing = {};
  const candidates = capped.map((item, idx) => {
    routing[idx] = { frameId: item.frameId, localId: item.localId };
    return { id: idx, tag: item.tag, role: item.role, label: item.label };
  });
  return { candidates, routing };
}

function waitForTabIdle(tabId, timeoutMs = TAB_IDLE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        // Already complete (typical for a non-navigating step) - just give
        // in-page scripts a brief beat to settle before the next GET_STATE.
        if (tab.status === "complete") setTimeout(finish, 300);
      })
      .catch(finish);
  });
}

// --- Haiku fallback for composed (non-literal) typed values ---------------

const COMPOSE_SYSTEM_PROMPT =
  "You are filling in a single web form field from a spoken instruction. " +
  "Reply with ONLY the exact literal text that should be typed into the field " +
  "-- no quotes, no explanation, no extra words. If the instruction doesn't " +
  "contain enough information to produce a value, reply with exactly: UNKNOWN";

async function composeTypedValue({ anthropicApiKey, transcript, targetLabel }) {
  if (!anthropicApiKey) return null;
  try {
    const composed = await generateText({
      apiKey: anthropicApiKey,
      system: COMPOSE_SYSTEM_PROMPT,
      prompt: `Field: "${targetLabel || "unlabeled field"}"\nSpoken instruction: "${transcript}"`,
    });
    if (composed && composed.trim().toUpperCase() !== "UNKNOWN") return composed;
  } catch (err) {
    console.warn("Haiku value composition failed, using heuristic value instead:", err);
  }
  return null;
}

// --- undo -----------------------------------------------------------------

async function handleUndo(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }
  const frameIds = frames && frames.length ? frames.map((f) => f.frameId) : [0];

  for (const frameId of frameIds) {
    try {
      const outcome = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE", action: "undo_type" }, { frameId });
      if (outcome?.success) return outcome;
    } catch {
      // no content script in this frame - try the next one
    }
  }

  try {
    await chrome.tabs.goBack(tabId);
    return { success: true, message: "Nothing typed to undo -- went back instead." };
  } catch {
    return { success: false, message: "Nothing to undo." };
  }
}

// --- acting on a decision (shared by the direct path and confirm/resume) --

async function actOnDecision(tabId, decision, routing) {
  switch (decision.action) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: decision.navigateUrl });
      return { success: true, message: `Navigating to ${decision.navigateUrl}` };
    case "go_back":
      try {
        await chrome.tabs.goBack(tabId);
      } catch {
        return { success: false, message: "Nothing to go back to." };
      }
      return { success: true, message: "Went back." };
    case "go_forward":
      try {
        await chrome.tabs.goForward(tabId);
      } catch {
        return { success: false, message: "Nothing to go forward to." };
      }
      return { success: true, message: "Went forward." };
    case "undo":
      return await handleUndo(tabId);
    default: {
      const route = routing[decision.targetId];
      if (!route) return { success: false, message: "Lost track of that element -- try again." };
      try {
        return await chrome.tabs.sendMessage(
          tabId,
          { type: "EXECUTE", action: decision.action, targetId: route.localId, value: decision.value },
          { frameId: route.frameId },
        );
      } catch {
        return { success: false, message: "Lost connection to the page while acting." };
      }
    }
  }
}

// --- the core decide-then-act pipeline for one utterance -------------------

async function decideAndAct(tabId, transcript) {
  const { apiKey, model, shortcuts, macros, anthropicApiKey } = await getSettings();
  if (!apiKey) {
    return { success: false, message: "Set your TypeSafe API key on the extension's options page first." };
  }

  const frameStates = await getAllFrameStates(tabId);
  if (frameStates.length === 0) {
    return {
      success: false,
      message: "Can't control this page (browser settings pages and freshly-opened tabs aren't reachable).",
    };
  }
  const mainFrame = frameStates.find((f) => f.frameId === 0) || frameStates[0];
  const { candidates, routing } = aggregateFrameStates(frameStates);

  const history = historyByTab.get(tabId) || [];
  const { state, questions } = buildDecisionRequest({
    transcript,
    page: { url: mainFrame.url, title: mainFrame.title },
    candidates,
    shortcuts,
    macros,
    history,
  });

  let result;
  try {
    result = await systemOne({ apiKey, state, questions, ...(model ? { model } : {}) });
  } catch (err) {
    const detail = err instanceof TypeSafeAPIError ? `${err.status}: ${JSON.stringify(err.body)}` : err.message;
    return { success: false, message: `TypeSafe request failed (${detail}).` };
  }

  const decision = parseDecision({ answers: result.answers, transcript, candidates, shortcuts, macros });

  if (decision.action === "unclear") {
    return { success: false, message: decision.reason || "Didn't catch a clear instruction -- try rephrasing." };
  }

  if (decision.action === "macro") {
    return await continueMacro(tabId, decision.steps, 0, []);
  }

  if (decision.action === "type" && decision.valueIsExact === false) {
    const composed = await composeTypedValue({ anthropicApiKey, transcript, targetLabel: decision.targetLabel });
    if (composed) decision.value = composed;
  }

  const risk = assessRisk(decision, transcript);
  if (risk.risky) {
    await setPending(tabId, { decision, routing, resumeMacro: null });
    const label = decision.targetLabel ? `"${decision.targetLabel}"` : decision.action;
    return {
      success: true,
      needsConfirmation: true,
      message: `Just to confirm -- ${decision.action} ${label}? (${risk.reason}) Say yes or no.`,
    };
  }

  const outcome = await actOnDecision(tabId, decision, routing);
  pushHistory(tabId, { transcript, action: decision.action, targetLabel: decision.targetLabel });
  return outcome;
}

// --- macros: a saved sequence of transcripts, replayed through the same
// decide-then-act pipeline one step at a time -------------------------------

async function continueMacro(tabId, steps, startIndex, log) {
  for (let i = startIndex; i < steps.length; i++) {
    const stepTranscript = steps[i];
    const outcome = await decideAndAct(tabId, stepTranscript);
    log.push({ step: stepTranscript, ...outcome });

    if (outcome.needsConfirmation) {
      const pending = await getPending(tabId);
      if (pending) await setPending(tabId, { ...pending, resumeMacro: { steps, nextIndex: i + 1, log } });
      return { success: true, needsConfirmation: true, message: outcome.message, macroPaused: true };
    }
    if (!outcome.success) {
      return { success: false, message: `Macro stopped at step ${i + 1} ("${stepTranscript}"): ${outcome.message}` };
    }
    await waitForTabIdle(tabId);
  }
  return { success: true, message: `Macro finished (${steps.length} step${steps.length === 1 ? "" : "s"}).` };
}

// --- message handlers -------------------------------------------------------

async function handleDecide({ tabId, transcript }) {
  return await decideAndAct(tabId, transcript);
}

async function handleConfirm({ tabId, confirmed }) {
  const pending = await getPending(tabId);
  await clearPending(tabId);
  if (!pending) return { success: false, message: "Nothing waiting to confirm." };
  if (!confirmed) return { success: true, message: "Cancelled." };

  const outcome = await actOnDecision(tabId, pending.decision, pending.routing);
  pushHistory(tabId, {
    transcript: "(confirmed)",
    action: pending.decision.action,
    targetLabel: pending.decision.targetLabel,
  });

  if (pending.resumeMacro) {
    if (!outcome.success) return { success: false, message: `Macro stopped: ${outcome.message}` };
    await waitForTabIdle(tabId);
    return await continueMacro(tabId, pending.resumeMacro.steps, pending.resumeMacro.nextIndex, pending.resumeMacro.log || []);
  }
  return outcome;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "DECIDE") {
    handleDecide(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === "CONFIRM") {
    handleConfirm(msg).then(sendResponse);
    return true;
  }
  return false;
});

// --- push-to-talk hotkey ----------------------------------------------------

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-listening") return;
  try {
    if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    // panel may already be open in this window; continue regardless
  }
  try {
    await chrome.runtime.sendMessage({ type: "TOGGLE_LISTENING" });
  } catch {
    // side panel isn't listening for messages yet (just opened) - the user
    // can still use the mic button directly this once
  }
});
