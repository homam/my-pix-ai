// Training-quality presets — the single source of truth shared by the training
// UI (NewModelForm / RetrainPanel via TrainingOptions) and the API routes
// (/api/train, /api/models/[id]/retry). Everyday users pick a preset; the raw
// step count is only exposed in the "Advanced" control.
//
// A preset resolves to a concrete training-step count PER ENGINE, because the
// two engines don't share a step scale:
//   - Standard (Astria FLUX.1, `flux-lora-portrait`): the preset self-tunes its
//     own step count, and that default already gives strong likeness — so
//     "Balanced" leaves it on AUTO (null) to avoid regressing known-good output.
//     Fast/Maximum nudge it down/up.
//   - Ultra (fal FLUX.2): fal's generic trainer default of 1000 steps was too
//     light for face identity (the reason Ultra likeness trailed Standard), so
//     "Balanced" is 1500 and "Maximum" 2500. More steps = stronger likeness but
//     longer (and, on Ultra, more expensive) training.
//
// Steps are resolved SERVER-SIDE from the preset id so a client can't post an
// arbitrary, cost-inflating step count; the Advanced custom value is clamped to
// [STEPS_MIN, STEPS_MAX] on the server too.

export type TrainingQuality = "fast" | "balanced" | "max";
export type TrainEngine = "astria" | "fal";

export const DEFAULT_QUALITY: TrainingQuality = "balanced";

// Bounds for the Advanced custom-steps control (also the server clamp).
export const STEPS_MIN = 500;
export const STEPS_MAX = 3000;

export interface TrainingPresetView {
  id: TrainingQuality;
  label: string;
  blurb: string;
  recommended?: boolean;
}

// Vendor-neutral copy for the preset cards (no vendor/model names, no raw
// numbers — those live in Advanced).
export const TRAINING_PRESETS: TrainingPresetView[] = [
  { id: "fast", label: "Fast", blurb: "Quickest to train — a solid first look." },
  {
    id: "balanced",
    label: "Balanced",
    blurb: "The best mix of likeness and speed.",
    recommended: true,
  },
  { id: "max", label: "Maximum", blurb: "Sharpest likeness. Trains the longest." },
];

const STEPS_BY_ENGINE: Record<TrainEngine, Record<TrainingQuality, number | null>> = {
  // null = let Astria's portrait preset pick its own (known-good) step count.
  astria: { fast: 800, balanced: null, max: 1400 },
  fal: { fast: 1000, balanced: 1500, max: 2500 },
};

/**
 * Resolve a preset to a concrete step count for an engine. Returns null when the
 * engine should use its own default (Standard / Balanced), which callers pass
 * straight through (Astria accepts `steps: null`).
 */
export function resolveSteps(
  quality: TrainingQuality,
  engine: TrainEngine
): number | null {
  return STEPS_BY_ENGINE[engine][quality];
}

/** Clamp a custom (Advanced) step value into the allowed range. */
export function clampSteps(steps: number): number {
  return Math.max(STEPS_MIN, Math.min(STEPS_MAX, Math.round(steps)));
}
