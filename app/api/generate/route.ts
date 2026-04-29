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

const REALISM_PRESETS = ["polished", "natural", "documentary"] as const;
type RealismPreset = (typeof REALISM_PRESETS)[number];

const SEED_MAX = 2 ** 32 - 1;
const ASPECT_RATIOS = ["1:1", "4:5", "2:3", "3:2", "9:16", "16:9"] as const;

const schema = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().min(3).max(2000),
  numImages: z.number().int().min(1).max(8).default(4),
  realism: z.enum(REALISM_PRESETS).default("natural"),
  faceCorrect: z.boolean().default(false),
  superResolution: z.boolean().default(false),
  filmGrain: z.boolean().default(true),
  aspectRatio: z.enum(ASPECT_RATIOS).default("1:1"),
  // null = server-randomized (default). Number = locked seed for reproducibility.
  seed: z.number().int().min(0).max(SEED_MAX).nullable().optional(),
  // When true and numImages > 1, fan out into N parallel single-image
  // generations with far-apart random seeds — gives much more variety.
  variety: z.boolean().default(false),
});

function randomSeed() {
  return Math.floor(Math.random() * SEED_MAX);
}

const REALISM_SUFFIX_DOCUMENTARY =
  "unretouched candid photograph, visible skin pores and texture, " +
  "individual beard hairs, natural skin imperfections, no beauty filter, " +
  "documentary photography, photojournalism";

const REALISM_SUFFIX_NATURAL =
  "natural skin texture, visible skin pores, no beauty filter, candid photograph";

function presetParams(p: RealismPreset) {
  switch (p) {
    case "polished":
      return { cfgScale: 5, realismSuffix: null as string | null };
    case "documentary":
      return { cfgScale: 1.5, realismSuffix: REALISM_SUFFIX_DOCUMENTARY };
    case "natural":
    default:
      return { cfgScale: 3, realismSuffix: REALISM_SUFFIX_NATURAL };
  }
}

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

  const {
    modelId,
    prompt,
    numImages,
    realism,
    faceCorrect,
    superResolution,
    filmGrain,
    aspectRatio,
    seed: seedInput,
    variety,
  } = parsed.data;
  const preset = presetParams(realism);
  log.info("input_validated", {
    userId: user.id,
    modelId,
    numImages,
    realism,
    faceCorrect,
    superResolution,
    filmGrain,
    aspectRatio,
    seed: seedInput ?? null,
    variety,
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
      variety,
    });

    const baseParams = {
      tuneId: model.astria_tune_id,
      prompt,
      faceCorrect,
      superResolution,
      filmGrain,
      cfgScale: preset.cfgScale,
      realismSuffix: preset.realismSuffix,
      aspectRatio,
    };

    // Two paths:
    //  - variety on (numImages > 1): submit N parallel single-image prompts
    //    with distinct random seeds → much more diverse compositions.
    //  - else: one prompt with num_images=N. Faster, less variety per batch.
    //    A locked `seed` is only meaningful in this single-call path.
    const fanOut = variety && numImages > 1;
    type Submission = { seed: number | null; numImages: number };
    const submissionPlan: Submission[] = fanOut
      ? Array.from({ length: numImages }, () => ({
          seed: randomSeed(),
          numImages: 1,
        }))
      : [{ seed: seedInput ?? null, numImages }];

    const submitted = await Promise.all(
      submissionPlan.map((s) =>
        generateImages({
          ...baseParams,
          numImages: s.numImages,
          ...(s.seed != null ? { seed: s.seed } : {}),
        })
      )
    );

    log.info("astria_generate_submitted", {
      userId: user.id,
      modelId,
      tuneId: model.astria_tune_id,
      astriaPromptIds: submitted.map((s) => s.id),
      fanOut,
    });

    const completed = await Promise.all(
      submitted.map((s) => waitForPrompt(model.astria_tune_id, s.id))
    );

    // Pair each image with the prompt it came from + the seed we sent so we
    // can attribute rows correctly when fan-out submitted multiple prompts,
    // and surface the seed in settings for "remix this image" UX.
    const imagePromptPairs = completed.flatMap((p, planIdx) =>
      (p.images ?? []).map((url) => ({
        url,
        astriaPromptId: p.id,
        seed: submissionPlan[planIdx].seed,
      }))
    );
    const allImages = imagePromptPairs.map((pair) => pair.url);

    log.info("astria_prompt_ready", {
      userId: user.id,
      modelId,
      astriaPromptIds: completed.map((p) => p.id),
      imageCount: allImages.length,
    });

    if (allImages.length === 0) {
      log.error("astria_prompt_no_images", {
        userId: user.id,
        modelId,
        astriaPromptIds: completed.map((p) => p.id),
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
      allImages.map(async (sourceUrl, idx) => {
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

    // Mirror lib/astria.ts's prompt assembly so we can persist the exact text
    // that was sent (trigger phrase + user prompt + realism suffix). Avoid
    // exporting from the Astria client to keep that module focused.
    const triggered = `sks ohwx person ${prompt}`;
    const suffix =
      preset.realismSuffix && preset.realismSuffix.length > 0
        ? `, ${preset.realismSuffix}`
        : "";
    const fullPrompt = `${triggered}${suffix}`;

    const imageRows = mirrored.map(({ url, sourceUrl }, idx) => {
      const pair = imagePromptPairs[idx];
      const settings = {
        fullPrompt,
        realism,
        aspectRatio,
        filmGrain,
        faceCorrect,
        superResolution,
        variety,
        cfgScale: preset.cfgScale,
        seed: pair?.seed ?? null,
      };
      return {
        model_id: modelId,
        user_id: user.id,
        prompt,
        url,
        astria_source_url: sourceUrl,
        astria_prompt_id: pair?.astriaPromptId,
        astria_image_id: String(pair?.astriaPromptId),
        settings,
      };
    });

    const { data: inserted, error: insertErr } = await serviceClient
      .from("generated_images")
      .insert(imageRows)
      .select();

    if (insertErr) {
      log.error("generated_images_insert_failed", {
        userId: user.id,
        modelId,
        astriaPromptIds: completed.map((p) => p.id),
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
          astriaPromptIds: completed.map((p) => p.id),
          reqId: log.reqId,
        },
        { status: 500 }
      );
    }

    log.info("generation_complete", {
      userId: user.id,
      modelId,
      astriaPromptIds: completed.map((p) => p.id),
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
