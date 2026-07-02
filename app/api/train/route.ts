import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createTune } from "@/lib/astria";
import { falSubmitTraining, isFalConfigured } from "@/lib/fal";
import { zipStore } from "@/lib/zip";
import { STORAGE_BUCKET, getPublicUrl } from "@/lib/storage";
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

  // ------------------------------------------------------------------
  // FLUX.2 (fal) training path. A model is engine-bound at creation, so we
  // branch on model.provider. fal ingests a single zip of images: fetch each
  // photo, pack a store-method zip, host it in our bucket, then submit. The
  // refresh endpoint polls fal for completion (no webhook needed locally).
  // Astria (FLUX.1) path continues unchanged below.
  // ------------------------------------------------------------------
  if (model.provider === "fal") {
    const serviceClient = await createServiceClient();
    const refundFal = async (reason: string) => {
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

    if (!isFalConfigured()) {
      log.error("fal_key_missing", { userId: user.id, modelId });
      await refundFal("no FAL_KEY");
      return NextResponse.json(
        { error: "Server misconfigured: FAL_KEY is not set", reqId: log.reqId },
        { status: 500 }
      );
    }

    try {
      log.info("fal_zip_start", {
        userId: user.id,
        modelId,
        imageCount: imageUrls.length,
      });
      const entries = await Promise.all(
        imageUrls.map(async (url, i) => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`fetch training image ${i} failed: ${res.status}`);
          }
          const ct = res.headers.get("content-type") ?? "image/jpeg";
          const ext = ct.includes("png")
            ? "png"
            : ct.includes("webp")
              ? "webp"
              : "jpg";
          const data = Buffer.from(await res.arrayBuffer());
          return { name: `${String(i + 1).padStart(3, "0")}.${ext}`, data };
        })
      );
      const zip = zipStore(entries);

      const zipPath = `${user.id}/${modelId}/training.zip`;
      const { error: upErr } = await serviceClient.storage
        .from(STORAGE_BUCKET)
        .upload(zipPath, zip, {
          contentType: "application/zip",
          upsert: true,
        });
      if (upErr) throw new Error(`zip upload failed: ${upErr.message}`);
      const zipUrl = getPublicUrl(serviceClient, zipPath);

      log.info("fal_train_submit", {
        userId: user.id,
        modelId,
        zipBytes: zip.length,
      });
      const { requestId } = await falSubmitTraining({ imageDataUrl: zipUrl });

      const { error: updateErr } = await serviceClient
        .from("models")
        .update({
          status: "training",
          fal_request_id: requestId,
          name: modelName,
          updated_at: new Date().toISOString(),
        })
        .eq("id", modelId);
      if (updateErr) {
        log.error("model_update_failed", {
          userId: user.id,
          modelId,
          requestId,
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
          pgMessage: imagesErr.message,
        });
      }

      log.info("fal_train_started", { userId: user.id, modelId, requestId });
      return NextResponse.json({ requestId, balance, reqId: log.reqId });
    } catch (err) {
      const info = errInfo(err);
      log.error("fal_train_failed", {
        userId: user.id,
        modelId,
        modelName,
        imageCount: imageUrls.length,
        ...info,
      });
      await refundFal("fal training failed");
      return NextResponse.json(
        { error: `Failed to start training: ${info.message}`, reqId: log.reqId },
        { status: 500 }
      );
    }
  }

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
