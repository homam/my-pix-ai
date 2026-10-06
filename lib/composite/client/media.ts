"use client";

// Browser-side media preparation for a composite group.
//
// Everything here runs on the user's device, before upload:
//   - photos are decoded (EXIF orientation applied), measured, and a reference
//     copy no larger than 2048 px is made — the provider gets that, not the
//     24-megapixel original;
//   - each still gets a 64-bit difference hash (near-duplicate detection) and a
//     sharpness score (variance of the Laplacian) for automatic selection;
//   - a video is decoded by the browser's own <video> element and stills are
//     drawn at timestamps (lib/composite/selection.ts frameTimes).
//
// Why the browser and not a server worker: production runs on App Runner, which
// has no worker tier and cuts requests at 120 s, and an 89-second phone video is
// ~100 MB — above the shared project's 50 MB object cap. Decoding locally needs
// no upload at all before the user can see candidate frames. The cost is codec
// coverage: HEVC (.MOV from iPhones) decodes in Safari and in Chrome/Edge on
// macOS and recent Windows, not in Firefox — that case fails loudly below.

import { frameTimes } from "@/lib/composite/selection";

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export interface Analyzed {
  width: number;
  height: number;
  reference: Blob; // JPEG, long edge ≤ referenceLongEdge
  previewUrl: string; // object URL of `reference`, for the contact sheet
  sharpness: number;
  phash: string;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function toBlob(c: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new MediaError("could not encode the image"))), "image/jpeg", quality)
  );
}

function grey(ctx: CanvasRenderingContext2D, w: number, h: number): Float32Array {
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  }
  return out;
}

/** 64-bit dHash: 9×8 greyscale, each pixel compared with its right neighbour. */
function dHash(src: CanvasImageSource): string {
  const c = canvas(9, 8);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, 9, 8);
  const g = grey(ctx, 9, 8);
  let hex = "";
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) {
      byte = (byte << 1) | (g[row * 9 + col]! > g[row * 9 + col + 1]! ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Variance of the 4-neighbour Laplacian on a ≤256 px greyscale copy. */
function sharpness(src: CanvasImageSource, w: number, h: number): number {
  const scale = Math.min(1, 256 / Math.max(w, h));
  const sw = Math.max(3, Math.round(w * scale));
  const sh = Math.max(3, Math.round(h * scale));
  const c = canvas(sw, sh);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, sw, sh);
  const g = grey(ctx, sw, sh);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const lap = g[i - 1]! + g[i + 1]! + g[i - sw]! + g[i + sw]! - 4 * g[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.round((sumSq / n - mean * mean) * 100) / 100;
}

async function analyzeSource(
  src: CanvasImageSource,
  w: number,
  h: number,
  longEdge: number
): Promise<Analyzed> {
  const scale = Math.min(1, longEdge / Math.max(w, h));
  const c = canvas(w * scale, h * scale);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  const reference = await toBlob(c, 0.9);
  return {
    width: w,
    height: h,
    reference,
    previewUrl: URL.createObjectURL(reference),
    sharpness: sharpness(c, c.width, c.height),
    phash: dHash(c),
  };
}

export async function analyzePhoto(file: File, longEdge: number): Promise<Analyzed> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new MediaError(`${file.name}: this browser cannot read the image`);
  }
  try {
    return await analyzeSource(bitmap, bitmap.width, bitmap.height, longEdge);
  } finally {
    bitmap.close();
  }
}

export interface AnalyzedFrame extends Analyzed {
  timeS: number;
}
export interface AnalyzedVideo {
  width: number;
  height: number;
  duration: number;
  frames: AnalyzedFrame[];
}

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      reject(new MediaError("decode error"));
    };
    const timer = setTimeout(() => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", fail);
      reject(new MediaError("timed out"));
    }, timeoutMs);
    target.addEventListener(event, done);
    target.addEventListener("error", fail);
  });
}

const CANNOT_DECODE = (name: string) =>
  `${name}: this browser cannot decode the video. iPhone .MOV files are usually HEVC (H.265), ` +
  "which Safari and Chrome or Edge on a Mac decode but Firefox does not. Open this page in one of " +
  "those, or export the clip as H.264 MP4.";

export async function analyzeVideo(
  file: File,
  longEdge: number,
  onFrame?: (done: number, total: number) => void
): Promise<AnalyzedVideo> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    try {
      await once(video, "loadeddata", 30_000);
    } catch {
      throw new MediaError(CANNOT_DECODE(file.name));
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    const duration = video.duration;
    if (!w || !h || !Number.isFinite(duration) || duration <= 0) {
      throw new MediaError(CANNOT_DECODE(file.name));
    }
    const times = frameTimes(duration);
    const frames: AnalyzedFrame[] = [];
    for (const t of times) {
      video.currentTime = t;
      try {
        await once(video, "seeked", 15_000);
      } catch {
        throw new MediaError(CANNOT_DECODE(file.name));
      }
      const a = await analyzeSource(video, w, h, Math.max(w, h) > longEdge ? longEdge : Math.max(w, h));
      frames.push({ ...a, timeS: Math.round(t * 10) / 10 });
      onFrame?.(frames.length, times.length);
    }
    // A decoder that "seeks" but paints nothing yields identical black frames.
    if (frames.length > 1 && frames.every((f) => f.phash === frames[0]!.phash && f.sharpness < 1)) {
      throw new MediaError(CANNOT_DECODE(file.name));
    }
    return { width: w, height: h, duration, frames };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export function isPhoto(file: File): boolean {
  return ["image/jpeg", "image/png", "image/webp"].includes(file.type);
}

export function isVideo(file: File): boolean {
  return (
    ["video/quicktime", "video/mp4"].includes(file.type) ||
    (!file.type && /\.(mov|mp4)$/i.test(file.name))
  );
}

export function videoMime(file: File): "video/quicktime" | "video/mp4" {
  if (file.type === "video/mp4" || /\.mp4$/i.test(file.name)) return "video/mp4";
  return "video/quicktime";
}

/** Why a dropped file cannot be used, or null when it can. */
export function rejectReason(file: File): string | null {
  if (isPhoto(file) || isVideo(file)) return null;
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    return `${file.name}: HEIC photos are not supported yet — export as JPEG (on iPhone: Settings › Camera › Formats › Most Compatible)`;
  }
  return `${file.name}: unsupported file type — use JPEG, PNG or WebP photos and a MOV or MP4 video`;
}

/** PUT a blob to a signed upload slot with byte-level progress. */
export function putToSlot(
  supabaseUrl: string,
  bucket: string,
  slot: { path: string; token: string },
  body: Blob,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const path = slot.path.split("/").map(encodeURIComponent).join("/");
    xhr.open(
      "PUT",
      `${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}?token=${encodeURIComponent(slot.token)}`
    );
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `upload failed (HTTP ${xhr.status})`;
      try {
        msg = JSON.parse(xhr.responseText).message ?? msg;
      } catch {}
      reject(new MediaError(msg));
    };
    xhr.onerror = () => reject(new MediaError("upload failed — check your connection"));
    xhr.send(body);
  });
}
