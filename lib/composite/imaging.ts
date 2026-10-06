// Server-side pixel work for composites (sharp). Server-only.
//
// The one non-obvious operation is the MOVE correction. The 2026-10-06 spike
// showed that instruction-following editors do not relocate an element reliably:
// asked to "move the sun above the glint", nano-banana-pro closed an 8% gap to 5%,
// explicit percentages made no difference, and Seedream "fixed" it by moving the
// glint and recomposing the harbor. What both Gemini models did perfectly was
// REMOVE a marked leftover. So a move is split in two:
//   1. here, deterministically: paste a feathered patch of the element at the
//      user's target position (the pixels are exactly the element's own);
//   2. the provider: repaint only the leftover inside a red guide circle.
// Measured on the coastline case: 0.0% residual offset on both models.

import sharp from "sharp";
import type { CompositeAspect, CorrectionMarks } from "@/lib/composite/types";

export interface Probe {
  width: number;
  height: number;
  mime: string;
  ext: string;
}

export async function probe(buf: Buffer): Promise<Probe> {
  const m = await sharp(buf).metadata();
  if (!m.width || !m.height) throw new Error("image has no dimensions");
  const fmt = m.format ?? "jpeg";
  const mime = fmt === "png" ? "image/png" : fmt === "webp" ? "image/webp" : "image/jpeg";
  return { width: m.width, height: m.height, mime, ext: fmt === "jpeg" ? "jpg" : fmt };
}

/** A display/review copy whose long edge is at most `longEdge`. */
export async function downscaleJpeg(buf: Buffer, longEdge: number, quality = 85): Promise<Buffer> {
  return sharp(buf)
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

/** Full-resolution JPEG of a render — the edit target handed to the provider. */
export async function fullJpeg(buf: Buffer, quality = 92): Promise<Buffer> {
  return sharp(buf).rotate().jpeg({ quality, mozjpeg: true }).toBuffer();
}

/** The labelled 4K-dimension export: plain Lanczos resampling, nothing invented. */
export async function upscaleJpeg(buf: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(buf)
    .resize({ width, height, fit: "fill", kernel: "lanczos3" })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

function ringSvg(w: number, h: number, cx: number, cy: number, r: number): Buffer {
  const stroke = Math.max(4, Math.round(w * 0.006));
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff2020" stroke-width="${stroke}"/></svg>`
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The GUIDE image for area/move corrections: the target with a red circle. */
export async function guideImage(target: Buffer, what: { x: number; y: number; r: number }): Promise<Buffer> {
  const { width: w, height: h } = await probe(target);
  const r = Math.max(8, Math.round(clamp01(what.r) * w));
  return sharp(target)
    .composite([{ input: ringSvg(w, h, Math.round(clamp01(what.x) * w), Math.round(clamp01(what.y) * h), r) }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Step 1 of a move: copy a feathered circular patch around `marks.what` and
 * paste it centred on `marks.where`. Returns the pasted image (the new edit
 * target) and the guide marking the leftover at the old position.
 */
export async function transplant(
  target: Buffer,
  marks: Required<Pick<CorrectionMarks, "what" | "where">>
): Promise<{ pasted: Buffer; guide: Buffer }> {
  const { width: w, height: h } = await probe(target);
  const r = Math.max(8, Math.round(clamp01(marks.what.r) * w));
  const d = 2 * r;
  const fx = Math.round(clamp01(marks.what.x) * w);
  const fy = Math.round(clamp01(marks.what.y) * h);
  const tx = Math.round(clamp01(marks.where.x) * w);
  const ty = Math.round(clamp01(marks.where.y) * h);

  // Clip the source square to the canvas; the mask is cut to match.
  const left = Math.max(0, fx - r);
  const top = Math.max(0, fy - r);
  const width = Math.min(w, fx + r) - left;
  const height = Math.min(h, fy + r) - top;
  if (width < 4 || height < 4) throw new Error("the marked area is outside the image");

  const patch = await sharp(target).extract({ left, top, width, height }).toBuffer();
  const mask = await sharp(
    Buffer.from(
      `<svg width="${d}" height="${d}" xmlns="http://www.w3.org/2000/svg"><defs>` +
        `<radialGradient id="g"><stop offset="55%" stop-color="white"/><stop offset="100%" stop-color="black"/></radialGradient>` +
        `</defs><rect width="${d}" height="${d}" fill="url(#g)"/></svg>`
    )
  )
    .extract({ left: left - (fx - r), top: top - (fy - r), width, height })
    .greyscale()
    .raw()
    .toBuffer();
  const feathered = await sharp(patch)
    .ensureAlpha()
    .joinChannel(mask, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  // Where the clipped patch lands, clipped again to the canvas.
  let dx = tx - (fx - left);
  let dy = ty - (fy - top);
  let pw = width;
  let ph = height;
  let sx = 0;
  let sy = 0;
  if (dx < 0) { sx = -dx; pw += dx; dx = 0; }
  if (dy < 0) { sy = -dy; ph += dy; dy = 0; }
  pw = Math.min(pw, w - dx);
  ph = Math.min(ph, h - dy);
  if (pw < 4 || ph < 4) throw new Error("the target position is outside the image");
  const placed =
    sx || sy || pw !== width || ph !== height
      ? await sharp(feathered).extract({ left: sx, top: sy, width: pw, height: ph }).png().toBuffer()
      : feathered;

  const pasted = await sharp(target)
    .composite([{ input: placed, left: dx, top: dy }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  const guide = await guideImage(pasted, marks.what);
  return { pasted, guide };
}

const ASPECT: Record<CompositeAspect, number> = { "21:9": 21 / 9, "16:9": 16 / 9, "3:2": 3 / 2, "1:1": 1 };

/**
 * The mock provider's "render": the references side by side at a common
 * height, centre-cropped to the requested aspect ratio. Deterministic, free,
 * and obviously not a real composite — for development and the smoke journey.
 */
export async function mockStitch(images: Buffer[], aspect: CompositeAspect, height = 1080): Promise<Buffer> {
  if (images.length === 0) throw new Error("nothing to stitch");
  const tiles = await Promise.all(
    images.map((b) => sharp(b).rotate().resize({ height }).png().toBuffer({ resolveWithObject: true }))
  );
  const total = tiles.reduce((s, t) => s + t.info.width, 0);
  let x = 0;
  const strip = await sharp({ create: { width: total, height, channels: 3, background: "#000" } })
    .composite(tiles.map((t) => { const at = { input: t.data, left: x, top: 0 }; x += t.info.width; return at; }))
    .png()
    .toBuffer();
  const wantW = Math.round(height * ASPECT[aspect]);
  return sharp(strip)
    .resize({ width: wantW, height, fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}
