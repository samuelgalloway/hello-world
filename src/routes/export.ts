import { Router } from "express";
import { listExpenses, updateExpense } from "../db";
import { ExpenseRecord, Route } from "../types";

export const exportRouter = Router();

const EXPORT_COLUMNS: (keyof ExpenseRecord)[] = [
  "id",
  "route",
  "date",
  "category",
  "vendor",
  "amount",
  "currency",
  "payment_method",
  "business_purpose",
  "attendees",
  "receipt_image_url",
  "receipt_required",
  "voice_note_url",
  "stay_start_date",
  "stay_end_date",
  "capture_source",
];

function toCsv(records: ExpenseRecord[]): string {
  const escape = (v: unknown) => {
    const s = Array.isArray(v) ? v.join("; ") : v ?? "";
    const str = String(s);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = EXPORT_COLUMNS.join(",");
  const rows = records.map((r) => EXPORT_COLUMNS.map((c) => escape(r[c])).join(","));
  return [header, ...rows].join("\n");
}

/**
 * Exports confirmed records for one route as CSV or JSON — the file Claude
 * Cowork (or a human) uses to fill out Concur, or the personal-tax log.
 * Marks exported records as status=exported so they drop off the queue.
 */
exportRouter.get("/", (req, res) => {
  const route = (req.query.route as Route) ?? "concur";
  const format = (req.query.format as string) ?? "json";
  if (route !== "concur" && route !== "personal_tax") {
    return res.status(400).json({ error: "route must be concur or personal_tax" });
  }

  const records = listExpenses({ status: "confirmed", route });

  const now = new Date().toISOString();
  for (const r of records) {
    updateExpense(r.id, { status: "exported", exported_at: now });
  }

  const filenameBase = `${route}-export-${now.slice(0, 10)}`;

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    return res.send(toCsv(records));
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.json"`);
  res.json(records);
});
