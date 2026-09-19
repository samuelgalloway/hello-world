const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const shortcutBody = document.getElementById("shortcutBody");
const newName = document.getElementById("newName");
const newUrl = document.getElementById("newUrl");
const savedNote = document.getElementById("savedNote");

let shortcuts = [];

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
    shortcuts,
  });
  savedNote.hidden = false;
  setTimeout(() => (savedNote.hidden = true), 2000);
});

async function load() {
  const stored = await chrome.storage.local.get(["typesafeApiKey", "typesafeModel", "shortcuts"]);
  apiKeyEl.value = stored.typesafeApiKey || "";
  modelEl.value = stored.typesafeModel || "";
  shortcuts = Array.isArray(stored.shortcuts) ? stored.shortcuts : [];
  renderShortcuts();
}

load();
