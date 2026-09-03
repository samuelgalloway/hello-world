async function load() {
  const all = await api("/api/records");
  const counts = { captured: 0, needs_review: 0, confirmed: 0, exported: 0 };
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;

  document.getElementById("stats").innerHTML = ["captured", "needs_review", "confirmed", "exported"]
    .map((s) => `<div class="stat"><div class="n">${counts[s]}</div><div class="l">${statusLabel(s)}</div></div>`)
    .join("");

  const recent = [...all]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 20);

  document.getElementById("recent").innerHTML = recent.length
    ? recent
        .map(
          (r) => `<div class="status-line">
            <span>${escapeHtml(r.vendor || "Unknown")} · ${escapeHtml(r.date || "no date")} · ${money(r.amount, r.currency)}</span>
            <span class="badge ${r.status}">${statusLabel(r.status)}</span>
          </div>`
        )
        .join("")
    : `<div class="empty">Nothing captured yet.</div>`;
}

function wireExport(id, route, format) {
  document.getElementById(id).addEventListener("click", () => {
    window.location.href = `/api/export?route=${route}&format=${format}`;
    setTimeout(load, 800);
  });
}

wireExport("export-concur-csv", "concur", "csv");
wireExport("export-concur-json", "concur", "json");
wireExport("export-tax-csv", "personal_tax", "csv");
wireExport("export-tax-json", "personal_tax", "json");

load();
