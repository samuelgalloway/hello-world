import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { requirePasscode } from "@/lib/auth";
import type { Region } from "@/lib/types";

export const maxDuration = 120;

const anthropic = new Anthropic();

// This prompt is the single most important lever in the whole tool.
// Tune it based on what actually gets flagged as "missed" or "over-flagged" —
// that's real feedback, unlike a generic AI benchmark.
const SYSTEM_PROMPT = `You are assisting a professional photographer with MINIMAL, conservative
photo retouching. Your only job is to locate small, OBJECTIVELY distracting flaws that a
professional retoucher would clean up by hand — nothing more.

FLAG (each as its own small region):
- Acne, pimples, or clearly temporary blemishes
- Stray/flyaway hairs that cross the face or stick out oddly
- Small dust spots, sensor spots, or lint (visible as tiny dark/light specks)
- Stray eyelashes or small skin flecks that are clearly not meant to be there

NEVER FLAG:
- Normal skin texture, pores, or fine lines
- Moles, freckles, beauty marks, scars, or anything that looks like a permanent
  natural feature of the person
- Wrinkles, under-eye areas, or anything related to aging
- Anything that would require smoothing, blurring, or reshaping a broad area
- Anything you are not clearly confident about — when in doubt, leave it out

Give each flaw a tight bounding box in PIXEL coordinates of the image you were given
(x/y is the top-left corner). Keep boxes small and precise — just around the flaw itself,
never around whole facial regions. A long stray hair may need several small boxes along
its length rather than one large box. If there is nothing to flag, return an empty list.`;

const DetectionSchema = z.object({
  flaws: z.array(
    z.object({
      type: z.enum(["blemish", "stray_hair", "dust_spot", "other_minor"]),
      note: z.string().describe("very short description, e.g. 'small blemish, left cheek'"),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  ),
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export async function POST(req: NextRequest) {
  const denied = requirePasscode(req);
  if (denied) return denied;

  try {
    const { imageBase64, width, height } = (await req.json()) as {
      imageBase64?: string;
      width?: number;
      height?: number;
    };
    if (!imageBase64 || !width || !height) {
      return NextResponse.json({ error: "imageBase64, width and height are required" }, { status: 400 });
    }

    const msg = await anthropic.beta.messages.parse({
      model: process.env.CLAUDE_MODEL || "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // If the primary model declines, the API re-runs the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: { format: betaZodOutputFormat(DetectionSchema) },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            {
              type: "text",
              text: `This image is ${width}×${height} pixels. Find only clear, minor, distracting flaws, per the rules.`,
            },
          ],
        },
      ],
    });

    if (msg.stop_reason === "refusal") {
      return NextResponse.json({ error: "The model declined to analyse this photo." }, { status: 422 });
    }
    const parsed = msg.parsed_output;
    if (!parsed) {
      return NextResponse.json({ error: "Could not read the detection result — try again." }, { status: 502 });
    }

    // Convert pixel boxes to percentages of the image, clamped to its bounds.
    const regions: Region[] = parsed.flaws
      .map((f, i) => {
        const x = clamp(f.x, 0, width);
        const y = clamp(f.y, 0, height);
        const w = clamp(f.width, 1, width - x);
        const h = clamp(f.height, 1, height - y);
        return {
          id: `auto-${i}-${Date.now().toString(36)}`,
          type: f.type,
          note: f.note,
          box: { x: (x / width) * 100, y: (y / height) * 100, width: (w / width) * 100, height: (h / height) * 100 },
        };
      })
      // Drop anything too large to be a "small flaw" (more than ~15% of either side).
      .filter((r) => r.box.width <= 15 && r.box.height <= 15);

    return NextResponse.json({ regions });
  } catch (err) {
    console.error("detect error", err);
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Too many requests — wait a moment and try again." }, { status: 429 });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "Server is missing a valid ANTHROPIC_API_KEY." }, { status: 500 });
    }
    return NextResponse.json({ error: "Detection failed" }, { status: 500 });
  }
}
