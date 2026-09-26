import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requirePasscode } from "@/lib/auth";

// LaMa cold starts on Replicate can take a while.
export const maxDuration = 120;

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN, useFileOutput: false });

type ModelRef = `${string}/${string}:${string}`;
let resolvedModel: ModelRef | null = null;

// Community models on Replicate must be run by version hash. Accept a pinned
// "owner/name:version" via LAMA_MODEL, otherwise look up the latest version once.
async function lamaModel(): Promise<ModelRef> {
  const configured = process.env.LAMA_MODEL || "allenhooo/lama";
  if (configured.includes(":")) return configured as ModelRef;
  if (resolvedModel) return resolvedModel;
  const [owner, name] = configured.split("/");
  const model = await replicate.models.get(owner, name);
  const version = model.latest_version?.id;
  if (!version) throw new Error(`No published version for ${configured}`);
  resolvedModel = `${owner}/${name}:${version}`;
  return resolvedModel;
}

/**
 * Fills one masked crop. The browser sends only a small crop around the flaws plus a
 * binary mask, and composites the result back itself with a feathered edge — so the
 * rest of the photo never leaves the device and stays exactly as it was.
 */
export async function POST(req: NextRequest) {
  const denied = requirePasscode(req);
  if (denied) return denied;

  try {
    const { image, mask } = (await req.json()) as { image?: string; mask?: string };
    if (!image?.startsWith("data:image/") || !mask?.startsWith("data:image/")) {
      return NextResponse.json({ error: "image and mask data URLs are required" }, { status: 400 });
    }

    // LaMa is a content-aware fill, not a diffusion model: it reconstructs only the
    // masked pixels from surrounding texture rather than re-imagining the image.
    const output = await replicate.run(await lamaModel(), { input: { image, mask } });
    const url = Array.isArray(output) ? output[0] : output;
    if (typeof url !== "string") throw new Error("Unexpected LaMa output");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetching LaMa output failed: ${res.status}`);
    const type = res.headers.get("content-type") || "image/png";
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return NextResponse.json({ image: `data:${type};base64,${base64}` });
  } catch (err) {
    console.error("retouch error", err);
    return NextResponse.json({ error: "Retouching failed" }, { status: 500 });
  }
}
