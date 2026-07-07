import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { kickoffTraining, type TrainProvider } from "@/lib/training";
import { isFalConfigured } from "@/lib/fal";
import { deductCredits, addCredits } from "@/lib/credits";
import { listModelImages, storagePathFromUrl, STORAGE_BUCKET } from "@/lib/storage";
import { CREDIT_COSTS, Model } from "@/types";
import { makeLogger, errInfo } from "@/lib/log";
import {
  DEFAULT_QUALITY,
  resolveSteps,
  clampSteps,
  STEPS_MIN,
  STEPS_MAX,
} from "@/lib/trainingPresets";
import { z } from "zod";

// Retrain can zip + upload photos server-side (fal) and calls a provider, so
// give it the same headroom as first-time training.
export const maxDuration = 300;

const schema = z.object({
  // Engine to (re)train on. Omitted = keep the model's current engine.
  provider: z.enum(["astria", "fal"]).optional(),
  // New photo set to train on. Omitted = reuse the model's stored photos.
  imageUrls: z.array(z.string().url()).min(10).max(40).optional(),
  // Training-quality preset; resolved to a per-engine step count server-side.
  quality: z.enum(["fast", "balanced", "max"]).optional(),
  // Advanced custom step override (clamped server-side); wins over `quality`.
  steps: z.number().int().min(STEPS_MIN).max(STEPS_MAX).optional(),
});

