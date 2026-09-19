const micBtn = document.getElementById("micBtn");
const micLabel = document.getElementById("micLabel");
const transcriptEl = document.getElementById("transcript");
const statusLine = document.getElementById("statusLine");
const logEl = document.getElementById("log");
const settingsBtn = document.getElementById("settingsBtn");

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let listening = false;
let restartTimer = null;

function setListeningUI(isListening) {
  listening = isListening;
  micBtn.setAttribute("aria-pressed", String(isListening));
  micLabel.textContent = isListening ? "Listening… (tap to stop)" : "Start listening";
}

function setStatus(text) {
  statusLine.textContent = text;
}

function addLogEntry(said) {
  const li = document.createElement("li");
  li.className = "pending";
  li.innerHTML = `<div class="said">"${escapeHtml(said)}"</div><div class="result">Thinking</div>`;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
  return li;
}

function resolveLogEntry(li, success, message) {
  li.className = success ? "ok" : "err";
  li.querySelector(".result").textContent = message;
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function handleUtterance(transcript) {
  const trimmed = transcript.trim();
  if (!trimmed) return;

  const entry = addLogEntry(trimmed);

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  if (!tab) {
    resolveLogEntry(entry, false, "No active tab found.");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "DECIDE", tabId: tab.id, transcript: trimmed });
    resolveLogEntry(entry, Boolean(response?.success), response?.message || "No response.");
  } catch (err) {
    resolveLogEntry(entry, false, `Extension error: ${err.message}`);
  }
}

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

micBtn.addEventListener("click", () => {
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
});

initRecognition();
