const CATEGORIES = ["meals", "taxi", "flights", "hotel", "entertainment", "other"];
const ROUTES = ["concur", "personal_tax"];

let records = [];
let dupIndex = {}; // id -> short label, for showing what a duplicate_of points at

async function load() {
  const all = await api("/api/records");
  dupIndex = Object.fromEntries(all.map((r) => [r.id, `${r.vendor || "?"} ${money(r.amount, r.currency)} (${r.date || "?"})`]));
  records = all.filter((r) => r.status === "captured" || r.status === "needs_review");
  render();
}

function fieldRow(record, key, label, type = "text") {
  const val = record[key] ?? "";
  if (key === "category") {
    return `<label class="field">${label}
      <select data-field="category">
        ${CATEGORIES.map((c) => `<option value="${c}" ${c === val ? "selected" : ""}>${c}</option>`).join("")}
      </select>
    </label>`;
  }
  if (key === "route") {
    return `<label class="field">${label}
      <select data-field="route">
        ${ROUTES.map((r) => `<option value="${r}" ${r === val ? "selected" : ""}>${r === "concur" ? "Concur" : "Personal / tax"}</option>`).join("")}
      </select>
    </label>`;
  }
  if (key === "attendees") {
    return `<label class="field">${label}
      <input type="text" data-field="attendees" value="${escapeHtml((val || []).join(", "))}" />
    </label>`;
  }
  return `<label class="field">${label}
    <input type="${type}" data-field="${key}" value="${escapeHtml(val)}" />
  </label>`;
}

function cardHtml(r) {
  const dupWarning = r.duplicate_of
    ? `<div class="dup-warning">⚠️ Possible duplicate of: ${escapeHtml(dupIndex[r.duplicate_of] || r.duplicate_of)}</div>`
    : "";
  const hotelFields = r.category === "hotel"
    ? fieldRow(r, "stay_start_date", "Stay start", "date") + fieldRow(r, "stay_end_date", "Stay end", "date")
    : "";
  const receiptImg = r.receipt_image_url
    ? `<img class="thumb" src="${r.receipt_image_url}" alt="receipt" />`
    : "";
  const voiceNote = r.voice_note_url
    ? `<audio controls src="${r.voice_note_url}" style="width:100%;margin-top:8px"></audio>`
    : "";

  return `
  <div class="card" data-id="${r.id}">
    <div class="record-head">
      <div>
        <span class="badge ${r.status}">${statusLabel(r.status)}</span>
      </div>
      <div class="amount">${money(r.amount, r.currency)}</div>
    </div>
    <div class="record-sub">${escapeHtml(r.vendor || "Unknown vendor")} · ${escapeHtml(r.date || "no date")} · ${escapeHtml(r.capture_source)}</div>
    ${dupWarning}
    ${receiptImg}
    ${voiceNote}

    <div class="row2">
      ${fieldRow(r, "date", "Date", "date")}
      ${fieldRow(r, "category", "Category")}
    </div>
    <div class="row2">
      ${fieldRow(r, "vendor", "Vendor")}
      ${fieldRow(r, "amount", "Amount", "number")}
    </div>
    <div class="row2">
      ${fieldRow(r, "currency", "Currency")}
      ${fieldRow(r, "payment_method", "Payment method")}
    </div>
    ${fieldRow(r, "business_purpose", "Business purpose")}
    ${fieldRow(r, "attendees", "Attendees")}
    ${fieldRow(r, "route", "Route")}
    ${hotelFields}

    <div class="actions-row">
      <button class="ghost small" data-action="save">💾 Save edits</button>
      <button class="ghost small" data-action="talk">🎤 Talk to edit</button>
      <button class="primary" style="margin:0;width:auto;padding:8px 14px" data-action="confirm">✅ Confirm</button>
    </div>
  </div>`;
}

function render() {
  const list = document.getElementById("list");
  if (!records.length) {
    list.innerHTML = `<div class="empty">Nothing to review — capture something!</div>`;
    return;
  }
  list.innerHTML = records.map(cardHtml).join("");
  list.querySelectorAll(".card").forEach((card) => attachHandlers(card));
}

function readFields(card) {
  const fields = {};
  card.querySelectorAll("[data-field]").forEach((el) => {
    const key = el.dataset.field;
    if (key === "attendees") {
      fields[key] = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "amount") {
      fields[key] = el.value === "" ? null : Number(el.value);
    } else {
      fields[key] = el.value || null;
    }
  });
  return fields;
}

function attachHandlers(card) {
  const id = card.dataset.id;

  card.querySelector('[data-action="save"]').addEventListener("click", async () => {
    try {
      await api(`/api/records/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: readFields(card) }),
      });
      toast("Saved");
      await load();
    } catch (err) {
      toast(`Failed: ${err.message}`);
    }
  });

  card.querySelector('[data-action="confirm"]').addEventListener("click", async () => {
    try {
      await api(`/api/records/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      });
      toast("Confirmed");
      await load();
    } catch (err) {
      toast(`Failed: ${err.message}`);
    }
  });

  const talkBtn = card.querySelector('[data-action="talk"]');
  let recorder = null;
  let recording = false;
  talkBtn.addEventListener("click", async () => {
    if (!recording) {
      try {
        recorder = createVoiceRecorder({
          onStop: async ({ blob, transcript }) => {
            talkBtn.textContent = "🎤 Talk to edit";
            if (!transcript) {
              toast("Didn't catch that — try again.");
              return;
            }
            toast("Updating…");
            const form = new FormData();
            form.append("note", transcript);
            form.append("audio", blob, "note.webm");
            try {
              await api(`/api/records/${id}`, { method: "PATCH", body: form });
              toast("Updated");
              await load();
            } catch (err) {
              toast(`Failed: ${err.message}`);
            }
          },
        });
        await recorder.start();
        recording = true;
        talkBtn.textContent = "⏹️ Stop";
      } catch (err) {
        toast("Microphone access denied.");
      }
    } else {
      recorder.stop();
      recording = false;
    }
  });
}

load();
