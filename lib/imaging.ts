// Browser-only canvas helpers. All full-resolution pixel work happens here, on the
// user's device; the server only ever sees a downscaled preview (for detection) and
// small crops around the flaws (for the fill).

import type { Region } from "./types";

type Rect = { x: number; y: number; w: number; h: number };
type Ellipse = { cx: number; cy: number; rx: number; ry: number };

/** Longest side of the image sent for detection (the vision model's sweet spot). */
const DETECT_MAX_SIDE = 1568;
/** Crops larger than this are downscaled before the fill to keep requests small. */
const FILL_MAX_SIDE = 1536;
/** Mask ellipse = flaw box scaled by this, plus a few pixels, so the fill covers edges. */
const MASK_PAD_SCALE = 1.5;
const MASK_PAD_PX = 3;
/** Inside this fraction of the mask radius the fill is used fully; it fades out beyond. */
const FEATHER_START = 0.72;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  return ctx;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Decodes a file into a full-resolution canvas, honouring EXIF orientation. */
export async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const c = makeCanvas(bitmap.width, bitmap.height);
  ctx2d(c).drawImage(bitmap, 0, 0);
  bitmap.close();
  return c;
}

function scaledCopy(src: CanvasImageSource, sw: number, sh: number, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const c = makeCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Downscaled JPEG for the detection request. Boxes come back as percentages, so scale doesn't matter. */
export function detectionPayload(src: HTMLCanvasElement) {
  const small = scaledCopy(src, src.width, src.height, DETECT_MAX_SIDE);
  const dataUrl = small.toDataURL("image/jpeg", 0.9);
  return { imageBase64: dataUrl.split(",")[1], width: small.width, height: small.height };
}

function regionEllipse(r: Region, W: number, H: number): Ellipse {
  const w = (r.box.width / 100) * W;
  const h = (r.box.height / 100) * H;
  return {
    cx: (r.box.x / 100) * W + w / 2,
    cy: (r.box.y / 100) * H + h / 2,
    rx: (w / 2) * MASK_PAD_SCALE + MASK_PAD_PX,
    ry: (h / 2) * MASK_PAD_SCALE + MASK_PAD_PX,
  };
}

function contextRect(e: Ellipse, W: number, H: number): Rect {
  // Give the fill plenty of surrounding texture to learn from.
  const half = Math.max(e.rx, e.ry) * 4 + 48;
  const x = Math.max(0, Math.floor(e.cx - half));
  const y = Math.max(0, Math.floor(e.cy - half));
  return { x, y, w: Math.min(W, Math.ceil(e.cx + half)) - x, h: Math.min(H, Math.ceil(e.cy + half)) - y };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Groups nearby flaws so each fill request covers one non-overlapping crop. */
function cluster(regions: Region[], W: number, H: number) {
  let groups = regions.map((r) => {
    const e = regionEllipse(r, W, H);
    return { rect: contextRect(e, W, H), ellipses: [e] };
  });
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (overlaps(groups[i].rect, groups[j].rect)) {
          groups[i] = { rect: union(groups[i].rect, groups[j].rect), ellipses: [...groups[i].ellipses, ...groups[j].ellipses] };
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

function drawEllipse(ctx: CanvasRenderingContext2D, e: Ellipse, dx: number, dy: number) {
  ctx.beginPath();
  ctx.ellipse(e.cx - dx, e.cy - dy, e.rx, e.ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Alpha mask that is opaque in the middle of each ellipse and fades to nothing at its edge. */
function featherMask(rect: Rect, ellipses: Ellipse[]): HTMLCanvasElement {
  const c = makeCanvas(rect.w, rect.h);
  const ctx = ctx2d(c);
  for (const e of ellipses) {
    ctx.save();
    ctx.translate(e.cx - rect.x, e.cy - rect.y);
    ctx.scale(e.rx, e.ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(FEATHER_START, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return c;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the retouched patch"));
    img.src = src;
  });
}

export type FillFn = (payload: { image: string; mask: string }) => Promise<string>;

/**
 * Returns a new canvas with the given regions filled. Only pixels inside each feathered
 * ellipse change; everything else is copied straight from `src`.
 */
export async function retouchRegions(
  src: HTMLCanvasElement,
  regions: Region[],
  fill: FillFn,
  onProgress?: (done: number, total: number) => void,
): Promise<HTMLCanvasElement> {
  const W = src.width;
  const H = src.height;
  const groups = cluster(regions, W, H);
  const out = cloneCanvas(src);
  const outCtx = ctx2d(out);
  let done = 0;
  onProgress?.(0, groups.length);

  async function process({ rect, ellipses }: (typeof groups)[number]) {
    const scale = Math.min(1, FILL_MAX_SIDE / Math.max(rect.w, rect.h));
    const sw = Math.round(rect.w * scale);
    const sh = Math.round(rect.h * scale);

    const crop = makeCanvas(sw, sh);
    const cropCtx = ctx2d(crop);
    cropCtx.imageSmoothingQuality = "high";
    cropCtx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, sw, sh);

    // Binary mask for the fill: white = replace, black = keep.
    const mask = makeCanvas(sw, sh);
    const maskCtx = ctx2d(mask);
    maskCtx.fillStyle = "#000";
    maskCtx.fillRect(0, 0, sw, sh);
    maskCtx.fillStyle = "#fff";
    maskCtx.scale(scale, scale);
    for (const e of ellipses) drawEllipse(maskCtx, e, rect.x, rect.y);

    const result = await loadImage(
      await fill({ image: crop.toDataURL("image/jpeg", 0.95), mask: mask.toDataURL("image/png") }),
    );

    // Patch = fill result at full crop resolution, clipped to the feathered ellipses.
    const patch = makeCanvas(rect.w, rect.h);
    const patchCtx = ctx2d(patch);
    patchCtx.imageSmoothingQuality = "high";
    patchCtx.drawImage(result, 0, 0, rect.w, rect.h);
    patchCtx.globalCompositeOperation = "destination-in";
    patchCtx.drawImage(featherMask(rect, ellipses), 0, 0);

    outCtx.drawImage(patch, rect.x, rect.y);
    onProgress?.(++done, groups.length);
  }

  // Crops never overlap after clustering, so they can be filled in parallel.
  const queue = [...groups];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) await process(g);
  });
  await Promise.all(workers);
  return out;
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), type, quality),
  );
}
