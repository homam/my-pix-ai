// White-label brand registry. Everything brand-variable *in copy/config* —
// display name, SEO copy, support email, legal entity, retail credit packs —
// lives here, keyed by NEXT_PUBLIC_BRAND_KEY (see PLATFORM.md: one product,
// many brands; a deployment picks its brand via this env var). The rest of
// the skin lives in three sibling surfaces (see CLAUDE.md "White-label /
// rebranding"): the --color-brand-* tokens in app/globals.css, the logo in
// components/brand/Logo.tsx, and the favicon app/icon.svg. Product economics
// (CREDIT_COSTS) stay in @/types: features belong to the product, so every
// brand charges the same credits — only the $ packs and skin differ.
//
// NEXT_PUBLIC_BRAND_KEY is inlined at build time, so BRAND is safe to import
// from both server and client components.

import type { CreditPack } from "@/types";

/** Brand-scoped auth capability (PLATFORM.md §9 declare/enable/enforce): the login
 * page renders only the declared methods. `password` accounts are owner-provisioned
 * in the Supabase dashboard for now (no self-serve signup). Server-side rejection of
 * non-declared methods is still TODO — hiding a button is not the security boundary. */
export type AuthMethod = "magic_link" | "password";

/** The legal owner of a SET of brands (core.entities on the platform, 2026-07-05).
 * Legal names/ownership come from the entity; user accounts never cross entities
 * (enforced by core.bind_entity in every wallet RPC). Names are TBD — while
 * `legalName` is null, legal copy falls back to the brand display name. */
export interface EntityConfig {
  key: "entity1" | "entity2"; // matches core.entities.key
  legalName: string | null; // registered legal name; TBD
  jurisdiction?: string;
  sinceYear: number;
}

const ENTITIES: Record<"entity1" | "entity2", EntityConfig> = {
  entity1: { key: "entity1", legalName: null, sinceYear: 2026 },
  entity2: { key: "entity2", legalName: null, sinceYear: 2026 },
};

/** Legal block for a brand, derived from its entity (brand name as fallback). */
function entityLegal(key: "entity1" | "entity2", fallbackName: string): BrandLegal {
  const e = ENTITIES[key];
  return { companyName: e.legalName ?? fallbackName, jurisdiction: e.jurisdiction, sinceYear: e.sinceYear };
}

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

/** Brand accent scale — mirrors the `--color-brand-*` tokens in app/globals.css.
 * The root layout injects these over the CSS defaults, and app/icon.tsx renders
 * the favicon from them, so a rebrand needs no CSS/SVG edits. Keep `mypix`'s
 * values identical to the globals.css defaults (its injection is a no-op). */
export interface BrandTheme {
  brand200: string;
  brand300: string;
  brand400: string;
  brand500: string;
  brand600: string;
  brand2_400: string;
  brand2_500: string;
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
  /** Legal owner of this brand; accounts never cross entities. */
  entity: EntityConfig;
  legal: BrandLegal;
  auth: { methods: AuthMethod[] };
  /** Retail credit packs. Stripe price IDs stay per-deployment env vars. */
  packs: CreditPack[];
  theme: BrandTheme;
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
    entity: ENTITIES.entity1,
    legal: entityLegal("entity1", "MyPix AI"),
    auth: { methods: ["magic_link", "password"] },
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
    // Tailwind purple-200…600 + pink-400/500 — identical to the globals.css defaults.
    theme: {
      brand200: "#e9d5ff",
      brand300: "#d8b4fe",
      brand400: "#c084fc",
      brand500: "#a855f7",
      brand600: "#9333ea",
      brand2_400: "#f472b6",
      brand2_500: "#ec4899",
    },
  },
  glowshot: {
    key: "glowshot",
    name: "GlowShot",
    metaTitle: "GlowShot — AI Photos That Glow",
    description:
      "Upload 10–20 photos of yourself and get glowing, photorealistic AI portraits in any setting, outfit, or style.",
    tagline: "Train once. Glow in every shot.",
    productionUrl: "https://pyt65zu7sr.eu-central-1.awsapprunner.com",
    supportEmail: "support@glowshot.app",
    entity: ENTITIES.entity2,
    legal: entityLegal("entity2", "GlowShot"),
    auth: { methods: ["magic_link", "password"] },
    // Same $ packs as mypix at launch; each deployment points at its own
    // STRIPE_PRICE_* env vars, so the Stripe products stay per-brand.
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
    // Tailwind amber-200…600 + rose-400/500 — golden-hour glow.
    theme: {
      brand200: "#fde68a",
      brand300: "#fcd34d",
      brand400: "#fbbf24",
      brand500: "#f59e0b",
      brand600: "#d97706",
      brand2_400: "#fb7185",
      brand2_500: "#f43f5e",
    },
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
