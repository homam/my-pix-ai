import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { generateImages, waitForPrompt } from "@/lib/astria";
import { deductCredits } from "@/lib/credits";
import { mirrorImageToStorage } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";
import { CREDIT_COSTS } from "@/types";
import { z } from "zod";

// Generation takes ~15–40s; allow enough time when deployed to Vercel.
export const maxDuration = 150;

const schema = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().min(3).max(500),
  numImages: z.number().int().min(1).max(8).default(4),
});

export async function POST(req: NextRequest) {
  const log = makeLogger("api/generate");
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

  const { modelId, prompt, numImages } = parsed.data;
  log.info("input_validated", {
    userId: user.id,
    modelId,
    numImages,
    promptPreview: prompt.slice(0, 80),
  });

  // Verify model belongs to user and is ready
  const { data: model, error: modelErr } = await supabase
    .from("models")
    .select("astria_tune_id")
    .eq("id", modelId)
    .eq("user_id", user.id)
    .eq("status", "ready")
    .single();

  if (modelErr || !model?.astria_tune_id) {
    log.warn("model_not_ready", {
      userId: user.id,
      modelId,
      pgCode: modelErr?.code,
      pgMessage: modelErr?.message,
    });
    return NextResponse.json(
      { error: "Model not found or not ready", reqId: log.reqId },
      { status: 404 }
    );
  }

  // Check + deduct credits (1 per image)
  const totalCost = numImages;
  const { data: credits } = await supabase
    .from("user_credits")
    .select("balance")
    .eq("user_id", user.id)
    .single();

  if (!credits || credits.balance < totalCost) {
    log.warn("insufficient_credits", {
      userId: user.id,
      balance: credits?.balance ?? null,
      totalCost,
    });
    return NextResponse.json(
      { error: "Insufficient credits", reqId: log.reqId },
      { status: 402 }
    );
  }

  const { success } = await deductCredits(
    supabase,
    user.id,
    "GENERATION",
    `Generate ${numImages} image(s): ${prompt.slice(0, 50)}`
  );

  if (!success) {
    log.warn("deduct_credits_failed", { userId: user.id, totalCost });
    return NextResponse.json(
      { error: "Insufficient credits", reqId: log.reqId },
      { status: 402 }
    );
  }

  log.info("credits_deducted", { userId: user.id, totalCost });

  const refund = async (reason: string) => {
    const serviceClient = await createServiceClient();
    const { error: refundErr } = await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.GENERATION * numImages,
      p_stripe_session_id: null,
      p_description: `Refund (${reason})`,
    });
    if (refundErr) {
      log.error("refund_failed", {
        userId: user.id,
        reason,
        pgCode: refundErr.code,
        pgMessage: refundErr.message,
      });
    } else {
      log.info("credits_refunded", { userId: user.id, reason });
    }
  };

  try {
    log.info("astria_generate_start", {
      userId: user.id,
      modelId,
      tuneId: model.astria_tune_id,
      numImages,
    });

    const submitted = await generateImages({
      tuneId: model.astria_tune_id,
      prompt,
      numImages,
    });

    log.info("astria_generate_submitted", {
      userId: user.id,
      modelId,
      tuneId: model.astria_tune_id,
      astriaPromptId: submitted.id,
    });

    // Astria renders asynchronously; poll until the images array is populated.
    const astriaPrompt = await waitForPrompt(
      model.astria_tune_id,
      submitted.id
    );

    log.info("astria_prompt_ready", {
      userId: user.id,
      modelId,
      astriaPromptId: astriaPrompt.id,
      imageCount: astriaPrompt.images?.length ?? 0,
    });

    if (!astriaPrompt.images?.length) {
      log.error("astria_prompt_no_images", {
        userId: user.id,
        modelId,
        astriaPromptId: astriaPrompt.id,
      });
      await refund("astria returned no images");
      return NextResponse.json(
        {
          error: "Astria returned no images",
          reqId: log.reqId,
        },
        { status: 502 }
      );
    }

    const serviceClient = await createServiceClient();

    // Mirror each image from Astria to our bucket so we don't rely on
    // Astria URL longevity. If mirroring fails for one image, fall back
    // to the Astria URL for that one — don't lose the whole generation.
    const mirrored = await Promise.all(
      astriaPrompt.images.map(async (sourceUrl, idx) => {
        try {
          const { publicUrl } = await mirrorImageToStorage(
            serviceClient,
            user.id,
            modelId,
            sourceUrl
          );
          return { url: publicUrl, sourceUrl };
        } catch (err) {
          log.error("mirror_failed", {
            userId: user.id,
            modelId,
            idx,
            sourceUrl,
            ...errInfo(err),
          });
          return { url: sourceUrl, sourceUrl };
        }
      })
    );

    const imageRows = mirrored.map(({ url, sourceUrl }) => ({
      model_id: modelId,
      user_id: user.id,
      prompt,
      url,
      astria_source_url: sourceUrl,
      astria_prompt_id: astriaPrompt.id,
      astria_image_id: String(astriaPrompt.id),
    }));

    const { data: inserted, error: insertErr } = await serviceClient
      .from("generated_images")
      .insert(imageRows)
      .select();

    if (insertErr) {
      log.error("generated_images_insert_failed", {
        userId: user.id,
        modelId,
        astriaPromptId: astriaPrompt.id,
        rowCount: imageRows.length,
        pgCode: insertErr.code,
        pgMessage: insertErr.message,
        pgHint: insertErr.hint,
        pgDetails: insertErr.details,
      });
      // Don't refund — Astria already produced images that the user could
      // pull manually via the sync endpoint. Surface a clear error instead.
      return NextResponse.json(
        {
          error: `Failed to save images: ${insertErr.message}`,
          code: insertErr.code,
          astriaPromptId: astriaPrompt.id,
          reqId: log.reqId,
        },
        { status: 500 }
      );
    }

    log.info("generation_complete", {
      userId: user.id,
      modelId,
      astriaPromptId: astriaPrompt.id,
      insertedCount: inserted?.length ?? 0,
    });

    return NextResponse.json({ images: inserted ?? [], reqId: log.reqId });
  } catch (err) {
    const info = errInfo(err);
    log.error("generation_failed", {
      userId: user.id,
      modelId,
      tuneId: model.astria_tune_id,
      ...info,
    });
    await refund("generation_failed");
    return NextResponse.json(
      {
        error: info.message || "Image generation failed",
        reqId: log.reqId,
      },
      { status: 500 }
    );
  }
}
