const micBtn = document.getElementById("micBtn");
const micLabel = document.getElementById("micLabel");
const recordBtn = document.getElementById("recordBtn");
const recordLabel = document.getElementById("recordLabel");
const transcriptEl = document.getElementById("transcript");
const statusLine = document.getElementById("statusLine");
const logEl = document.getElementById("log");
const settingsBtn = document.getElementById("settingsBtn");

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let listening = false;
let restartTimer = null;

let recording = false;
let recordingSteps = [];

/** Set while background is waiting on a yes/no confirmation for a given tab. */
let awaitingConfirmation = null; // { tabId } | null

function setListeningUI(isListening) {
  listening = isListening;
  micBtn.setAttribute("aria-pressed", String(isListening));
  micLabel.textContent = isListening ? "Listening… (tap to stop)" : "Start listening";
}

function setStatus(text) {
  statusLine.textContent = text;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function speak(text) {
  try {
    const { voiceFeedbackEnabled } = await chrome.storage.local.get("voiceFeedbackEnabled");
    if (voiceFeedbackEnabled === false) return;
    if (!("speechSynthesis" in window) || !text) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // speech synthesis is a nice-to-have; never let it break the flow
  }
}

function addLogEntry(said) {
  const li = document.createElement("li");
  li.className = "pending";
  li.dataset.said = said;
  li.innerHTML = `<div class="said">"${escapeHtml(said)}"</div><div class="result">Thinking</div>`;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
  return li;
}

function resolveLogEntry(li, kind, message) {
  li.className = kind; // "ok" | "err" | "confirm"
  li.querySelector(".result").textContent = message;
  logEl.scrollTop = logEl.scrollHeight;
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

function parseYesNo(text) {
  const t = text.trim().toLowerCase();
  if (/^(yes|yeah|yep|yup|confirm|do it|go ahead|correct|affirmative)\b/.test(t)) return true;
  if (/^(no|nope|nah|cancel|stop|don'?t|negative)\b/.test(t)) return false;
  return null;
}

async function handleConfirmationReply(transcript) {
  const { tabId } = awaitingConfirmation;
  const answer = parseYesNo(transcript);
  const entry = addLogEntry(transcript);

  if (answer === null) {
    // Not a clear yes/no - cancel the pending action server-side and fall
    // through to treat this utterance as a fresh instruction instead.
    awaitingConfirmation = null;
    try {
      await chrome.runtime.sendMessage({ type: "CONFIRM", tabId, confirmed: false });
    } catch {
      // best-effort cleanup
    }
    resolveLogEntry(entry, "err", "Didn't sound like yes or no -- treating it as a new instruction.");
    await runUtterance(transcript, entry);
    return;
  }

  awaitingConfirmation = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: "CONFIRM", tabId, confirmed: answer });
    await finishTurn(entry, response, { allowRecord: false });
  } catch (err) {
    resolveLogEntry(entry, "err", `Extension error: ${err.message}`);
  }
}

async function finishTurn(entry, response, { allowRecord = true } = {}) {
  const message = response?.message || "No response.";
  if (response?.needsConfirmation) {
    const tab = await getActiveTab();
    awaitingConfirmation = { tabId: tab?.id };
    resolveLogEntry(entry, "confirm", message);
    speak(message);
    // The command itself is the recordable step; the spoken yes/no reply
    // that resolves it is handled by the CONFIRM protocol during replay
    // too, so it must never be recorded as a step on its own.
    if (recording && allowRecord) {
      recordingSteps.push(entry.dataset.said);
      updateRecordLabel();
    }
    return;
  }
  resolveLogEntry(entry, response?.success ? "ok" : "err", message);
  speak(message);
  if (recording && allowRecord && response?.success) {
    recordingSteps.push(entry.dataset.said);
    updateRecordLabel();
  }
}

async function runUtterance(transcript, existingEntry) {
  const trimmed = transcript.trim();
  if (!trimmed) return;

  const entry = existingEntry || addLogEntry(trimmed);
  entry.dataset.said = trimmed;

  const tab = await getActiveTab();
  if (!tab) {
    resolveLogEntry(entry, "err", "No active tab found.");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "DECIDE", tabId: tab.id, transcript: trimmed });
    await finishTurn(entry, response);
  } catch (err) {
    resolveLogEntry(entry, "err", `Extension error: ${err.message}`);
  }
}

async function handleUtterance(transcript) {
  const trimmed = transcript.trim();
  if (!trimmed) return;

  if (awaitingConfirmation) {
    await handleConfirmationReply(trimmed);
    return;
  }
  await runUtterance(trimmed);
}

function updateRecordLabel() {
  recordLabel.textContent = recording ? `Recording… (${recordingSteps.length} steps, tap to save)` : "Record macro";
  recordBtn.setAttribute("aria-pressed", String(recording));
}

recordBtn.addEventListener("click", async () => {
  if (!recording) {
    recording = true;
    recordingSteps = [];
    updateRecordLabel();
    setStatus("Recording a macro -- say each step, then tap again to save.");
    return;
  }

  recording = false;
  updateRecordLabel();
  setStatus("");
  if (recordingSteps.length === 0) return;

  const name = window.prompt(`Save this ${recordingSteps.length}-step macro as:`);
  if (!name || !name.trim()) return;

  const { macros } = await chrome.storage.local.get("macros");
  const list = Array.isArray(macros) ? macros.filter((m) => m.name !== name.trim().toLowerCase()) : [];
  list.push({ name: name.trim().toLowerCase(), steps: [...recordingSteps] });
  await chrome.storage.local.set({ macros: list });
  setStatus(`Saved macro "${name.trim()}".`);
});

function initRecognition() {
  if (!SpeechRecognitionImpl) {
    setStatus("This browser doesn't support the Web Speech API. Try Chrome.");
    micBtn.disabled = true;
    return;
  }
  recognition = new SpeechRecognitionImpl();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        transcriptEl.textContent = "";
        handleUtterance(result[0].transcript);
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) transcriptEl.textContent = interim;
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setStatus("Microphone access was denied. Allow it for this extension, then try again.");
      setListeningUI(false);
      return;
    }
    if (event.error === "no-speech" || event.error === "aborted") return;
    setStatus(`Speech recognition error: ${event.error}`);
  };

  recognition.onend = () => {
    if (listening) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        try {
          recognition.start();
        } catch {
          // already running; ignore
        }
      }, 250);
    }
  };
}

function toggleListening() {
  if (!recognition) initRecognition();
  if (!recognition) return;

  if (listening) {
    setListeningUI(false);
    recognition.stop();
    setStatus("");
  } else {
    setStatus("");
    try {
      recognition.start();
      setListeningUI(true);
    } catch (err) {
      setStatus(`Couldn't start listening: ${err.message}`);
    }
  }
}

micBtn.addEventListener("click", toggleListening);

// Relay for the toggle-listening keyboard command (chrome.commands), sent
// from the background service worker since it can't drive recognition
// itself (no window/document there).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TOGGLE_LISTENING") toggleListening();
});

initRecognition();
