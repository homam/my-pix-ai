// "expired" = Astria deleted the trained tune's weights (~30 days post-training);
// the model needs retraining before it can generate again. See lib/astria.ts.
export type ModelStatus =
  | "pending"
  | "training"
  | "ready"
  | "failed"
  | "expired";

export interface Model {
  id: string;
  user_id: string;
  name: string;
  status: ModelStatus;
  // Engine this model is trained on / renders with, chosen at creation.
  // Absent on legacy rows (treat as "astria"). See lib/providers.ts.
  provider: "astria" | "fal";
  astria_tune_id: number | null;
  // FLUX.2 LoRA weights URL when this model was trained on fal (provider "fal").
  // null until fal training completes. See lib/fal.ts.
  fal_lora_url: string | null;
  // fal training request id, used to poll async training completion.
  fal_request_id: string | null;
  cover_image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelImage {
  id: string;
  model_id: string;
  url: string;
  created_at: string;
}

// Studio tools write these kinds; plain generations stay 'generation'.
export type ImageKind =
  | "generation"
  | "faceswap"
  | "inpaint"
  | "outpaint"
  | "restore"
  | "tryon";

export interface GenerationSettings {
  // What we actually sent to Astria — the user's prompt plus any auto-prepended
  // trigger phrase and realism suffix. Useful for "why does this look like this".
  fullPrompt?: string;
  // Which backend rendered this image. Absent on legacy rows (== "astria").
  provider?: "astria" | "fal";
  realism?: "polished" | "natural" | "documentary";
  aspectRatio?: "1:1" | "4:5" | "2:3" | "3:2" | "9:16" | "16:9";
  filmGrain?: boolean;
  faceCorrect?: boolean;
  superResolution?: boolean;
  faceSwap?: boolean;
  inpaintFaces?: boolean;
  hiresFix?: boolean;
  // Astria film-emulation grade, or null when none was applied.
  colorGrading?: string | null;
  variety?: boolean;
  cfgScale?: number;
  // Actual seed used (server-generated when the user didn't lock one).
  // null when the seed wasn't tracked (legacy rows or fan-out batches).
  seed?: number | null;
  // Set when the image came from a one-click prompt pack, so we can attribute
  // generations to a pack. Absent for ad-hoc prompts.
  packId?: string;
  // Studio's one-click likeness boost (maps to face_swap + inpaint_faces).
  // colorGrading is declared above (string | null).
  boostLikeness?: boolean;
  // Studio edit inputs (faceswap/inpaint/outpaint/restore/tryon kinds).
  sourceUrl?: string;
  maskUrl?: string;
  denoisingStrength?: number;
  outpaintAnchor?: string;
  outpaintWidth?: number;
  outpaintHeight?: number;
  colorize?: boolean;
  garmentId?: string;
}

export interface GeneratedImage {
  id: string;
  // Null for studio edits that don't involve a trained model (restore, etc.).
  model_id: string | null;
  user_id: string;
  prompt: string;
  url: string;
  astria_image_id: string | null;
  astria_source_url: string | null;
  astria_prompt_id: number | null;
  settings: GenerationSettings | null;
  kind: ImageKind;
  source_image_id: string | null;
  created_at: string;
}

export interface GarmentTune {
  id: string;
  user_id: string;
  title: string;
  astria_tune_id: number | null;
  status: "pending" | "ready" | "failed";
  image_url: string;
  created_at: string;
}

export interface UserCredits {
  id: string;
  user_id: string;
  balance: number;
  updated_at: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  type: "purchase" | "training" | "generation" | "refund";
  stripe_session_id: string | null;
  description: string;
  created_at: string;
}

// Astria API types
export interface AstriaTune {
  id: number;
  title: string;
  name: string;
  steps: number | null;
  token: string;
  trained_at: string | null;
  started_training_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  orig_images: string[];
  callback: string | null;
  branch: string;
  model_type: string | null;
  base_tune_id: number;
  ckpt_url: string | null;
}

export interface AstriaPrompt {
  id: number;
  text: string;
  tune_id: number;
  trained_at: string | null;
  started_training_at: string | null;
  created_at: string;
  updated_at: string;
  images: string[];
}

// Credit pack shape. The actual packs (retail pricing) are brand-scoped and
// live in lib/brand.ts (BRAND.packs) — brands may price differently, so
// there is deliberately no pack constant here.
export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price: number; // in cents
  priceId: string; // Stripe price ID env var key
  popular?: boolean;
  description: string;
}

// Credit costs
export const CREDIT_COSTS = {
  TRAINING: 20, // cost to train one model
  GENERATION: 1, // cost per generated image
  GARMENT: 5, // cost to fine-tune one garment for virtual try-on
} as const;
