import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "@/lib/providers";
import { AstriaTuneExpiredError } from "@/lib/astria";
import { deductCredits, addCredits } from "@/lib/credits";
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
// Astria's film-emulation enum for color_grading.
const COLOR_GRADINGS = ["Film Velvia", "Film Portra", "Ektar"] as const;

const schema = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().min(3).max(2000),
  numImages: z.number().int().min(1).max(8).default(4),
  realism: z.enum(REALISM_PRESETS).default("natural"),
  faceCorrect: z.boolean().default(false),
  superResolution: z.boolean().default(false),
  filmGrain: z.boolean().default(true),
  // Identity/quality flags (Astria). inpaintFaces/hiresFix imply super_resolution.
  faceSwap: z.boolean().default(false),
  inpaintFaces: z.boolean().default(false),
  hiresFix: z.boolean().default(false),
  // null = use the realism preset's default grade; a value overrides it.
  colorGrading: z.enum(COLOR_GRADINGS).nullable().default(null),
  aspectRatio: z.enum(ASPECT_RATIOS).default("1:1"),
  // null = server-randomized (default). Number = locked seed for reproducibility.
  seed: z.number().int().min(0).max(SEED_MAX).nullable().optional(),
  // When true and numImages > 1, fan out into N parallel single-image
  // generations with far-apart random seeds — gives much more variety.
  variety: z.boolean().default(false),
  // Convenience toggle (studio UI): re-injects training images at render time,
  // mapping to face_swap + inpaint_faces for stronger likeness. Slower per image.
  boostLikeness: z.boolean().default(false),
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

