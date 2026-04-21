import { NextRequest, NextResponse } from "next/server";
import { constructWebhookEvent } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { CREDIT_PACKS } from "@/types";

export async function POST(req: NextRequest) {
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

    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      console.error("Unknown pack ID:", packId);
      return NextResponse.json({ ok: true });
    }

    const supabase = await createServiceClient();
    await supabase.rpc("add_credits", {
      p_user_id: userId,
      p_amount: parseInt(credits, 10),
      p_stripe_session_id: session.id,
      p_description: `Purchased ${pack.name} pack (${credits} credits)`,
    });

    console.log(`Added ${credits} credits to user ${userId}`);
  }

  return NextResponse.json({ ok: true });
}
