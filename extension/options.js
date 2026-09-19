const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const anthropicApiKeyEl = document.getElementById("anthropicApiKey");
const voiceFeedbackEl = document.getElementById("voiceFeedback");
const shortcutBody = document.getElementById("shortcutBody");
const macroBody = document.getElementById("macroBody");
const newName = document.getElementById("newName");
const newUrl = document.getElementById("newUrl");
const savedNote = document.getElementById("savedNote");

let shortcuts = [];
let macros = [];

function renderShortcuts() {
  shortcutBody.innerHTML = "";
  shortcuts.forEach((s, idx) => {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = s.name;
    const urlTd = document.createElement("td");
    urlTd.textContent = s.url;
    const actionTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      shortcuts.splice(idx, 1);
      renderShortcuts();
    });
    actionTd.appendChild(removeBtn);
    tr.append(nameTd, urlTd, actionTd);
    shortcutBody.appendChild(tr);
  });
}

function renderMacros() {
  macroBody.innerHTML = "";
  if (macros.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "hint";
    td.textContent = "No macros recorded yet.";
    tr.appendChild(td);
    macroBody.appendChild(tr);
    return;
  }
  macros.forEach((m, idx) => {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = m.name;
    const stepsTd = document.createElement("td");
    stepsTd.className = "macro-steps";
    stepsTd.textContent = m.steps.join(" -> ");
    const actionTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      macros.splice(idx, 1);
      renderMacros();
      await chrome.storage.local.set({ macros });
    });
    actionTd.appendChild(removeBtn);
    tr.append(nameTd, stepsTd, actionTd);
    macroBody.appendChild(tr);
  });
}

document.getElementById("addShortcut").addEventListener("click", () => {
  const name = newName.value.trim().toLowerCase();
  const url = newUrl.value.trim();
  if (!name || !url) return;
  shortcuts.push({ name, url });
  newName.value = "";
  newUrl.value = "";
  renderShortcuts();
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    typesafeApiKey: apiKeyEl.value.trim(),
    typesafeModel: modelEl.value.trim(),
    anthropicApiKey: anthropicApiKeyEl.value.trim(),
    voiceFeedbackEnabled: voiceFeedbackEl.checked,
    shortcuts,
  });
  savedNote.hidden = false;
  setTimeout(() => (savedNote.hidden = true), 2000);
});

async function load() {
  const stored = await chrome.storage.local.get([
    "typesafeApiKey",
    "typesafeModel",
    "anthropicApiKey",
    "voiceFeedbackEnabled",
    "shortcuts",
    "macros",
  ]);
  apiKeyEl.value = stored.typesafeApiKey || "";
  modelEl.value = stored.typesafeModel || "";
  anthropicApiKeyEl.value = stored.anthropicApiKey || "";
  voiceFeedbackEl.checked = stored.voiceFeedbackEnabled !== false;
  shortcuts = Array.isArray(stored.shortcuts) ? stored.shortcuts : [];
  macros = Array.isArray(stored.macros) ? stored.macros : [];
  renderShortcuts();
  renderMacros();
}

load();
