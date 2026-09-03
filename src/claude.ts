// All Claude API access lives in this one server-side module.
//
// SECURITY: ANTHROPIC_API_KEY is read from process.env (populated from the
// git-ignored .env file via dotenv, loaded once in server.ts). It never
// leaves this process — it is not returned in any HTTP response, not
// embedded in any file under public/, and not logged. Every route that
// needs Claude calls through the functions below rather than touching the
// SDK or the key directly.

import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, ParsedFields, ROUTES } from "./types";

const MODEL = "claude-sonnet-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key."
    );
  }
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// One tool schema shared by both the text parser and the vision extractor,
// so both funnel into exactly the same field set for the normalize step.
const EXTRACT_TOOL: Anthropic.Tool = {
  name: "record_expense_fields",
  description:
    "Record the expense fields extracted from the input. Omit a field entirely if it genuinely cannot be determined — do not guess.",
  input_schema: {
    type: "object",
    properties: {
      route: {
        type: "string",
        enum: ROUTES,
        description:
          "Destination pipeline. Default 'concur'. Use 'personal_tax' only when the input explicitly signals this is a personal expense being tracked for taxes, not a Concur/business reimbursement (e.g. 'personal expense', 'for my taxes', 'not reimbursable', 'side business').",
      },
      date: {
        type: "string",
        description:
          "Expense/transaction date in ISO YYYY-MM-DD. This is when the purchase happened, not today's date, unless the input says 'today'.",
      },
      category: { type: "string", enum: CATEGORIES },
      vendor: { type: "string" },
      amount: {
        type: "number",
        description: "Total charged, as a plain decimal number (no currency symbol).",
      },
      currency: {
        type: "string",
        description: "3-letter ISO currency code. Default USD if unstated and no other cue.",
      },
      payment_method: {
        type: "string",
        description: "Which card/method was used, e.g. 'Amex ending 1234', 'personal Visa'.",
      },
      business_purpose: {
        type: "string",
        description: "Why this expense was incurred, for the expense report.",
      },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Names of people present, if mentioned.",
      },
      stay_start_date: {
        type: "string",
        description: "Hotel only: first night of the stay, ISO YYYY-MM-DD.",
      },
      stay_end_date: {
        type: "string",
        description: "Hotel only: checkout date, ISO YYYY-MM-DD.",
      },
      needs_review: {
        type: "boolean",
        description:
          "Set true if the source was ambiguous, low-confidence, or partly illegible — flags the record for a human to double check.",
      },
    },
    required: [],
  },
};

function extractToolInput(msg: Anthropic.Message): ParsedFields {
  const toolUse = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) return {};
  return toolUse.input as ParsedFields;
}

/**
 * The single shared parser: free text (initial voice capture, a follow-up
 * voice/text note, or a field edit) -> structured fields. Called from three
 * places in the app — never duplicate this logic elsewhere.
 *
 * `context` gives the model the existing record when this is a follow-up
 * note or an edit, so e.g. "actually this was $45" is understood relative
 * to what's already known.
 */
export async function parseExpenseText(
  text: string,
  context?: { existing?: unknown }
): Promise<ParsedFields> {
  const system = [
    "You extract structured expense-report fields from a short spoken or typed note.",
    "Only call the record_expense_fields tool. Only include fields the text actually supports.",
    context?.existing
      ? `This note is about an existing record, currently: ${JSON.stringify(
          context.existing
        )}. Only output fields the new text adds or changes.`
      : "This is a brand-new expense.",
  ].join("\n");

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_expense_fields" },
    messages: [{ role: "user", content: text }],
  });

  return extractToolInput(msg);
}

/**
 * Vision extraction for a photographed/scanned receipt. Feeds the same tool
 * schema as parseExpenseText so both capture paths normalize identically.
 */
export async function parseReceiptImage(
  base64Data: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"
): Promise<ParsedFields> {
  const system = [
    "You read a photographed or scanned receipt image and extract structured expense fields.",
    "Only call the record_expense_fields tool. Read amounts and dates carefully — these feed an expense report.",
    "If the image is blurry, cropped, or any key field (amount, vendor, date) is not clearly legible, still extract what you can but set needs_review to true.",
    "Do not guess a business_purpose or attendees from a receipt alone unless something on the receipt states it — leave those fields out.",
  ].join("\n");

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_expense_fields" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Data },
          },
          { type: "text", text: "Extract the expense fields from this receipt." },
        ],
      },
    ],
  });

  return extractToolInput(msg);
}
