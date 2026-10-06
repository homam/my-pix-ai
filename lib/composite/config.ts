// Composite feature configuration: which provider renders, its limits, and the
// media caps. Server-only (reads process.env); pages pass the public parts to
// the client as props.
//
// The feature is env-gated like the fal "Ultra" engine: with no provider
// configured, Studio hides Compose and every composite route answers 503 before
// any credit is touched.

export const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const ACCEPTED_VIDEO_TYPES = ["video/quicktime", "video/mp4"] as const;

const MB = 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export interface CompositeLimits {
  maxPhotosPerGroup: number;
  maxVideosPerGroup: number;
  maxFramesPerVideo: number;
  maxPhotoBytes: number;
  // Larger videos are still accepted: their frames are extracted in the browser
  // and kept, but the original file is not stored (see docs/COMPOSITES.md —
  // the shared Supabase project caps every object at 50 MB).
  maxStoredVideoBytes: number;
  maxVideoBytes: number;
  maxVideoDurationS: number;
  referenceLongEdge: number;
}

export function compositeLimits(): CompositeLimits {
  return {
    maxPhotosPerGroup: envInt("COMPOSITE_MAX_PHOTOS", 30),
    maxVideosPerGroup: 1,
    maxFramesPerVideo: 30,
    maxPhotoBytes: 50 * MB,
    maxStoredVideoBytes: envInt("COMPOSITE_MAX_STORED_VIDEO_MB", 50) * MB,
    maxVideoBytes: 4096 * MB,
    maxVideoDurationS: envInt("COMPOSITE_MAX_VIDEO_SECONDS", 600),
    referenceLongEdge: 2048,
  };
}

export type CompositeProviderId = "fal" | "mock";

export interface ProviderProfile {
  id: CompositeProviderId;
  model: string;
  // Hard cap on reference images per render, enforced server-side.
  maxReferences: number;
  // How many the automatic selection aims for.
  targetReferences: number;
  // Sources sent as evidence with a correction (after the target and guide).
  maxEvidence: number;
  resolution: "1K" | "2K" | "4K";
}

// Chosen by the 2026-10-06 spike (docs/COMPOSITES.md): Gemini 3 Pro Image kept
// the user-marked detail, invented no geography and renders native 4K. The
// model accepts up to 14 references; 10 leaves headroom and keeps renders
// legible. Overridable per deployment without a code change.
const DEFAULT_FAL_MODEL = "fal-ai/nano-banana-pro/edit";

export function compositeProvider(): ProviderProfile | null {
  const choice = (process.env.COMPOSITE_PROVIDER ?? "").trim().toLowerCase();
  if (choice === "off") return null;
  const resolution = (["1K", "2K", "4K"] as const).find(
    (r) => r === process.env.COMPOSITE_RESOLUTION
  ) ?? "4K";

  if (choice === "mock") {
    // Renders a deterministic stitched image without calling anyone — for local
    // development and the smoke journey. Never in a production build unless a
    // deployment explicitly opts in.
    if (process.env.NODE_ENV === "production" && process.env.COMPOSITE_ALLOW_MOCK !== "1") {
      return null;
    }
    return { id: "mock", model: "mock-stitch", maxReferences: 10, targetReferences: 6, maxEvidence: 3, resolution };
  }
  if (!process.env.FAL_KEY) return null;
  return {
    id: "fal",
    model: process.env.COMPOSITE_MODEL?.trim() || DEFAULT_FAL_MODEL,
    maxReferences: 10,
    targetReferences: 6,
    maxEvidence: 3,
    resolution,
  };
}

/** What the browser needs to build a group (passed as props, no secrets). */
export interface ComposeClientConfig {
  enabled: boolean;
  cost: number;
  maxReferences: number;
  targetReferences: number;
  maxEvidence: number;
  maxPhotosPerGroup: number;
  maxPhotoBytes: number;
  maxStoredVideoBytes: number;
  maxVideoBytes: number;
  maxVideoDurationS: number;
  referenceLongEdge: number;
  providerLabel: string;
}

export function composeClientConfig(cost: number): ComposeClientConfig {
  const p = compositeProvider();
  const l = compositeLimits();
  return {
    enabled: Boolean(p),
    cost,
    maxReferences: p?.maxReferences ?? 0,
    targetReferences: p?.targetReferences ?? 0,
    maxEvidence: p?.maxEvidence ?? 0,
    maxPhotosPerGroup: l.maxPhotosPerGroup,
    maxPhotoBytes: l.maxPhotoBytes,
    maxStoredVideoBytes: l.maxStoredVideoBytes,
    maxVideoBytes: l.maxVideoBytes,
    maxVideoDurationS: l.maxVideoDurationS,
    referenceLongEdge: l.referenceLongEdge,
    providerLabel: p ? `${p.resolution} render` : "",
  };
}
