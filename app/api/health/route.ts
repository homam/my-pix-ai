/**
 * LAYER 1b — runtime dependency self-check: what the CONTAINER can see.
 *
 * `npm run preflight` verifies the platform from a laptop or CI, using THOSE
 * credentials. That says nothing about whether the running image was built and
 * wired correctly: a missing build arg, a stale env var on the App Runner
 * service, or an image pointing at the old Supabase project all produce a
 * perfectly healthy-looking landing page. This endpoint answers the only
 * question that matters after a rollout — "can this process actually reach the
 * things it needs?" — and the deploy gate in scripts/deploy.sh refuses to call a
 * rollout successful until it says yes.
 *
 * It also reports `brand`, which is how the deploy script identifies the live
 * image. Grepping the landing page HTML for the brand NAME was the previous
 * signal and it produced false "ROLLOUT FAILED" alarms twice, because that
 * string travels through copy and markup that change for reasons unrelated to
 * which image is deployed.
 *
 * Never returns secret VALUES; only which names are configured.
 *
 * App Runner's health check is TCP on "/", so a 503 here cannot flap the
 * service — it is read by the deploy gate and by uptime monitors.
 */
import { createServiceClient } from "@/lib/supabase/server";
import { STORAGE_BUCKET } from "@/lib/storage";
import { BRAND } from "@/lib/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Env keys without which the app cannot serve an authenticated request or do
 * the one thing it exists to do. Kept in step with verify/src/env-contract.ts
 * REQUIRED_ENV — Stripe / Resend / fal are env-gated features and stay out.
 */
const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ASTRIA_API_KEY",
] as const;

export async function GET() {
  const checks: Check[] = [];

  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  checks.push({
    name: "env",
    ok: missingEnv.length === 0,
    detail: missingEnv.length ? `not configured: ${missingEnv.join(", ")}` : undefined,
  });

  // Every pack the /pricing page renders resolves its Stripe price through
  // process.env at checkout time; an unset one throws "Missing env var" on click.
  const stripeOn = Boolean(process.env.STRIPE_SECRET_KEY);
  const unsellable = stripeOn
    ? BRAND.packs.filter((p) => !process.env[p.priceId]).map((p) => `${p.id}(${p.priceId})`)
    : [];
  checks.push({
    name: "packs",
    ok: unsellable.length === 0,
    detail: stripeOn
      ? unsellable.length
        ? `advertised but not purchasable: ${unsellable.join(", ")}`
        : `${BRAND.packs.length} packs purchasable`
      : "stripe disabled on this deployment; packs are display-only",
  });

  let admin: Awaited<ReturnType<typeof createServiceClient>> | null = null;
  try {
    admin = await createServiceClient();
  } catch (e) {
    checks.push({ name: "supabase:client", ok: false, detail: String(e) });
  }

  if (admin) {
    // A real query, not a ping: proves the product schema is reachable with
    // these credentials and that this image points at the right project.
    try {
      const { error } = await admin.from("models").select("id", { count: "exact", head: true });
      checks.push({ name: "db:mypix", ok: !error, detail: error?.message });
    } catch (e) {
      checks.push({ name: "db:mypix", ok: false, detail: String(e) });
    }

    // The shared platform half: wallets and the credit ledger cannot exist
    // without a core.brands row for this deployment's brand.
    try {
      const { data, error } = await admin
        .schema("core")
        .from("brands")
        .select("key, product, entity")
        .eq("key", BRAND.key)
        .maybeSingle();
      checks.push({
        name: "db:core",
        ok: !error && Boolean(data),
        detail: error?.message ?? (data ? undefined : `core.brands has no row for "${BRAND.key}"`),
      });
    } catch (e) {
      checks.push({ name: "db:core", ok: false, detail: String(e) });
    }

    // Storage `list` answers 200 [] for a bucket that does not exist, so ask the
    // bucket endpoint instead. This is the check that was missing on 2026-08-19.
    try {
      const { data, error } = await admin.storage.getBucket(STORAGE_BUCKET);
      checks.push({
        name: `storage:${STORAGE_BUCKET}`,
        ok: !error && data?.public === true,
        detail:
          error?.message ??
          (data?.public === true
            ? undefined
            : "bucket exists but is PRIVATE — Astria fetches training photos over unauthenticated public URLs"),
      });
    } catch (e) {
      checks.push({ name: `storage:${STORAGE_BUCKET}`, ok: false, detail: String(e) });
    }
  }

  const ok = checks.every((c) => c.ok);
  return Response.json(
    {
      ok,
      brand: BRAND.key,
      entity: BRAND.entity.key,
      bucket: STORAGE_BUCKET,
      checks,
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
