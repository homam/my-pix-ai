import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getTune } from "@/lib/astria";
import { CREDIT_COSTS } from "@/types";

// Manual refresh: polls Astria for tune status. Use as a fallback when
// webhooks aren't reachable (e.g. local dev without ngrok).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: model } = await supabase
    .from("models")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!model?.astria_tune_id) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  if (model.status === "ready" || model.status === "failed") {
    return NextResponse.json({ status: model.status });
  }

  try {
    const tune = await getTune(model.astria_tune_id);
    const isSuccess = !!tune.trained_at;

    // If still training on Astria's side, just report current status
    if (!isSuccess && !tune.expires_at) {
      return NextResponse.json({ status: "training" });
    }

    const newStatus = isSuccess ? "ready" : "failed";
    const service = await createServiceClient();

    await service
      .from("models")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", model.id);

    if (!isSuccess) {
      await service.rpc("add_credits", {
        p_user_id: model.user_id,
        p_amount: CREDIT_COSTS.TRAINING,
        p_stripe_session_id: null,
        p_description: `Refund for failed training: ${model.name}`,
      });
    }

    return NextResponse.json({ status: newStatus });
  } catch (err) {
    console.error("Refresh failed:", err);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
