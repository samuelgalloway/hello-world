async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

let toastTimer = null;
function toast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function money(amount, currency) {
  if (amount === null || amount === undefined) return "—";
  const c = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(amount);
  } catch (_) {
    return `${c} ${amount.toFixed(2)}`;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function statusLabel(s) {
  return { captured: "Captured", needs_review: "Needs review", confirmed: "Confirmed", exported: "Exported" }[s] || s;
}

/** Records a short clip and (where supported) live-transcribes it.
 * Returns { blob, transcript } via onStop. Falls back to blob-only + a
 * warning toast on browsers without SpeechRecognition (e.g. Firefox/Safari).
 */
function createVoiceRecorder({ onStop }) {
  let mediaRecorder = null;
  let chunks = [];
  let recognition = null;
  let finalTranscript = "";
  let stream = null;

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    finalTranscript = "";
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      stream.getTracks().forEach((t) => t.stop());
      onStop({ blob, transcript: finalTranscript.trim() });
    };
    mediaRecorder.start();

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript + " ";
          }
        }
      };
      recognition.onerror = () => {};
      recognition.start();
    } else {
      toast("This browser can't transcribe live — type the note instead.");
    }
  }

  function stop() {
    if (recognition) recognition.stop();
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }

  return { start, stop };
}
