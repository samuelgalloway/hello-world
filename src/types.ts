// Core data model — mirrors the schema in the project spec.

export type Route = "concur" | "personal_tax";
export type CaptureSource = "email" | "photo" | "voice" | "manual";
export type Category =
  | "meals"
  | "taxi"
  | "flights"
  | "hotel"
  | "entertainment"
  | "other";
export type Status = "captured" | "needs_review" | "confirmed" | "exported";

export interface ExpenseRecord {
  id: string;
  route: Route;
  capture_source: CaptureSource;
  raw_input: string | null;

  date: string | null; // ISO yyyy-mm-dd, expense/transaction date
  category: Category | null;
  vendor: string | null;
  amount: number | null;
  currency: string;
  payment_method: string | null;
  business_purpose: string | null;
  attendees: string[]; // stored as JSON in sqlite

  receipt_image_url: string | null;
  receipt_required: boolean; // derived
  voice_note_url: string | null;

  status: Status;
  dedup_key: string | null;
  duplicate_of: string | null;
  exported_at: string | null;

  // hotel-specific
  stay_start_date: string | null;
  stay_end_date: string | null;

  created_at: string;
  updated_at: string;
}

// Fields the shared parser is allowed to produce. Anything it returns gets
// merged onto a record (new or existing) and then re-normalized.
export interface ParsedFields {
  route?: Route;
  date?: string | null;
  category?: Category | null;
  vendor?: string | null;
  amount?: number | null;
  currency?: string | null;
  payment_method?: string | null;
  business_purpose?: string | null;
  attendees?: string[];
  stay_start_date?: string | null;
  stay_end_date?: string | null;
  needs_review?: boolean; // true when the extraction was low-confidence/incomplete
}

export const CATEGORIES: Category[] = [
  "meals",
  "taxi",
  "flights",
  "hotel",
  "entertainment",
  "other",
];

export const ROUTES: Route[] = ["concur", "personal_tax"];