function presetParams(p: RealismPreset): {
  cfgScale: number;
  realismSuffix: string | null;
  colorGrading: string | null;
} {
  switch (p) {
    case "polished":
      // color_grading is left null until the enum ("Film Portra" etc.) is
      // verified against a live generation — a wrong value 422s the request.
      // Opt in per-request or via ASTRIA_COLOR_GRADING once confirmed.
      return { cfgScale: 5, realismSuffix: null, colorGrading: null };
    case "documentary":
      return {
        cfgScale: 1.5,
        realismSuffix: REALISM_SUFFIX_DOCUMENTARY,
        colorGrading: null,
      };
    case "natural":
    default:
      return {
        cfgScale: 3,
        realismSuffix: REALISM_SUFFIX_NATURAL,
        colorGrading: null,
      };
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
    faceSwap,
    inpaintFaces,
    hiresFix,
    colorGrading,
    aspectRatio,
    seed: seedInput,
    variety,
    boostLikeness,
  } = parsed.data;
  const preset = presetParams(realism);
  const effectiveColorGrading = colorGrading ?? preset.colorGrading;
  // boostLikeness (studio's one-click) turns on both identity passes; the
  // granular flags can also enable them individually. Polished additionally
  // gets the hires-fix detail pass.
  const effFaceSwap = faceSwap || boostLikeness;
  const effInpaintFaces = inpaintFaces || boostLikeness;
  const effHiresFix = hiresFix || realism === "polished";

  // Verify model belongs to user and is ready. select("*") tolerates an
  // un-migrated DB (provider / fal_lora_url just come back undefined → astria),
  // so the default FLUX.1 path keeps working before migration 002 is applied.
  const { data: modelRaw, error: modelErr } = await supabase
    .from("models")
    .select("*")
    .eq("id", modelId)
    .eq("user_id", user.id)
    .eq("status", "ready")
    .single();
  const model = modelRaw as unknown as {
    provider?: "astria" | "fal" | null;
    astria_tune_id: number | null;
    fal_lora_url?: string | null;
  } | null;

  // A model is bound to one engine at training time — render on that engine.
  const provider: "astria" | "fal" = model?.provider === "fal" ? "fal" : "astria";

  log.info("input_validated", {
    userId: user.id,
    modelId,
    provider,
    numImages,
    realism,
    faceCorrect,
    superResolution,
    filmGrain,
    boostLikeness,
    faceSwap: effFaceSwap,
    inpaintFaces: effInpaintFaces,
    hiresFix: effHiresFix,
    colorGrading: effectiveColorGrading,
    aspectRatio,
    seed: seedInput ?? null,
    variety,
    promptPreview: prompt.slice(0, 80),
  });

  // Each engine needs its own identity handle: Astria a tune id, fal a LoRA.
  const identityMissing =
    provider === "fal" ? !model?.fal_lora_url : !model?.astria_tune_id;
  if (modelErr || !model || identityMissing) {
    log.warn("model_not_ready", {
      userId: user.id,
      modelId,
      provider,
      pgCode: modelErr?.code,
      pgMessage: modelErr?.message,
    });
    return NextResponse.json(
      {
        error:
          provider === "fal" && model && !model.fal_lora_url
            ? "This model has no FLUX.2 version yet — training may still be running"
            : "Model not found or not ready",
        reqId: log.reqId,
      },
      { status: 404 }
    );
  }

  // Resolve the engine client before touching credits so a misconfigured engine
  // (e.g. FAL_KEY removed after training) returns a clean 4xx and never charges.
  let providerImpl;
  try {
    providerImpl = getProvider(provider);
  } catch (err) {
    log.warn("provider_unavailable", { userId: user.id, provider, ...errInfo(err) });
    return NextResponse.json(
      { error: errInfo(err).message || "Selected engine is unavailable", reqId: log.reqId },
      { status: 400 }
    );
  }

  // Deduct credits (1 per image). deductCredits itself checks the balance atomically —
  // no separate pre-check query needed. The wallet RPCs are service-role only (see
  // docs/PLATFORM.md §3), so this goes through the service client, not the user-session one.
  const totalCost = numImages;
  const serviceClient = await createServiceClient();
  const { success } = await deductCredits(
    serviceClient,
    user.id,
    "GENERATION",
    `Generate ${numImages} image(s): ${prompt.slice(0, 50)}`,
    numImages
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
    try {
      await addCredits(serviceClient, user.id, CREDIT_COSTS.GENERATION * numImages, null, `Refund (${reason})`);
      log.info("credits_refunded", { userId: user.id, reason });
    } catch (refundErr) {
      log.error("refund_failed", {
        userId: user.id,
        reason,
        pgMessage: refundErr instanceof Error ? refundErr.message : String(refundErr),
      });
    }
  };

  const providerModel = {
    astriaTuneId: model.astria_tune_id ?? null,
    falLoraUrl: model.fal_lora_url ?? null,
  };

  try {
    log.info("generate_start", {
      userId: user.id,
      modelId,
      provider,
      tuneId: model.astria_tune_id,
      numImages,
      variety,
    });

    // Two paths:
    //  - variety on (numImages > 1): submit N parallel single-image renders
    //    with distinct random seeds → much more diverse compositions.
    //  - else: one render with num_images=N. Faster, less variety per batch.
    //    A locked `seed` is only meaningful in this single-call path.
    const fanOut = variety && numImages > 1;
    type Submission = { seed: number | null; numImages: number };
    const submissionPlan: Submission[] = fanOut
      ? Array.from({ length: numImages }, () => ({
          seed: randomSeed(),
          numImages: 1,
        }))
      : [{ seed: seedInput ?? null, numImages }];

    // Each render() submits and waits, returning normalized images with the
    // provider's prompt/request id and the seed used, so fan-out attribution
    // and "remix this image" UX work identically across backends.
    const rendered = (
      await Promise.all(
        submissionPlan.map((s) =>
          providerImpl.render(providerModel, {
            prompt,
            numImages: s.numImages,
            seed: s.seed,
            aspectRatio,
            realismSuffix: preset.realismSuffix,
            cfgScale: preset.cfgScale,
            filmGrain,
            faceCorrect,
            superResolution,
            faceSwap: effFaceSwap,
            inpaintFaces: effInpaintFaces,
            hiresFix: effHiresFix,
            colorGrading: effectiveColorGrading,
          })
        )
      )
    ).flat();

    const providerPromptIds = [
      ...new Set(rendered.map((r) => r.providerPromptId)),
    ];
    const allImages = rendered.map((r) => r.sourceUrl);

    log.info("generate_rendered", {
      userId: user.id,
      modelId,
      provider,
      providerPromptIds,
      imageCount: allImages.length,
      fanOut,
    });

    if (allImages.length === 0) {
      log.error("generate_no_images", {
        userId: user.id,
        modelId,
        provider,
        providerPromptIds,
      });
      await refund("provider returned no images");
      return NextResponse.json(
        {
          error: "Image provider returned no images",
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

    // Reconstruct the text that was sent so we can persist it for debugging.
    // Astria auto-prepends its trigger phrase; fal uses the raw prompt.
    const triggered =
      provider === "astria" ? `sks ohwx person ${prompt}` : prompt;
    const suffix =
      preset.realismSuffix && preset.realismSuffix.length > 0
        ? `, ${preset.realismSuffix}`
        : "";
    const fullPrompt = `${triggered}${suffix}`;

    const imageRows = mirrored.map(({ url, sourceUrl }, idx) => {
      const r = rendered[idx];
      const settings = {
        fullPrompt,
        provider,
        realism,
        aspectRatio,
        filmGrain,
        faceCorrect,
        superResolution,
        faceSwap: effFaceSwap,
        inpaintFaces: effInpaintFaces,
        hiresFix: effHiresFix,
        colorGrading: effectiveColorGrading,
        variety,
        boostLikeness,
        cfgScale: preset.cfgScale,
        seed: r?.seed ?? null,
      };
      // astria_prompt_id is an integer column — only Astria has a numeric id;
      // fal's request id lives in astria_image_id (text) with prompt_id null.
      const numericPromptId =
        provider === "astria" && r ? Number(r.providerPromptId) : null;
      return {
        model_id: modelId,
        user_id: user.id,
        prompt,
        url,
        astria_source_url: sourceUrl,
        astria_prompt_id: numericPromptId,
        astria_image_id: r?.providerPromptId ?? null,
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
        providerPromptIds,
        rowCount: imageRows.length,
        pgCode: insertErr.code,
        pgMessage: insertErr.message,
        pgHint: insertErr.hint,
        pgDetails: insertErr.details,
      });
      // Don't refund — the provider already produced images that the user could
      // pull manually via the sync endpoint. Surface a clear error instead.
      return NextResponse.json(
        {
          error: `Failed to save images: ${insertErr.message}`,
          code: insertErr.code,
          providerPromptIds,
          reqId: log.reqId,
        },
        { status: 500 }
      );
    }

    log.info("generation_complete", {
      userId: user.id,
      modelId,
      providerPromptIds,
      insertedCount: inserted?.length ?? 0,
    });

    return NextResponse.json({ images: inserted ?? [], reqId: log.reqId });
  } catch (err) {
    // Astria deleted this model's trained tune (~30 days post-training). Refund,
    // flag the model so the UI prompts a retrain and we stop burning credits on
    // a dead tune, and return a clear 409 instead of a raw provider error.
    if (err instanceof AstriaTuneExpiredError) {
      log.warn("model_expired", {
        userId: user.id,
        modelId,
        tuneId: err.tuneId ?? model.astria_tune_id,
      });
      await refund("model expired");
      const serviceClient = await createServiceClient();
      // Best-effort: tolerate an un-migrated DB where 'expired' isn't yet a
      // valid status — the refund + message below still stand.
      const { error: markErr } = await serviceClient
        .from("models")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", modelId);
      if (markErr) {
        log.error("mark_expired_failed", {
          userId: user.id,
          modelId,
          pgMessage: markErr.message,
        });
      }
      return NextResponse.json(
        {
          error:
            "This model has expired — the image provider stores trained models " +
            "for about 30 days and this one's data was removed. Retrain it from " +
            "your uploaded photos to generate again. Your credits for this " +
            "request were refunded.",
          code: "model_expired",
          modelId,
          reqId: log.reqId,
        },
        { status: 409 }
      );
    }

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
