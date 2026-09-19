// Minimal client for the TypeSafe AI System One API (POST /v1/systemone).
//
// This mirrors the wire contract of the published `@typesafe-ai/sdk` package
// (Authorization: Bearer <key>, request/response shapes) without requiring a
// bundler, since the extension ships as plain, unpacked JS. Only lives in
// the background service worker (no `window`/`document`), never in a
// content script injected into third-party pages.

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

/** A yes/no question. `criteria` optionally describes the true/false outcomes. */
export function noul(instructions, criteria) {
  const q = { type: "noul", instructions: instructions ?? null };
  if (criteria) q.criteria = criteria;
  return q;
}

/** A question that assigns a score against an ordered rubric (>= 2 entries). */
export function score(instructions, criteria) {
  if (!Array.isArray(criteria) || criteria.length < 2) {
    throw new Error("score() criteria must be an array of at least two entries");
  }
  return { type: "score", instructions: instructions ?? null, criteria };
}

/** A question that selects one label from `criteria` (label -> description). */
export function choice(instructions, criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new Error("choice() criteria must be an object of label -> description");
  }
  return { type: "choice", instructions: instructions ?? null, criteria };
}

export class TypeSafeAPIError extends Error {
  constructor(status, body, requestId) {
    super(
      `TypeSafe API request failed with status ${status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
    this.name = "TypeSafeAPIError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

/**
 * Call POST /v1/systemone.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string|object|Array|null} opts.state
 * @param {Record<string, object>} opts.questions - built with choice()/noul()/score()
 * @param {string} [opts.model]
 * @param {string} [opts.baseURL]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
 * @returns {Promise<{model: string, answers: Record<string, any>, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function systemOne({
  apiKey,
  state,
  questions,
  model = DEFAULT_MODEL,
  baseURL = DEFAULT_BASE_URL,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("systemOne: apiKey is required");
  if (!questions || Object.keys(questions).length === 0) {
    throw new Error("systemOne: questions must be a non-empty object");
  }

  const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/v1/systemone`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ state: state ?? null, questions, model }),
  });

  const requestId = response.headers?.get?.("x-typesafe-request-id") ?? undefined;
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new TypeSafeAPIError(response.status, body, requestId);
  }
  return body;
}
