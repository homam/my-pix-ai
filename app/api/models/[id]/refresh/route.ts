import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getTune } from "@/lib/astria";
import { falTrainingStatus } from "@/lib/fal";
import { addCredits } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";

// Manual refresh: polls the training engine for status. Use as a fallback when
// webhooks aren't reachable (e.g. local dev without ngrok). Handles both the
// Astria (FLUX.1) and fal (FLUX.2) engines.
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

  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  if (model.status === "ready" || model.status === "failed") {
    return NextResponse.json({ status: model.status });
  }

  // FLUX.2 (fal) polling: check the training job; on completion persist the
  // trained LoRA weights URL, on failure refund the training credits.
  if (model.provider === "fal") {
    if (!model.fal_request_id) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }
    try {
      const { status, loraUrl } = await falTrainingStatus(model.fal_request_id);
      const service = await createServiceClient();

      if (status === "COMPLETED" && loraUrl) {
        await service
          .from("models")
          .update({
            status: "ready",
            fal_lora_url: loraUrl,
            updated_at: new Date().toISOString(),
          })
          .eq("id", model.id);
        return NextResponse.json({ status: "ready" });
      }

      if (status === "FAILED") {
        await service
          .from("models")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", model.id);
        await addCredits(service, model.user_id, CREDIT_COSTS.TRAINING, null, `Refund for failed training: ${model.name}`);
        return NextResponse.json({ status: "failed" });
      }

      return NextResponse.json({ status: "training" });
    } catch (err) {
      console.error("fal refresh failed:", err);
      return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
    }
  }

  if (!model.astria_tune_id) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
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
      await addCredits(service, model.user_id, CREDIT_COSTS.TRAINING, null, `Refund for failed training: ${model.name}`);
    }

    return NextResponse.json({ status: newStatus });
  } catch (err) {
    console.error("Refresh failed:", err);
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
