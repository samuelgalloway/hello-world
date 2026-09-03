import { Router } from "express";
import fs from "fs";
import { insertExpense } from "../db";
import { buildNewRecord } from "../normalize";
import { parseExpenseText, parseReceiptImage } from "../claude";
import { upload, publicUrlFor } from "../upload";
import { CATEGORIES, ParsedFields, ROUTES } from "../types";

export const captureRouter = Router();

const IMAGE_MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/webp" | "image/gif"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Manual entry: the form already produced structured fields, so this skips
 * the Claude parser and goes straight to normalize.
 */
captureRouter.post("/manual", (req, res) => {
  const fields: ParsedFields = req.body ?? {};
  if (fields.category && !CATEGORIES.includes(fields.category)) {
    return res.status(400).json({ error: `invalid category: ${fields.category}` });
  }
  if (fields.route && !ROUTES.includes(fields.route)) {
    return res.status(400).json({ error: `invalid route: ${fields.route}` });
  }
  const record = buildNewRecord(fields, {
    capture_source: "manual",
    raw_input: null,
  });
  insertExpense(record);
  res.status(201).json(record);
});

/**
 * Voice capture: a transcript (produced client-side by the browser's speech
 * recognition) goes through the shared parser. An optional audio file is
 * attached as voice_note_url.
 */
captureRouter.post("/voice", upload.single("audio"), async (req, res) => {
  try {
    const transcript = (req.body?.transcript ?? "").toString().trim();
    if (!transcript) {
      return res.status(400).json({ error: "transcript is required" });
    }
    const fields = await parseExpenseText(transcript);
    const voice_note_url = req.file ? publicUrlFor(req.file.filename) : null;
    const record = buildNewRecord(fields, {
      capture_source: "voice",
      raw_input: transcript,
      voice_note_url,
    });
    insertExpense(record);
    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Photo capture: vision extraction, same downstream normalize as everything else. */
captureRouter.post("/photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "photo file is required" });
    const ext = req.file.filename.slice(req.file.filename.lastIndexOf(".")).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) {
      return res.status(400).json({ error: `unsupported image type: ${ext}` });
    }
    const base64 = fs.readFileSync(req.file.path).toString("base64");
    const fields = await parseReceiptImage(base64, mediaType);
    const record = buildNewRecord(fields, {
      capture_source: "photo",
      raw_input: null,
      receipt_image_url: publicUrlFor(req.file.filename),
    });
    insertExpense(record);
    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});
