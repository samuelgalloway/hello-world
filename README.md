# Retouch: minimal, conservative photo retouching

Open a photo. Claude flags small, clearly distracting flaws (blemishes, stray hairs, dust
spots). You approve, skip or add spots. It fixes *only* those spots and leaves the rest of the
photo alone. Then you download the result.

## How it works

1. **Detection** (`/api/detect`): the browser sends a downscaled copy (1568px long edge) to
   Claude. It returns tight boxes for clear flaws only. The prompt lists what *not* to flag:
   moles, freckles, wrinkles, normal skin texture, and anything it isn't sure about. Structured
   outputs guarantee the reply is valid JSON.
2. **Review**: flagged spots appear as circles on the photo and in a side list. Click a circle to
   include or skip it, or remove it from the list. **Click the photo to mark a spot the scan
   missed, or drag to draw a box.**
3. **Masked fix** (`/api/retouch`): for each group of nearby spots, the browser crops a small
   patch plus a mask and sends only that crop to [LaMa](https://replicate.com/allenhooo/lama)
   on Replicate. LaMa is a content-aware fill, not a diffusion model: it rebuilds the masked
   pixels from surrounding texture. The browser pastes the patch back through a feathered
   ellipse, so every pixel outside the spots stays exactly as it was. The full-resolution photo
   never leaves the device.
4. **Check & export**: hold "see original" to compare, undo (also ⌘/Ctrl+Z), fix more spots in
   more passes, then download as JPEG (quality 95) or lossless PNG.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `.env.local`:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | [console.anthropic.com](https://console.anthropic.com) |
| `REPLICATE_API_TOKEN` | yes | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |
| `CLAUDE_MODEL` | no | Detection model. Default `claude-opus-5`. |
| `LAMA_MODEL` | no | Default `allenhooo/lama`, resolved to its latest version at runtime. Pin with `owner/name:versionhash`. |
| `APP_PASSCODE` | no | If set, the app asks for this passcode before calling any paid API. |

## Deploy (Vercel)

1. Import this repo in Vercel.
2. Add the environment variables above in the project settings. Consider setting
   `APP_PASSCODE`: without it, anyone with the URL can spend your API credits.
3. Deploy. The API routes allow up to 120s (`maxDuration`) to cover LaMa cold starts.
   Requests stay well under Vercel's 4.5 MB body limit because only previews and crops are sent.

## Notes & limits

- **The detection prompt is the main lever.** Tune `SYSTEM_PROMPT` in
  `app/api/detect/route.ts` based on what gets over-flagged or missed.
- **Refusal fallback:** detection enables the API's server-side fallback
  (`fallbacks: "default"`), so a declined request is retried on a fallback model. If the whole
  chain declines, the app shows an error.
- **Metadata:** the export is re-encoded in the browser, so EXIF (camera, GPS, date) is not
  kept. Use the PNG export for a lossless file.
- **Formats:** JPEG/PNG/WebP work everywhere. HEIC opens only in Safari; elsewhere, export as
  JPEG first. RAW needs a conversion step before this app.
- **Cost:** one Claude call per scan and one Replicate run per group of nearby spots per fix.
