import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ExpenseRecord } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "expenses.db");
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  route TEXT NOT NULL DEFAULT 'concur',
  capture_source TEXT NOT NULL,
  raw_input TEXT,

  date TEXT,
  category TEXT,
  vendor TEXT,
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_method TEXT,
  business_purpose TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',

  receipt_image_url TEXT,
  receipt_required INTEGER NOT NULL DEFAULT 1,
  voice_note_url TEXT,

  status TEXT NOT NULL DEFAULT 'captured',
  dedup_key TEXT,
  duplicate_of TEXT,
  exported_at TEXT,

  stay_start_date TEXT,
  stay_end_date TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_route ON expenses(route);
CREATE INDEX IF NOT EXISTS idx_expenses_dedup_key ON expenses(dedup_key);
`);

// --- row <-> record mapping -------------------------------------------------

interface Row {
  id: string;
  route: string;
  capture_source: string;
  raw_input: string | null;
  date: string | null;
  category: string | null;
  vendor: string | null;
  amount: number | null;
  currency: string;
  payment_method: string | null;
  business_purpose: string | null;
  attendees: string;
  receipt_image_url: string | null;
  receipt_required: number;
  voice_note_url: string | null;
  status: string;
  dedup_key: string | null;
  duplicate_of: string | null;
  exported_at: string | null;
  stay_start_date: string | null;
  stay_end_date: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: Row): ExpenseRecord {
  return {
    ...row,
    route: row.route as ExpenseRecord["route"],
    capture_source: row.capture_source as ExpenseRecord["capture_source"],
    category: row.category as ExpenseRecord["category"],
    status: row.status as ExpenseRecord["status"],
    attendees: JSON.parse(row.attendees || "[]"),
    receipt_required: !!row.receipt_required,
  };
}

export function insertExpense(record: ExpenseRecord): void {
  db.prepare(
    `INSERT INTO expenses (
      id, route, capture_source, raw_input, date, category, vendor, amount,
      currency, payment_method, business_purpose, attendees,
      receipt_image_url, receipt_required, voice_note_url,
      status, dedup_key, duplicate_of, exported_at,
      stay_start_date, stay_end_date, created_at, updated_at
    ) VALUES (
      @id, @route, @capture_source, @raw_input, @date, @category, @vendor, @amount,
      @currency, @payment_method, @business_purpose, @attendees,
      @receipt_image_url, @receipt_required, @voice_note_url,
      @status, @dedup_key, @duplicate_of, @exported_at,
      @stay_start_date, @stay_end_date, @created_at, @updated_at
    )`
  ).run({
    ...record,
    attendees: JSON.stringify(record.attendees ?? []),
    receipt_required: record.receipt_required ? 1 : 0,
  });
}

export function updateExpense(id: string, patch: Partial<ExpenseRecord>): void {
  const existing = getExpense(id);
  if (!existing) throw new Error(`expense ${id} not found`);
  const merged: ExpenseRecord = { ...existing, ...patch, id };
  db.prepare(
    `UPDATE expenses SET
      route=@route, capture_source=@capture_source, raw_input=@raw_input,
      date=@date, category=@category, vendor=@vendor, amount=@amount,
      currency=@currency, payment_method=@payment_method,
      business_purpose=@business_purpose, attendees=@attendees,
      receipt_image_url=@receipt_image_url, receipt_required=@receipt_required,
      voice_note_url=@voice_note_url, status=@status, dedup_key=@dedup_key,
      duplicate_of=@duplicate_of, exported_at=@exported_at,
      stay_start_date=@stay_start_date, stay_end_date=@stay_end_date,
      updated_at=@updated_at
    WHERE id=@id`
  ).run({
    ...merged,
    attendees: JSON.stringify(merged.attendees ?? []),
    receipt_required: merged.receipt_required ? 1 : 0,
  });
}

export function getExpense(id: string): ExpenseRecord | undefined {
  const row = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(id) as
    | Row
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function listExpenses(filter?: {
  status?: string;
  route?: string;
}): ExpenseRecord[] {
  let sql = `SELECT * FROM expenses`;
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter?.status) {
    clauses.push(`status = @status`);
    params.status = filter.status;
  }
  if (filter?.route) {
    clauses.push(`route = @route`);
    params.route = filter.route;
  }
  if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
  sql += ` ORDER BY date DESC, created_at DESC`;
  const rows = db.prepare(sql).all(params) as Row[];
  return rows.map(rowToRecord);
}

/** All records whose dedup_key is set, across both routes, for collision checks. */
export function findByDedupKey(dedupKey: string, excludeId?: string): ExpenseRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM expenses WHERE dedup_key = ? AND id != ?`
    )
    .all(dedupKey, excludeId ?? "") as Row[];
  return rows.map(rowToRecord);
}
