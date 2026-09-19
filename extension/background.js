// Manifest V3 service worker. No `window`/`document`/`navigator` exist here,
// so this is the one place the TypeSafe API key is read and used -- never in
// a content script that runs inside third-party pages.
import { systemOne, TypeSafeAPIError } from "./lib/typesafe.js";
import { buildDecisionRequest, parseDecision } from "./lib/nlu.js";

const MAX_HISTORY = 5;
/** @type {Map<number, Array<{transcript: string, action: string, targetLabel?: string}>>} */
const historyByTab = new Map();

function enablePanelOnActionClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enablePanelOnActionClick);
chrome.runtime.onStartup.addListener(enablePanelOnActionClick);
enablePanelOnActionClick();

async function getSettings() {
  const { typesafeApiKey, typesafeModel, shortcuts } = await chrome.storage.local.get([
    "typesafeApiKey",
    "typesafeModel",
    "shortcuts",
  ]);
  return {
    apiKey: typesafeApiKey || "",
    model: typesafeModel || undefined,
    shortcuts: Array.isArray(shortcuts) ? shortcuts : [],
  };
}

async function getPageState(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" });
  } catch {
    return null;
  }
}

function pushHistory(tabId, entry) {
  const list = historyByTab.get(tabId) || [];
  list.push(entry);
  while (list.length > MAX_HISTORY) list.shift();
  historyByTab.set(tabId, list);
}

async function handleDecide({ tabId, transcript }) {
  const { apiKey, model, shortcuts } = await getSettings();
  if (!apiKey) {
    return { success: false, message: "Set your TypeSafe API key on the extension's options page first." };
  }

  const pageState = await getPageState(tabId);
  if (!pageState) {
    return {
      success: false,
      message: "Can't control this page (browser settings pages and freshly-opened tabs aren't reachable).",
    };
  }

  const history = historyByTab.get(tabId) || [];
  const { state, questions } = buildDecisionRequest({
    transcript,
    page: { url: pageState.url, title: pageState.title },
    candidates: pageState.elements,
    shortcuts,
    history,
  });

  let result;
  try {
    result = await systemOne({ apiKey, state, questions, ...(model ? { model } : {}) });
  } catch (err) {
    const detail = err instanceof TypeSafeAPIError ? `${err.status}: ${JSON.stringify(err.body)}` : err.message;
    return { success: false, message: `TypeSafe request failed (${detail}).` };
  }

  const decision = parseDecision({
    answers: result.answers,
    transcript,
    candidates: pageState.elements,
    shortcuts,
  });

  if (decision.action === "unclear") {
    return { success: false, message: decision.reason || "Didn't catch a clear instruction — try rephrasing." };
  }

  let outcome;
  switch (decision.action) {
    case "navigate":
      await chrome.tabs.update(tabId, { url: decision.navigateUrl });
      outcome = { success: true, message: `Navigating to ${decision.navigateUrl}` };
      break;
    case "go_back":
      await chrome.tabs.goBack(tabId);
      outcome = { success: true, message: "Went back." };
      break;
    case "go_forward":
      await chrome.tabs.goForward(tabId);
      outcome = { success: true, message: "Went forward." };
      break;
    default:
      try {
        outcome = await chrome.tabs.sendMessage(tabId, {
          type: "EXECUTE",
          action: decision.action,
          targetId: decision.targetId,
          value: decision.value,
        });
      } catch {
        outcome = { success: false, message: "Lost connection to the page while acting." };
      }
  }

  pushHistory(tabId, { transcript, action: decision.action, targetLabel: decision.targetLabel });
  return { ...outcome, decision };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "DECIDE") {
    handleDecide(msg).then(sendResponse);
    return true;
  }
  return false;
});