/**
 * Retrain an existing model. Covers every case the UI offers:
 *  - recover a failed/expired model (reuse stored photos, same engine)
 *  - re-roll a ready model (reuse stored photos → a fresh tune)
 *  - refresh with new photos (imageUrls provided)
 *  - switch engine (provider provided; Standard ↔ Ultra)
 * Reuses the same kickoffTraining core as first-time training.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const log = makeLogger("api/models/[id]/retry");
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized", reqId: log.reqId },
      { status: 401 }
    );
  }

  // Tolerate an empty body — the one-click card retrain posts nothing, meaning
  // "reuse stored photos, same engine".
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.warn("validation_failed", { userId: user.id, issues: parsed.error.flatten() });
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten(), reqId: log.reqId },
      { status: 400 }
    );
  }
  const { provider: providerOverride, imageUrls: newImageUrls } = parsed.data;

  const { data: modelRow } = await supabase
    .from("models")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    // ready = re-roll / switch engine; failed|expired = recover; pending = start.
    .in("status", ["pending", "failed", "expired", "ready"])
    .single();

  if (!modelRow) {
    return NextResponse.json(
      { error: "Model not found or not retrainable", reqId: log.reqId },
      { status: 404 }
    );
  }
  const model = modelRow as Model;

  const previousProvider: TrainProvider = model.provider === "fal" ? "fal" : "astria";
  const provider: TrainProvider = providerOverride ?? previousProvider;

  // Resolve training steps for the target engine: explicit Advanced value
  // (clamped) wins, else the quality preset (null = engine's own default).
  const quality = parsed.data.quality ?? DEFAULT_QUALITY;
  const steps =
    parsed.data.steps != null
      ? clampSteps(parsed.data.steps)
      : resolveSteps(quality, provider);

  // Guard engine availability before touching credits.
  if (provider === "fal" && !isFalConfigured()) {
    return NextResponse.json(
      { error: "The Ultra engine is not available on this server", reqId: log.reqId },
      { status: 400 }
    );
  }
  if (provider === "astria" && !process.env.ASTRIA_API_KEY) {
    return NextResponse.json(
      { error: "Server misconfigured: ASTRIA_API_KEY is not set", reqId: log.reqId },
      { status: 500 }
    );
  }

  // Resolve the photos: new set (must live in this user's own storage tree) or
  // the model's existing stored photos.
  let imageUrls: string[];
  if (newImageUrls && newImageUrls.length > 0) {
    const bad = newImageUrls.find((u) => {
      const path = storagePathFromUrl(u);
      return !path || !path.startsWith(`${user.id}/`);
    });
    if (bad) {
      log.warn("disallowed_image_url", { userId: user.id, url: bad });
      return NextResponse.json(
        { error: "Image URL not allowed", reqId: log.reqId },
        { status: 400 }
      );
    }
    imageUrls = newImageUrls;
  } else {
    imageUrls = await listModelImages(supabase, user.id, id);
  }

  if (imageUrls.length < 10) {
    return NextResponse.json(
      {
        error:
          newImageUrls
            ? `Only ${imageUrls.length} photos provided; need at least 10.`
            : `Only ${imageUrls.length} stored photos found; need at least 10. Upload new photos to retrain.`,
        reqId: log.reqId,
      },
      { status: 400 }
    );
  }

  log.info("retrain_input", {
    userId: user.id,
    modelId: id,
    fromProvider: previousProvider,
    toProvider: provider,
    switching: provider !== previousProvider,
    newPhotos: Boolean(newImageUrls),
    imageCount: imageUrls.length,
    fromStatus: model.status,
    quality,
    steps,
  });

  // The wallet RPCs are service-role only (see docs/PLATFORM.md §3).
  const serviceClient = await createServiceClient();
  const { success, balance } = await deductCredits(
    serviceClient,
    user.id,
    "TRAINING",
    `Retrain model: ${model.name}`
  );
  if (!success) {
    return NextResponse.json(
      { error: "Insufficient credits", reqId: log.reqId },
      { status: 402 }
    );
  }

  const refund = async (reason: string) => {
    try {
      await addCredits(serviceClient, user.id, CREDIT_COSTS.TRAINING, null, `Refund (${reason}): ${model.name}`);
      log.info("credits_refunded", { userId: user.id, modelId: id, reason });
    } catch (refundErr) {
      log.error("refund_failed", {
        userId: user.id,
        modelId: id,
        reason,
        pgMessage: refundErr instanceof Error ? refundErr.message : String(refundErr),
      });
    }
  };

  try {
    const result = await kickoffTraining({
      provider,
      previousProvider,
      modelId: id,
      userId: user.id,
      modelName: model.name,
      imageUrls,
      steps,
      serviceClient,
      log,
    });
    // New photos replace the set: drop the model's previous stored photos
    // (keeping the just-uploaded ones) so a later "reuse current photos"
    // retrain trains on the new set only. Best-effort — never fail over it.
    if (newImageUrls && newImageUrls.length > 0) {
      try {
        const keep = new Set(
          newImageUrls
            .map((u) => storagePathFromUrl(u))
            .filter((p): p is string => !!p)
        );
        const prefix = `${user.id}/${id}`;
        const { data: entries } = await serviceClient.storage
          .from(STORAGE_BUCKET)
          .list(prefix, { limit: 1000 });
        const toRemove = (entries ?? [])
          .filter((e) => e.id && e.name && /\.(jpe?g|png|webp)$/i.test(e.name))
          .map((e) => `${prefix}/${e.name}`)
          .filter((p) => !keep.has(p));
        if (toRemove.length > 0) {
          await serviceClient.storage.from(STORAGE_BUCKET).remove(toRemove);
          log.info("retrain_old_photos_removed", {
            userId: user.id,
            modelId: id,
            removed: toRemove.length,
          });
        }
      } catch (err) {
        log.warn("retrain_photo_cleanup_failed", {
          userId: user.id,
          modelId: id,
          ...errInfo(err),
        });
      }
    }

    log.info("retrain_started", { userId: user.id, modelId: id, provider });
    return NextResponse.json({ ...result, provider, balance, reqId: log.reqId });
  } catch (err) {
    const info = errInfo(err);
    log.error("retrain_failed", { userId: user.id, modelId: id, provider, ...info });
    await refund("retrain failed");
    return NextResponse.json(
      { error: `Failed to start retraining: ${info.message}`, reqId: log.reqId },
      { status: 500 }
    );
  }
}
