// /api/cleanup.js
//
// Runs on Vercel's server, never in the browser. This is the ONLY place
// the Anthropic API key is used — it's read from an environment variable
// (set in Vercel → Project Settings → Environment Variables) and is never
// sent to, or visible from, the client. index.html calls this endpoint
// instead of talking to api.anthropic.com directly.

const MAX_NOTE_LENGTH = 6000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Project Settings → Environment Variables, then redeploy.'
    });
    return;
  }

  const rawText = typeof req.body?.rawText === 'string' ? req.body.rawText.trim() : '';
  if (!rawText) {
    res.status(400).json({ error: 'rawText is required' });
    return;
  }
  if (rawText.length > MAX_NOTE_LENGTH) {
    res.status(400).json({ error: 'That note is too long — please shorten it.' });
    return;
  }

  const prompt = `You are helping turn a rough, spoken or typed note about a family farm's history into a clean timeline entry. The note may be messy, a fragment, or just a description of a photo.

Raw note: """${rawText}"""

Reply with ONLY a JSON object, no markdown fences, no commentary, in this exact shape:
{"title": "short warm title, under 8 words", "dateLabel": "a human date guess like '1986' or 'Summer 1990s' or 'Undated', based only on what's in the note", "sortYear": <a 4-digit integer year if you can reasonably guess one, otherwise null>, "summary": "2-4 friendly sentences in plain language, cleaned up but keeping all the real facts from the note, written as if for a family history"}`;

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Claude: ' + e.message });
    return;
  }

  if (!anthropicRes.ok) {
    const text = await anthropicRes.text().catch(() => '');
    res.status(502).json({ error: `Claude request failed (${anthropicRes.status}): ${text.slice(0, 200)}` });
    return;
  }

  const data = await anthropicRes.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const cleanedText = text.replace(/^```json|```$/g, '').trim();

  let cleaned;
  try {
    cleaned = JSON.parse(cleanedText);
  } catch (e) {
    cleaned = { title: 'A farm memory', dateLabel: 'Undated', sortYear: null, summary: rawText };
  }
  res.status(200).json(cleaned);
};
