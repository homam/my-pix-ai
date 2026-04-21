import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { CREDIT_COSTS } from "@/types";

// Astria POSTs to this URL when training completes.
// Payload: { tune: AstriaTune } with tune.trained_at set on success.
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");

  if (secret !== process.env.ASTRIA_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const tune = body?.tune ?? body;

  if (!tune?.id) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const supabase = await createServiceClient();

  const { data: model } = await supabase
    .from("models")
    .select("*")
    .eq("astria_tune_id", tune.id)
    .single();

  if (!model) {
    console.warn(`[astria-webhook] No model found for tune ID ${tune.id}`);
    return NextResponse.json({ ok: true });
  }

  const isSuccess = !!tune.trained_at;
  const newStatus = isSuccess ? "ready" : "failed";

  await supabase
    .from("models")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", model.id);

  console.log(
    `[astria-webhook] Model ${model.id} (${model.name}) → ${newStatus}`
  );

  if (!isSuccess) {
    await supabase.rpc("add_credits", {
      p_user_id: model.user_id,
      p_amount: CREDIT_COSTS.TRAINING,
      p_stripe_session_id: null,
      p_description: `Refund for failed training: ${model.name}`,
    });
  }

  return NextResponse.json({ ok: true });
}
