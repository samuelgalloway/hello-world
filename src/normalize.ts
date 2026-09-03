import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { CaptureSource, ExpenseRecord, ParsedFields, Route } from "./types";
import { findByDedupKey } from "./db";

/** Normalizes a vendor name for stable dedup matching (case/punct/whitespace-insensitive). */
export function normalizeVendor(vendor: string | null | undefined): string {
  return (vendor ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function computeDedupKey(
  date: string | null,
  vendor: string | null,
  amount: number | null
): string | null {
  if (!date || !amount) return null;
  const basis = `${date}|${normalizeVendor(vendor)}|${amount.toFixed(2)}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

/** Meals under $50 don't need a receipt image; everything else does. */
export function computeReceiptRequired(
  category: ExpenseRecord["category"],
  amount: number | null
): boolean {
  if (category === "meals" && amount !== null && amount < 50) return false;
  return true;
}

/**
 * Builds a brand-new record from parsed fields plus capture metadata,
 * running dedup detection across both routes.
 */
export function buildNewRecord(
  fields: ParsedFields,
  opts: {
    capture_source: CaptureSource;
    raw_input: string | null;
    receipt_image_url?: string | null;
    voice_note_url?: string | null;
  }
): ExpenseRecord {
  const now = new Date().toISOString();
  const dedup_key = computeDedupKey(
    fields.date ?? null,
    fields.vendor ?? null,
    fields.amount ?? null
  );
  const duplicates = dedup_key ? findByDedupKey(dedup_key) : [];
  const receipt_required = computeReceiptRequired(
    fields.category ?? null,
    fields.amount ?? null
  );

  const missingRequired =
    !fields.date ||
    !fields.category ||
    !fields.vendor ||
    fields.amount === undefined ||
    fields.amount === null ||
    !fields.business_purpose;

  const status: ExpenseRecord["status"] =
    duplicates.length > 0 || missingRequired || fields.needs_review
      ? "needs_review"
      : "captured";

  return {
    id: uuidv4(),
    route: (fields.route as Route) ?? "concur",
    capture_source: opts.capture_source,
    raw_input: opts.raw_input,

    date: fields.date ?? null,
    category: fields.category ?? null,
    vendor: fields.vendor ?? null,
    amount: fields.amount ?? null,
    currency: fields.currency ?? "USD",
    payment_method: fields.payment_method ?? null,
    business_purpose: fields.business_purpose ?? null,
    attendees: fields.attendees ?? [],

    receipt_image_url: opts.receipt_image_url ?? null,
    receipt_required,
    voice_note_url: opts.voice_note_url ?? null,

    status,
    dedup_key,
    duplicate_of: duplicates.length > 0 ? duplicates[0].id : null,
    exported_at: null,

    stay_start_date: fields.stay_start_date ?? null,
    stay_end_date: fields.stay_end_date ?? null,

    created_at: now,
    updated_at: now,
  };
}

/**
 * Merges freshly-parsed fields onto an existing record (follow-up voice note,
 * or a field edit in the review queue) and re-runs derived fields + dedup.
 */
export function mergeFieldsOntoRecord(
  existing: ExpenseRecord,
  fields: ParsedFields
): Partial<ExpenseRecord> {
  const merged: ExpenseRecord = {
    ...existing,
    ...(fields.route !== undefined ? { route: fields.route as Route } : {}),
    ...(fields.date !== undefined ? { date: fields.date } : {}),
    ...(fields.category !== undefined ? { category: fields.category } : {}),
    ...(fields.vendor !== undefined ? { vendor: fields.vendor } : {}),
    ...(fields.amount !== undefined ? { amount: fields.amount } : {}),
    ...(fields.currency !== undefined && fields.currency !== null
      ? { currency: fields.currency }
      : {}),
    ...(fields.payment_method !== undefined
      ? { payment_method: fields.payment_method }
      : {}),
    ...(fields.business_purpose !== undefined
      ? { business_purpose: fields.business_purpose }
      : {}),
    ...(fields.attendees !== undefined
      ? { attendees: [...existing.attendees, ...fields.attendees].filter(
          (v, i, arr) => arr.indexOf(v) === i
        ) }
      : {}),
    ...(fields.stay_start_date !== undefined
      ? { stay_start_date: fields.stay_start_date }
      : {}),
    ...(fields.stay_end_date !== undefined
      ? { stay_end_date: fields.stay_end_date }
      : {}),
  };

  const dedup_key = computeDedupKey(merged.date, merged.vendor, merged.amount);
  const duplicates = dedup_key ? findByDedupKey(dedup_key, existing.id) : [];
  const receipt_required = computeReceiptRequired(merged.category, merged.amount);

  return {
    route: merged.route,
    date: merged.date,
    category: merged.category,
    vendor: merged.vendor,
    amount: merged.amount,
    currency: merged.currency,
    payment_method: merged.payment_method,
    business_purpose: merged.business_purpose,
    attendees: merged.attendees,
    stay_start_date: merged.stay_start_date,
    stay_end_date: merged.stay_end_date,
    dedup_key,
    duplicate_of: duplicates.length > 0 ? duplicates[0].id : null,
    receipt_required,
    updated_at: new Date().toISOString(),
  };
}
