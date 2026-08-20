/**
 * Which runtime env vars the app actually needs — derived where possible.
 *
 * The pack→price mapping is NOT restated here: it is read out of the brand
 * registry (`lib/brand.ts`, the same module the checkout route reads), because it
 * is a product fact and not a test fact. `lib/stripe.ts` does
 * `process.env[pack.priceId]` and throws `Missing env var …` when it is absent, so
 * a brand whose packs name an unset price env ships a /pricing page whose buttons
 * 500. That is the same class of defect as offering a chat model with no provider
 * key: the UI advertises something the deployment cannot do.
 */
import { BRAND } from '@/lib/brand';

export { BRAND };

/**
 * Structural env vars — without any one of these the app cannot serve a single
 * authenticated request, or cannot do the one thing it exists to do.
 *
 * ASTRIA_API_KEY is in this list on purpose: training and generation ARE the
 * product, and `lib/astria.ts` throws at call time rather than at boot, so a
 * deployment missing it looks perfectly healthy until a user spends credits.
 * Stripe / Resend / fal are deliberately NOT here — they are env-gated features
 * that no-op cleanly when unset (`isStripeConfigured`, `isFalConfigured`).
 */
export const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_APP_URL',
  'ASTRIA_API_KEY',
] as const;

/** Feature → the env var that switches it on. Reported, never required. */
export const OPTIONAL_FEATURES: Record<string, string> = {
  'stripe checkout': 'STRIPE_SECRET_KEY',
  'stripe webhooks': 'STRIPE_WEBHOOK_SECRET',
  'resend email': 'RESEND_API_KEY',
  'fal FLUX.2 engine': 'FAL_KEY',
  'astria webhooks': 'ASTRIA_WEBHOOK_SECRET',
};

export interface PackEnvRow {
  packId: string;
  name: string;
  credits: number;
  priceCents: number;
  envKey: string;
  configured: boolean;
}

/** Every retail pack this BRAND advertises, with its price env var and whether it is set. */
export function packEnvMatrix(env: Record<string, string>): PackEnvRow[] {
  return BRAND.packs.map((p) => ({
    packId: p.id,
    name: p.name,
    credits: p.credits,
    priceCents: p.price,
    envKey: p.priceId,
    configured: Boolean((env[p.priceId] ?? '').trim()),
  }));
}

export function stripeEnabled(env: Record<string, string>): boolean {
  return Boolean((env.STRIPE_SECRET_KEY ?? '').trim());
}

/** Packs the /pricing page would render but checkout could not create a session for. */
export function unsellablePacks(env: Record<string, string>): PackEnvRow[] {
  if (!stripeEnabled(env)) return [];
  return packEnvMatrix(env).filter((p) => !p.configured);
}

/** Feature-gated integrations this deployment has switched off. */
export function disabledFeatures(env: Record<string, string>): string[] {
  return Object.entries(OPTIONAL_FEATURES)
    .filter(([, key]) => !(env[key] ?? '').trim())
    .map(([feature, key]) => `${feature} (${key})`);
}
