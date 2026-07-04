import { NextRequest, NextResponse } from "next/server";
import { constructWebhookEvent, isStripeConfigured } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { addCredits } from "@/lib/credits";
import { BRAND } from "@/lib/brand";

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Stripe not configured" },
      { status: 503 }
    );
  }

  const payload = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event;
  try {
    event = await constructWebhookEvent(payload, signature);
  } catch (err) {
    console.error("Stripe webhook verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { userId, packId, credits } = session.metadata ?? {};

    if (!userId || !packId || !credits) {
      console.error("Missing metadata in Stripe session:", session.id);
      return NextResponse.json({ ok: true });
    }

    const pack = BRAND.packs.find((p) => p.id === packId);
    if (!pack) {
      console.error("Unknown pack ID:", packId);
      return NextResponse.json({ ok: true });
    }

    // NOTE: uses grant_credits (not the idempotent settle_payment) — matches the original
    // add_credits behavior here (no dedup on Stripe retry either way). Wiring core.credit_packs
    // + settle_payment for real idempotency is a natural next step, not done in this pass.
    const supabase = await createServiceClient();
    await addCredits(supabase, userId, parseInt(credits, 10), session.id, `Purchased ${pack.name} pack (${credits} credits)`);

    console.log(`[stripe-webhook] +${credits} credits for user ${userId}`);
  }

  return NextResponse.json({ ok: true });
}
