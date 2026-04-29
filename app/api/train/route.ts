import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createTune } from "@/lib/astria";
import { deductCredits } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import { makeLogger, errInfo } from "@/lib/log";
import { z } from "zod";

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

  // Verify model ownership and pending status
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

  log.info("credits_deducted", { userId: user.id, modelId, balance });

  const apiKeyPresent = Boolean(process.env.ASTRIA_API_KEY);
  const publicUrl = process.env.ASTRIA_WEBHOOK_PUBLIC_URL;
  const webhookSecretPresent = Boolean(process.env.ASTRIA_WEBHOOK_SECRET);
  log.info("astria_env", {
    userId: user.id,
    modelId,
    apiKeyPresent,
    publicUrl: publicUrl ?? null,
    webhookSecretPresent,
  });

  if (!apiKeyPresent) {
    log.error("astria_api_key_missing", { userId: user.id, modelId });
    // Refund credits since we never reached Astria
    const serviceClient = await createServiceClient();
    await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.TRAINING,
      p_stripe_session_id: null,
      p_description: `Refund (no API key): ${modelName}`,
    });
    return NextResponse.json(
      {
        error: "Server misconfigured: ASTRIA_API_KEY is not set",
        reqId: log.reqId,
      },
      { status: 500 }
    );
  }

  try {
    const webhookUrl = publicUrl
      ? `${publicUrl}/api/webhooks/astria?secret=${process.env.ASTRIA_WEBHOOK_SECRET}`
      : undefined;

    log.info("astria_create_tune_start", {
      userId: user.id,
      modelId,
      modelName,
      imageCount: imageUrls.length,
      webhookConfigured: Boolean(webhookUrl),
    });

    const tune = await createTune({
      title: modelName,
      imageUrls,
      webhookUrl,
    });

    log.info("astria_create_tune_success", {
      userId: user.id,
      modelId,
      astriaTuneId: tune.id,
    });

    // Update model with Astria tune ID and training status
    const serviceClient = await createServiceClient();
    const { error: updateErr } = await serviceClient
      .from("models")
      .update({
        status: "training",
        astria_tune_id: tune.id,
        name: modelName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", modelId);

    if (updateErr) {
      log.error("model_update_failed", {
        userId: user.id,
        modelId,
        astriaTuneId: tune.id,
        pgCode: updateErr.code,
        pgMessage: updateErr.message,
      });
    }

    const imageRows = imageUrls.map((url) => ({ model_id: modelId, url }));
    const { error: imagesErr } = await serviceClient
      .from("model_images")
      .insert(imageRows);

    if (imagesErr) {
      log.error("model_images_insert_failed", {
        userId: user.id,
        modelId,
        pgCode: imagesErr.code,
        pgMessage: imagesErr.message,
      });
    }

    return NextResponse.json({ tuneId: tune.id, balance, reqId: log.reqId });
  } catch (err) {
    const info = errInfo(err);
    log.error("astria_create_tune_failed", {
      userId: user.id,
      modelId,
      modelName,
      imageCount: imageUrls.length,
      ...info,
    });

    // Refund credits on failure
    const serviceClient = await createServiceClient();
    const { error: refundErr } = await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.TRAINING,
      p_stripe_session_id: null,
      p_description: `Refund for failed training: ${modelName}`,
    });
    if (refundErr) {
      log.error("refund_failed", {
        userId: user.id,
        modelId,
        pgCode: refundErr.code,
        pgMessage: refundErr.message,
      });
    } else {
      log.info("credits_refunded", { userId: user.id, modelId });
    }

    return NextResponse.json(
      {
        error: `Failed to start training: ${info.message}`,
        reqId: log.reqId,
      },
      { status: 500 }
    );
  }
}
