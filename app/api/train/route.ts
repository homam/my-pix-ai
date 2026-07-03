import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { kickoffTraining } from "@/lib/training";
import { isFalConfigured } from "@/lib/fal";
import { deductCredits } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import { makeLogger, errInfo } from "@/lib/log";
import { z } from "zod";

// fal training zips + uploads all photos server-side before submitting, so give
// it headroom beyond the quick Astria createTune call.
export const maxDuration = 300;

const schema = z.object({
  modelId: z.string().uuid(),
  imageUrls: z.array(z.string().url()).min(10).max(40),
  modelName: z.string().min(1).max(60),
});

export async function POST(req: NextRequest) {
  const log = makeLogger("api/train");
  log.info("request_received");

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    log.warn("unauthorized", { authErr: authErr?.message });
    return NextResponse.json(
      { error: "Unauthorized", reqId: log.reqId },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    log.error("body_parse_failed", errInfo(err));
    return NextResponse.json(
      { error: "Invalid JSON body", reqId: log.reqId },
      { status: 400 }
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.warn("validation_failed", {
      userId: user.id,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json(
      {
        error: "Invalid request",
        details: parsed.error.flatten(),
        reqId: log.reqId,
      },
      { status: 400 }
    );
  }

  const { modelId, imageUrls, modelName } = parsed.data;
  log.info("input_validated", {
    userId: user.id,
    modelId,
    modelName,
    imageCount: imageUrls.length,
  });

  // Verify model ownership and pending status (first training only — retrain
  // goes through /api/models/[id]/retry).
  const { data: model, error: modelErr } = await supabase
    .from("models")
    .select("*")
    .eq("id", modelId)
    .eq("user_id", user.id)
    .eq("status", "pending")
    .single();

  if (modelErr || !model) {
    log.warn("model_not_pending", {
      userId: user.id,
      modelId,
      pgCode: modelErr?.code,
      pgMessage: modelErr?.message,
    });
    return NextResponse.json(
      {
        error: "Model not found or not in pending state",
        reqId: log.reqId,
      },
      { status: 404 }
    );
  }

  // A model is engine-bound at creation; train on that engine.
  const provider: "astria" | "fal" = model.provider === "fal" ? "fal" : "astria";

  // Deduct credits
  const { success, balance } = await deductCredits(
    supabase,
    user.id,
    "TRAINING",
    `Train model: ${modelName}`
  );

  if (!success) {
    log.warn("insufficient_credits", { userId: user.id, modelId, balance });
    return NextResponse.json(
      { error: "Insufficient credits", reqId: log.reqId },
      { status: 402 }
    );
  }

  log.info("credits_deducted", { userId: user.id, modelId, balance, provider });

  const serviceClient = await createServiceClient();
  const refund = async (reason: string) => {
    const { error: refundErr } = await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.TRAINING,
      p_stripe_session_id: null,
      p_description: `Refund (${reason}): ${modelName}`,
    });
    if (refundErr) {
      log.error("refund_failed", {
        userId: user.id,
        modelId,
        reason,
        pgMessage: refundErr.message,
      });
    } else {
      log.info("credits_refunded", { userId: user.id, modelId, reason });
    }
  };

  // Guard the engine config before hitting any provider API so we refund cleanly.
  if (provider === "fal" && !isFalConfigured()) {
    log.error("fal_key_missing", { userId: user.id, modelId });
    await refund("no FAL_KEY");
    return NextResponse.json(
      { error: "Server misconfigured: FAL_KEY is not set", reqId: log.reqId },
      { status: 500 }
    );
  }
  if (provider === "astria" && !process.env.ASTRIA_API_KEY) {
    log.error("astria_api_key_missing", { userId: user.id, modelId });
    await refund("no API key");
    return NextResponse.json(
      { error: "Server misconfigured: ASTRIA_API_KEY is not set", reqId: log.reqId },
      { status: 500 }
    );
  }

  try {
    const result = await kickoffTraining({
      provider,
      previousProvider: provider, // fresh model — no engine switch
      modelId,
      userId: user.id,
      modelName,
      imageUrls,
      serviceClient,
      log,
    });
    log.info("train_started", { userId: user.id, modelId, provider });
    return NextResponse.json({ ...result, balance, reqId: log.reqId });
  } catch (err) {
    const info = errInfo(err);
    log.error("train_failed", {
      userId: user.id,
      modelId,
      modelName,
      provider,
      imageCount: imageUrls.length,
      ...info,
    });
    await refund("training failed");
    return NextResponse.json(
      { error: `Failed to start training: ${info.message}`, reqId: log.reqId },
      { status: 500 }
    );
  }
}
