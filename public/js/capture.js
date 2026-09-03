// Photo capture
document.getElementById("photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  toast("Reading receipt…");
  const form = new FormData();
  form.append("photo", file);
  try {
    const record = await api("/api/capture/photo", { method: "POST", body: form });
    toast(
      record.status === "needs_review"
        ? "Captured — flagged for review"
        : `Captured: ${record.vendor || "?"} ${money(record.amount, record.currency)}`
    );
  } catch (err) {
    toast(`Failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// Voice capture
let recorder = null;
let recording = false;
const voiceBtn = document.getElementById("voice-btn");
const voiceIcon = document.getElementById("voice-icon");
const voiceLabel = document.getElementById("voice-label");

voiceBtn.addEventListener("click", async () => {
  if (!recording) {
    try {
      recorder = createVoiceRecorder({
        onStop: async ({ blob, transcript }) => {
          voiceIcon.textContent = "🎤";
          voiceLabel.textContent = "Voice";
          voiceBtn.classList.remove("recording");
          if (!transcript) {
            toast("Didn't catch a transcript — try again, or use manual entry.");
            return;
          }
          toast("Parsing…");
          const form = new FormData();
          form.append("transcript", transcript);
          form.append("audio", blob, "note.webm");
          try {
            const record = await api("/api/capture/voice", { method: "POST", body: form });
            toast(
              record.status === "needs_review"
                ? "Captured — flagged for review"
                : `Captured: ${record.vendor || "?"} ${money(record.amount, record.currency)}`
            );
          } catch (err) {
            toast(`Failed: ${err.message}`);
          }
        },
      });
      await recorder.start();
      recording = true;
      voiceIcon.textContent = "⏹️";
      voiceLabel.textContent = "Stop";
      voiceBtn.classList.add("recording");
    } catch (err) {
      toast("Microphone access denied.");
    }
  } else {
    recorder.stop();
    recording = false;
  }
});

// Manual entry
document.getElementById("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  const attendees = (data.get("attendees") || "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    date: data.get("date") || null,
    category: data.get("category") || null,
    route: data.get("route") || "concur",
    vendor: data.get("vendor") || null,
    amount: data.get("amount") ? Number(data.get("amount")) : null,
    currency: data.get("currency") || "USD",
    payment_method: data.get("payment_method") || null,
    business_purpose: data.get("business_purpose") || null,
    attendees,
  };

  try {
    const record = await api("/api/capture/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast(record.status === "needs_review" ? "Added — flagged for review" : "Added");
    form.reset();
    form.querySelector('[name="currency"]').value = "USD";
  } catch (err) {
    toast(`Failed: ${err.message}`);
  }
});
