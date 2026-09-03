import { Router } from "express";
import { getExpense, listExpenses, updateExpense } from "../db";
import { mergeFieldsOntoRecord } from "../normalize";
import { parseExpenseText } from "../claude";
import { upload, publicUrlFor } from "../upload";
import { CATEGORIES, ParsedFields, ROUTES, Status } from "../types";

export const recordsRouter = Router();

const VALID_STATUSES: Status[] = ["captured", "needs_review", "confirmed", "exported"];

/** Review queue / status view feed. */
recordsRouter.get("/", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const route = typeof req.query.route === "string" ? req.query.route : undefined;
  res.json(listExpenses({ status, route }));
});

recordsRouter.get("/:id", (req, res) => {
  const record = getExpense(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(record);
});

/**
 * Edit a record. Two ways in, both ending at the same shared parser +
 * normalize step used by capture:
 *   - { note: "talked" edit text } -> parsed by Claude, merged in
 *   - { fields: {...} }            -> typed edit, applied directly (still
 *                                      re-normalized for dedup/receipt_required)
 * Either payload may also include { status } to move it through the queue.
 */
recordsRouter.patch("/:id", upload.single("audio"), async (req, res) => {
  try {
    const existing = getExpense(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });

    let patch: Partial<typeof existing> = {};

    const note = (req.body?.note ?? "").toString().trim();
    if (note) {
      const parsed: ParsedFields = await parseExpenseText(note, { existing });
      patch = { ...patch, ...mergeFieldsOntoRecord(existing, parsed) };
      if (req.file) {
        patch.voice_note_url = publicUrlFor(req.file.filename);
      }
    }

    const rawFields = req.body?.fields;
    if (rawFields) {
      const fields: ParsedFields =
        typeof rawFields === "string" ? JSON.parse(rawFields) : rawFields;
      if (fields.category && !CATEGORIES.includes(fields.category)) {
        return res.status(400).json({ error: `invalid category: ${fields.category}` });
      }
      if (fields.route && !ROUTES.includes(fields.route)) {
        return res.status(400).json({ error: `invalid route: ${fields.route}` });
      }
      patch = { ...patch, ...mergeFieldsOntoRecord({ ...existing, ...patch } as any, fields) };
    }

    const status = req.body?.status as Status | undefined;
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `invalid status: ${status}` });
      }
      patch.status = status;
    }

    updateExpense(existing.id, patch);
    res.json(getExpense(existing.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});
