// Native vs export dimensions, and the words used for them. Pure (unit-tested).
//
// Rule from the session handoff: the provider's pixels are the NATIVE render.
// An export may be larger after resampling, and resampling recovers no detail,
// so a resized file is never described as native 4K — and pixel dimensions are
// never sold as print-size detail.

export const EXPORT_LONG_EDGE = 4096;
// A render whose long edge reaches UHD width already carries 4K-class detail.
export const NATIVE_4K_MIN_LONG_EDGE = 3840;

export interface Dims {
  width: number;
  height: number;
}

export interface ExportPlan {
  native: Dims;
  nativeIs4K: boolean;
  // null when the native render is already 4K-class: there is nothing to upscale.
  upscaled: Dims | null;
}

export function formatDims(d: Dims): string {
  return `${d.width} × ${d.height}`;
}

export function exportPlan(native: Dims): ExportPlan {
  const long = Math.max(native.width, native.height);
  const nativeIs4K = long >= NATIVE_4K_MIN_LONG_EDGE;
  if (nativeIs4K || long <= 0) return { native, nativeIs4K, upscaled: null };
  const scale = EXPORT_LONG_EDGE / long;
  return {
    native,
    nativeIs4K,
    upscaled: {
      width: Math.round(native.width * scale),
      height: Math.round(native.height * scale),
    },
  };
}

export function nativeLabel(plan: ExportPlan): string {
  return `Native render · ${formatDims(plan.native)}${plan.nativeIs4K ? " · native 4K" : ""}`;
}

/** The only sentence that may describe a resampled file. */
export function upscaledLabel(plan: ExportPlan): string | null {
  if (!plan.upscaled) return null;
  return (
    `Upscaled to 4K dimensions · ${formatDims(plan.upscaled)} · resampled from the ` +
    `${formatDims(plan.native)} native render — resampling adds no detail`
  );
}

// Aspect ratios the edit provider accepts (nano-banana-pro/edit).
const PROVIDER_ASPECTS = ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"] as const;
export type ProviderAspect = (typeof PROVIDER_ASPECTS)[number];

/** The provider aspect closest to `d` — a correction keeps its target's shape. */
export function closestAspect(d: Dims): ProviderAspect {
  const want = Math.log(d.width / d.height);
  let best: ProviderAspect = "1:1";
  let err = Infinity;
  for (const a of PROVIDER_ASPECTS) {
    const [w, h] = a.split(":").map(Number) as [number, number];
    const e = Math.abs(Math.log(w / h) - want);
    if (e < err) {
      err = e;
      best = a;
    }
  }
  return best;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "composite"
  );
}

export function downloadName(
  groupName: string,
  versionNumber: number,
  variant: "native" | "upscaled",
  dims: Dims,
  ext: string
): string {
  const tag = variant === "native" ? "native" : "upscaled-4k";
  return `${slug(groupName)}-v${versionNumber}-${tag}-${dims.width}x${dims.height}.${ext}`;
}
