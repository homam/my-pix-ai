import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getTune } from "@/lib/astria";
import { falTrainingStatus } from "@/lib/fal";
import { addCredits } from "@/lib/credits";
import { ForeignIdentityError, verifyModelIdentity } from "@/lib/identity";
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

  // The row is the caller's; the training job it names may not be. A forged
  // models row (INSERT still writes every column — see lib/identity.ts) naming
  // another user's fal_request_id would have this route fetch THEIR trained
  // LoRA URL and write it onto the caller's row, which is a complete likeness
  // theft with no Astria/fal spend at all. Verify before polling either engine;
  // the branded ids returned here are also what getTune / falTrainingStatus
  // demand, so the check cannot be dropped without a compile error.
  const service = await createServiceClient();
  let identity;
  try {
    identity = await verifyModelIdentity({
      serviceClient: service,
      userId: user.id,
      model: {
        id,
        astria_tune_id: model.astria_tune_id,
        fal_lora_url: model.fal_lora_url ?? null,
        fal_request_id: model.fal_request_id ?? null,
      },
    });
  } catch (err) {
    const foreign = err instanceof ForeignIdentityError;
    console.error("[refresh]", foreign ? "foreign_identity_blocked" : "identity_check_failed", {
      userId: user.id,
      modelId: id,
      ...(foreign ? (err as ForeignIdentityError).info() : { message: String(err) }),
    });
    return NextResponse.json(
      {
        error: foreign
          ? "This model's engine identity does not belong to you."
          : "Could not verify this model's engine identity",
        code: foreign ? "foreign_identity" : "identity_check_failed",
      },
      { status: foreign ? 403 : 500 }
    );
  }

  // FLUX.2 (fal) polling: check the training job; on completion persist the
  // trained LoRA weights URL, on failure refund the training credits.
  if (model.provider === "fal") {
    if (!identity.falRequestId) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }
    try {
      const { status, loraUrl } = await falTrainingStatus(identity.falRequestId);

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

  if (!identity.astriaTuneId) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  try {
    const tune = await getTune(identity.astriaTuneId);
    const isSuccess = !!tune.trained_at;

    // If still training on Astria's side, just report current status
    if (!isSuccess && !tune.expires_at) {
      return NextResponse.json({ status: "training" });
    }

    const newStatus = isSuccess ? "ready" : "failed";

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
