// Shared training kickoff — the single place that turns a set of photos into a
// running training job on the model's chosen engine, then flips the model row to
// `training`. Used by both /api/train (first training of a new model) and
// /api/models/[id]/retry (retrain / re-roll / switch engine). Keeping it in one
// place means the fal zip flow and the Astria tune flow have exactly one
// implementation each.
//
// It does NOT touch credits — callers deduct before and refund if this throws.

import { SupabaseClient } from "@supabase/supabase-js";
import { createTune } from "@/lib/astria";
import { falSubmitTraining, isFalConfigured } from "@/lib/fal";
import { zipStore } from "@/lib/zip";
import { STORAGE_BUCKET, getPublicUrl } from "@/lib/storage";
import type { Logger } from "@/lib/log";

export type TrainProvider = "astria" | "fal";

export interface KickoffTrainingArgs {
  // Engine to train on now.
  provider: TrainProvider;
  // Engine the model was on before this run. Equal to `provider` for a fresh
  // model; when they differ we're switching engines and clear the other
  // engine's identity fields so generation never uses stale weights.
  previousProvider: TrainProvider;
  modelId: string;
  userId: string;
  modelName: string;
  imageUrls: string[];
  // Service-role client — writes models + model_images and (fal) the zip.
  serviceClient: SupabaseClient;
  log: Logger;
}

export interface KickoffTrainingResult {
  astriaTuneId?: number;
  falRequestId?: string;
}

/**
 * Starts training on `provider`, updates the model row to `training` with the
 * right identity handle, and replaces its model_images. Throws on failure
 * (before the model row is flipped, so a failed kickoff leaves prior state
 * intact and the caller can refund).
 */
export async function kickoffTraining(
  args: KickoffTrainingArgs
): Promise<KickoffTrainingResult> {
  const {
    provider,
    previousProvider,
    modelId,
    userId,
    modelName,
    imageUrls,
    serviceClient,
    log,
  } = args;
  const switching = provider !== previousProvider;

  if (provider === "fal") {
    if (!isFalConfigured()) {
      throw new Error("Server misconfigured: FAL_KEY is not set");
    }

    // fal ingests a single zip, not loose URLs: fetch every photo, pack a
    // store-method zip (no compression dependency), host it in our bucket.
    log.info("fal_zip_start", { userId, modelId, imageCount: imageUrls.length });
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

    const zipPath = `${userId}/${modelId}/training.zip`;
    const { error: upErr } = await serviceClient.storage
      .from(STORAGE_BUCKET)
      .upload(zipPath, zip, { contentType: "application/zip", upsert: true });
    if (upErr) throw new Error(`zip upload failed: ${upErr.message}`);
    const zipUrl = getPublicUrl(serviceClient, zipPath);

    log.info("fal_train_submit", { userId, modelId, zipBytes: zip.length });
    const { requestId } = await falSubmitTraining({ imageDataUrl: zipUrl });

    const { error: updateErr } = await serviceClient
      .from("models")
      .update({
        status: "training",
        fal_request_id: requestId,
        // Clear any stale trained LoRA so generation can't use it mid-retrain.
        fal_lora_url: null,
        name: modelName,
        updated_at: new Date().toISOString(),
        // Only rewrite provider / cross-engine fields when actually switching,
        // so a pre-provider-migration DB path is never touched needlessly.
        ...(switching ? { provider: "fal", astria_tune_id: null } : {}),
      })
      .eq("id", modelId);
    if (updateErr) {
      log.error("model_update_failed", {
        userId,
        modelId,
        requestId,
        pgMessage: updateErr.message,
      });
    }

    await replaceModelImages(serviceClient, modelId, imageUrls, userId, log);
    log.info("fal_train_started", { userId, modelId, requestId, switching });
    return { falRequestId: requestId };
  }

  // ---- Astria (FLUX.1) ----
  const publicUrl = process.env.ASTRIA_WEBHOOK_PUBLIC_URL;
  const webhookUrl = publicUrl
    ? `${publicUrl}/api/webhooks/astria?secret=${process.env.ASTRIA_WEBHOOK_SECRET}`
    : undefined;

  log.info("astria_create_tune_start", {
    userId,
    modelId,
    modelName,
    imageCount: imageUrls.length,
    webhookConfigured: Boolean(webhookUrl),
  });
  const tune = await createTune({ title: modelName, imageUrls, webhookUrl });
  log.info("astria_create_tune_success", { userId, modelId, astriaTuneId: tune.id });

  const { error: updateErr } = await serviceClient
    .from("models")
    .update({
      status: "training",
      astria_tune_id: tune.id,
      name: modelName,
      updated_at: new Date().toISOString(),
      ...(switching
        ? { provider: "astria", fal_lora_url: null, fal_request_id: null }
        : {}),
    })
    .eq("id", modelId);
  if (updateErr) {
    log.error("model_update_failed", {
      userId,
      modelId,
      astriaTuneId: tune.id,
      pgMessage: updateErr.message,
    });
  }

  await replaceModelImages(serviceClient, modelId, imageUrls, userId, log);
  return { astriaTuneId: tune.id };
}

// model_images mirrors the photo set a model was trained on. Replace it wholesale
// so a retrain with a new set doesn't leave stale rows (delete is a no-op for a
// fresh model).
async function replaceModelImages(
  serviceClient: SupabaseClient,
  modelId: string,
  imageUrls: string[],
  userId: string,
  log: Logger
): Promise<void> {
  await serviceClient.from("model_images").delete().eq("model_id", modelId);
  const { error } = await serviceClient
    .from("model_images")
    .insert(imageUrls.map((url) => ({ model_id: modelId, url })));
  if (error) {
    log.error("model_images_insert_failed", {
      userId,
      modelId,
      pgMessage: error.message,
    });
  }
}
