// White-label brand registry. Everything brand-variable — display name, SEO
// copy, support email, legal entity, retail credit packs — lives here, keyed
// by NEXT_PUBLIC_BRAND_KEY (see PLATFORM.md: one product, many brands; a
// deployment picks its brand via this env var). Product economics
// (CREDIT_COSTS) stay in @/types: features belong to the product, so every
// brand charges the same credits — only the $ packs and skin differ.
//
// NEXT_PUBLIC_BRAND_KEY is inlined at build time, so BRAND is safe to import
// from both server and client components.

import type { CreditPack } from "@/types";

export interface BrandLegal {
  /** Legal entity shown in the footer © line and on /terms + /privacy. */
  companyName: string;
  /** Registered address, rendered on legal pages when set. */
  address?: string;
  /** Governing-law clause on /terms, rendered when set. */
  jurisdiction?: string;
  /** First year of operation for the © line. */
  sinceYear: number;
}

export interface BrandConfig {
  /** Brand key — matches core.brands.key when on the shared platform. */
  key: string;
  /** Display name used everywhere in the UI and emails. */
  name: string;
  /** Full <title> for the root layout. */
  metaTitle: string;
  /** Meta description for the root layout. */
  description: string;
  /** Short OG tagline. */
  tagline: string;
  /** Canonical production URL — fallback when NEXT_PUBLIC_APP_URL is unset. */
  productionUrl: string;
  supportEmail: string;
  legal: BrandLegal;
  /** Retail credit packs. Stripe price IDs stay per-deployment env vars. */
  packs: CreditPack[];
}

const BRANDS: Record<string, BrandConfig> = {
  mypix: {
    key: "mypix",
    name: "MyPix AI",
    metaTitle: "MyPix AI — AI-Powered Photo Studio",
    description:
      "Upload 10–20 photos of yourself and generate stunning photorealistic AI portraits in any setting, outfit, or style.",
    tagline: "Your AI photo studio. Train once, generate forever.",
    productionUrl: "https://my-pix.ai",
    supportEmail: "hello@mypix.ai",
    legal: {
      companyName: "MyPix AI",
      sinceYear: 2026,
    },
    packs: [
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
    ],
  },
};

const brandKey = process.env.NEXT_PUBLIC_BRAND_KEY ?? "mypix";
const active = BRANDS[brandKey];
if (!active) {
  throw new Error(
    `Unknown NEXT_PUBLIC_BRAND_KEY "${brandKey}" — add it to lib/brand.ts (known: ${Object.keys(BRANDS).join(", ")})`
  );
}

export const BRAND: BrandConfig = active;

/** Public origin of this deployment (no trailing slash). */
export function brandUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? BRAND.productionUrl).replace(
    /\/$/,
    ""
  );
}
