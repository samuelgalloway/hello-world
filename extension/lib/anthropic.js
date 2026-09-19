// Minimal client for the Claude Messages API (POST /v1/messages), used only
// as a fallback text generator: TypeSafe's Jev model returns typed
// judgments, not generated text, so composing an actual value to type (e.g.
// cleaning up dictated, unquoted speech into "Jane Doe" or a short note)
// needs a real generative model. Kept to the one job it's needed for -
// routing/targeting decisions stay on TypeSafe.
//
// Raw fetch (no SDK) for the same reason as lib/typesafe.js: the extension
// ships unpacked with no bundler. Lives only in the background service
// worker, which has no `window`/`document`/`navigator` - verified against
// anthropic-sdk-typescript's own isRunningInBrowser() guard, the same
// window+document+navigator check TypeSafe's SDK uses.

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_MODEL = "claude-haiku-4-5";
export const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicAPIError extends Error {
  constructor(status, body) {
    super(`Anthropic API request failed with status ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "AnthropicAPIError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Ask Haiku to produce one short literal string, e.g. the exact value to
 * type into a form field, cleaned up from a raw voice transcript.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.system - instructions constraining the output shape
 * @param {string} opts.prompt - the user content (transcript + field context)
 * @param {number} [opts.maxTokens] - deliberately short output; default 300
 * @param {string} [opts.model]
 * @param {string} [opts.baseURL]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
 * @returns {Promise<string>} the generated text, trimmed
 */
export async function generateText({
  apiKey,
  system,
  prompt,
  maxTokens = 300,
  model = DEFAULT_MODEL,
  baseURL = DEFAULT_BASE_URL,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("generateText: apiKey is required");
  if (!prompt) throw new Error("generateText: prompt is required");

  const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new AnthropicAPIError(response.status, body);
  }

  const textBlock = (body.content || []).find((block) => block.type === "text");
  return (textBlock?.text || "").trim();
}
