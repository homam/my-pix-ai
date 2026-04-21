export type ModelStatus = "pending" | "training" | "ready" | "failed";

export interface Model {
  id: string;
  user_id: string;
  name: string;
  status: ModelStatus;
  astria_tune_id: number | null;
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

export interface GeneratedImage {
  id: string;
  model_id: string;
  user_id: string;
  prompt: string;
  url: string;
  astria_image_id: string | null;
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
  type: "purchase" | "training" | "generation";
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

// Credit pack definitions
export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price: number; // in cents
  priceId: string; // Stripe price ID env var key
  popular?: boolean;
  description: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "starter",
    name: "Starter",
    credits: 50,
    price: 900,
    priceId: "STRIPE_PRICE_STARTER",
    description: "1 model + 30 photos",
  },
  {
    id: "pro",
    name: "Pro",
    credits: 200,
    price: 2900,
    priceId: "STRIPE_PRICE_PRO",
    popular: true,
    description: "4 models + 120 photos",
  },
  {
    id: "ultra",
    name: "Ultra",
    credits: 500,
    price: 5900,
    priceId: "STRIPE_PRICE_ULTRA",
    description: "10 models + 300 photos",
  },
];

// Credit costs
export const CREDIT_COSTS = {
  TRAINING: 20, // cost to train one model
  GENERATION: 1, // cost per generated image
} as const;
