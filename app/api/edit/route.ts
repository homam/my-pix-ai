import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  editImage,
  waitForPrompt,
  FLUX_BASE_TUNE_ID,
  AstriaTuneExpiredError,
} from "@/lib/astria";
import { deductCredits, addCredits } from "@/lib/credits";
import { mirrorImageToStorage, storagePathFromUrl } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";
import { CREDIT_COSTS, type ImageKind } from "@/types";
import { z } from "zod";

// Edits run through the same Astria render queue as generation (~15–60s
// with super-resolution); allow headroom on Vercel.
export const maxDuration = 150;

const OUTPAINT_ANCHORS = [
  "center",
  "top-left",
  "top-center",
  "top-right",
  "left-center",
  "right-center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

const sourceFields = {
  sourceUrl: z.string().url(),
  // Set when the source is one of our generated_images rows, so the edit
  // links back to it in the gallery.
  sourceImageId: z.string().uuid().optional(),
};

const schema = z.discriminatedUnion("mode", [
  // Put YOUR face into an existing photo. Low denoising keeps the scene;
  // face_swap + inpaint_faces regenerate the face from the trained model.
  z.object({
    mode: z.literal("faceswap"),
    ...sourceFields,
    modelId: z.string().uuid(),
    prompt: z.string().max(500).optional(),
    strength: z.number().min(0.05).max(0.6).default(0.2),
    numImages: z.number().int().min(1).max(4).default(2),
  }),
  // Repaint the white area of a mask: background swap, object removal.
  z.object({
    mode: z.literal("inpaint"),
    ...sourceFields,
    maskUrl: z.string().url(),
    prompt: z.string().min(3).max(2000),
    // When set, the repaint is identity-aware (uses the person's tune).
    modelId: z.string().uuid().optional(),
    strength: z.number().min(0.1).max(1).default(0.85),
    numImages: z.number().int().min(1).max(4).default(2),
  }),
  // Expand the canvas from an anchor toward a bigger target size.
  z.object({
    mode: z.literal("outpaint"),
    ...sourceFields,
    anchor: z.enum(OUTPAINT_ANCHORS).default("center"),
    width: z.number().int().min(512).max(2048),
    height: z.number().int().min(512).max(2048),
    prompt: z.string().max(500).optional(),
  }),
  // Restore (and optionally colorize) an old or damaged photo.
  z.object({
    mode: z.literal("restore"),
    ...sourceFields,
    colorize: z.boolean().default(true),
    strength: z.number().min(0.1).max(0.6).default(0.35),
    numImages: z.number().int().min(1).max(2).default(1),
  }),
  // Generate the user wearing a fine-tuned garment.
  z.object({
    mode: z.literal("tryon"),
    modelId: z.string().uuid(),
    garmentId: z.string().uuid(),
    prompt: z.string().max(500).optional(),
    numImages: z.number().int().min(1).max(4).default(2),
  }),
]);

type EditRequest = z.infer<typeof schema>;

/**
 * Only accept source/mask URLs we can vouch for: our own storage bucket
 * (path must start with the caller's user id) or Astria-hosted outputs.
 */
function isAllowedImageUrl(url: string, userId: string): boolean {
  const path = storagePathFromUrl(url);
  if (path) return path.startsWith(`${userId}/`);
  try {
    const host = new URL(url).hostname;
    return host === "sdbooth2-production.s3.amazonaws.com" || host.endsWith(".astria.ai");
  } catch {
    return false;
  }
}

interface AstriaCall {
  tuneId: number;
  params: Parameters<typeof editImage>[0];
  fullPrompt: string;
  kind: ImageKind;
  numImages: number;
  // Persisted into generated_images.prompt (must be non-empty).
  displayPrompt: string;
  settings: Record<string, unknown>;
}

async function buildCall(
  req: EditRequest,
  userId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<AstriaCall | { error: string; status: number }> {
  // Resolve the user's tune for modes that involve their likeness.
  let userTuneId: number | null = null;
  if ("modelId" in req && req.modelId) {
    const { data: model } = await supabase
      .from("models")
      .select("astria_tune_id")
      .eq("id", req.modelId)
      .eq("user_id", userId)
      .eq("status", "ready")
      .single();
    if (!model?.astria_tune_id) {
      return { error: "Model not found or not ready", status: 404 };
    }
    userTuneId = model.astria_tune_id;
  }

  switch (req.mode) {
    case "faceswap": {
      const text = `sks ohwx person${req.prompt ? ` ${req.prompt}` : ""}`;
      return {
        tuneId: userTuneId!,
        kind: "faceswap",
        numImages: req.numImages,
        fullPrompt: text,
        displayPrompt: req.prompt || "Face swap",
        settings: {
          sourceUrl: req.sourceUrl,
          denoisingStrength: req.strength,
          boostLikeness: true,
        },
        params: {
          tuneId: userTuneId!,
          text,
          inputImageUrl: req.sourceUrl,
          denoisingStrength: req.strength,
          numImages: req.numImages,
          superResolution: true,
          inpaintFaces: true,
          faceSwap: true,
        },
      };
    }

    case "inpaint": {
      const tuneId = userTuneId ?? FLUX_BASE_TUNE_ID;
      const text = userTuneId ? `sks ohwx person ${req.prompt}` : req.prompt;
      return {
        tuneId,
        kind: "inpaint",
        numImages: req.numImages,
        fullPrompt: text,
        displayPrompt: req.prompt,
        settings: {
          sourceUrl: req.sourceUrl,
          maskUrl: req.maskUrl,
          denoisingStrength: req.strength,
        },
        params: {
          tuneId,
          text,
          inputImageUrl: req.sourceUrl,
          maskImageUrl: req.maskUrl,
          denoisingStrength: req.strength,
          numImages: req.numImages,
          superResolution: true,
        },
      };
    }

    case "outpaint": {
      const args =
        `--outpaint ${req.anchor} ` +
        `--outpaint_width ${req.width} --outpaint_height ${req.height}` +
        (req.prompt ? ` --outpaint_prompt ${req.prompt}` : "");
      return {
        tuneId: FLUX_BASE_TUNE_ID,
        kind: "outpaint",
        numImages: 1,
        fullPrompt: args,
        displayPrompt: req.prompt || `Uncrop to ${req.width}×${req.height}`,
        settings: {
          sourceUrl: req.sourceUrl,
          outpaintAnchor: req.anchor,
          outpaintWidth: req.width,
          outpaintHeight: req.height,
        },
        params: {
          tuneId: FLUX_BASE_TUNE_ID,
          text: args,
          inputImageUrl: req.sourceUrl,
          // 0 = extend only; never repaint the original pixels.
          denoisingStrength: 0,
          numImages: 1,
          superResolution: false,
        },
      };
    }

    case "restore": {
      const text =
        "high quality professional restoration of this photograph, sharp focus, " +
        "clean, detailed" +
        (req.colorize
          ? ", colorized with natural realistic colors, accurate skin tones"
          : ", original tones preserved");
      return {
        tuneId: FLUX_BASE_TUNE_ID,
        kind: "restore",
        numImages: req.numImages,
        fullPrompt: text,
        displayPrompt: req.colorize ? "Restore & colorize" : "Restore",
        settings: {
          sourceUrl: req.sourceUrl,
          denoisingStrength: req.strength,
          colorize: req.colorize,
        },
        params: {
          tuneId: FLUX_BASE_TUNE_ID,
          text,
          inputImageUrl: req.sourceUrl,
          denoisingStrength: req.strength,
          numImages: req.numImages,
          superResolution: true,
          faceCorrect: true,
        },
      };
    }

    case "tryon": {
      const { data: garment } = await supabase
        .from("garment_tunes")
        .select("astria_tune_id, title, status")
        .eq("id", req.garmentId)
        .eq("user_id", userId)
        .single();
      if (!garment?.astria_tune_id || garment.status !== "ready") {
        return { error: "Garment not found or not ready", status: 404 };
      }

      const scene =
        req.prompt || "fashion editorial, plain studio background, waist up shot";
      const text =
        `<lora:${userTuneId}:1.0> <faceid:${garment.astria_tune_id}:1> ` +
        `ohwx person wearing the ${garment.title}, ${scene}`;
      return {
        tuneId: FLUX_BASE_TUNE_ID,
        kind: "tryon",
        numImages: req.numImages,
        fullPrompt: text,
        displayPrompt: `Wearing ${garment.title}${req.prompt ? ` — ${req.prompt}` : ""}`,
        settings: { garmentId: req.garmentId },
        params: {
          tuneId: FLUX_BASE_TUNE_ID,
          text,
          numImages: req.numImages,
          // Astria's try-on guide: 9:16 with face refinement on.
          w: 768,
          h: 1280,
          superResolution: true,
          inpaintFaces: true,
        },
      };
    }
  }
}

export async function POST(req: NextRequest) {
  const log = makeLogger("api/edit");
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
      { error: "Invalid request", details: parsed.error.flatten(), reqId: log.reqId },
      { status: 400 }
    );
  }

  const input = parsed.data;

  // Reject source/mask URLs that aren't ours or Astria's.
  const urlsToCheck = [
    "sourceUrl" in input ? input.sourceUrl : null,
    "maskUrl" in input ? input.maskUrl : null,
  ].filter((u): u is string => !!u);
  for (const url of urlsToCheck) {
    if (!isAllowedImageUrl(url, user.id)) {
      log.warn("disallowed_image_url", { userId: user.id, url });
      return NextResponse.json(
        { error: "Image URL not allowed", reqId: log.reqId },
        { status: 400 }
      );
    }
  }

  const built = await buildCall(input, user.id, supabase);
  if ("error" in built) {
    log.warn("build_call_rejected", { userId: user.id, mode: input.mode, ...built });
    return NextResponse.json(
      { error: built.error, reqId: log.reqId },
      { status: built.status }
    );
  }

  // The wallet RPCs are service-role only (see docs/PLATFORM.md §3).
  const serviceClient = await createServiceClient();
  const { success } = await deductCredits(
    serviceClient,
    user.id,
    "GENERATION",
    `Studio ${input.mode}: ${built.displayPrompt.slice(0, 50)}`,
    built.numImages
  );
  if (!success) {
    log.warn("insufficient_credits", { userId: user.id, cost: built.numImages });
    return NextResponse.json(
      { error: "Insufficient credits", reqId: log.reqId },
      { status: 402 }
    );
  }

  const refund = async (reason: string) => {
    try {
      await addCredits(serviceClient, user.id, CREDIT_COSTS.GENERATION * built.numImages, null, `Refund (${reason})`);
      log.info("credits_refunded", { userId: user.id, reason });
    } catch (refundErr) {
      log.error("refund_failed", {
        userId: user.id,
        reason,
        pgMessage: refundErr instanceof Error ? refundErr.message : String(refundErr),
      });
    }
  };

  try {
    log.info("astria_edit_start", {
      userId: user.id,
      mode: input.mode,
      tuneId: built.tuneId,
      numImages: built.numImages,
    });

    const submitted = await editImage(built.params);
    const completed = await waitForPrompt(built.tuneId, submitted.id);
    const images = completed.images ?? [];

    if (images.length === 0) {
      log.error("astria_edit_no_images", { userId: user.id, promptId: submitted.id });
      await refund("astria returned no images");
      return NextResponse.json(
        { error: "Astria returned no images", reqId: log.reqId },
        { status: 502 }
      );
    }

    const serviceClient = await createServiceClient();
    const modelId = "modelId" in input ? (input.modelId ?? null) : null;

    const mirrored = await Promise.all(
      images.map(async (sourceUrl) => {
        try {
          const { publicUrl } = await mirrorImageToStorage(
            serviceClient,
            user.id,
            modelId ?? "studio",
            sourceUrl
          );
          return { url: publicUrl, sourceUrl };
        } catch (err) {
          log.error("mirror_failed", { userId: user.id, sourceUrl, ...errInfo(err) });
          return { url: sourceUrl, sourceUrl };
        }
      })
    );

    const rows = mirrored.map(({ url, sourceUrl }) => ({
      model_id: modelId,
      user_id: user.id,
      prompt: built.displayPrompt,
      url,
      astria_source_url: sourceUrl,
      astria_prompt_id: completed.id,
      astria_image_id: String(completed.id),
      kind: built.kind,
      source_image_id:
        "sourceImageId" in input ? (input.sourceImageId ?? null) : null,
      settings: { fullPrompt: built.fullPrompt, ...built.settings },
    }));

    const { data: inserted, error: insertErr } = await serviceClient
      .from("generated_images")
      .insert(rows)
      .select();

    if (insertErr) {
      log.error("generated_images_insert_failed", {
        userId: user.id,
        mode: input.mode,
        pgCode: insertErr.code,
        pgMessage: insertErr.message,
      });
      return NextResponse.json(
        {
          error: `Failed to save images: ${insertErr.message}`,
          astriaPromptId: completed.id,
          reqId: log.reqId,
        },
        { status: 500 }
      );
    }

    log.info("edit_complete", {
      userId: user.id,
      mode: input.mode,
      insertedCount: inserted?.length ?? 0,
    });
    return NextResponse.json({ images: inserted ?? [], reqId: log.reqId });
  } catch (err) {
    // A tune this edit depends on has expired on Astria's side (~30 days post-
    // training). Depending on the mode that's the person's model (faceswap /
    // identity-aware inpaint) or the try-on garment — the error carries the tune
    // id, so match it to one of the user's models and flag that for retraining.
    if (err instanceof AstriaTuneExpiredError) {
      log.warn("tune_expired", {
        userId: user.id,
        mode: input.mode,
        tuneId: err.tuneId,
      });
      await refund("tune expired");
      let modelExpired = false;
      if (err.tuneId != null) {
        const serviceClient = await createServiceClient();
        const { data: marked, error: markErr } = await serviceClient
          .from("models")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("user_id", user.id)
          .eq("astria_tune_id", err.tuneId)
          .select("id");
        if (markErr) {
          log.error("mark_expired_failed", {
            userId: user.id,
            tuneId: err.tuneId,
            pgMessage: markErr.message,
          });
        }
        modelExpired = !!marked?.length;
      }
      return NextResponse.json(
        {
          error: modelExpired
            ? "The model used here has expired — the image provider stores " +
              "trained models for about 30 days and this one's data was removed. " +
              "Retrain it to continue. Your credits were refunded."
            : "A trained asset this edit relies on has expired and was removed " +
              "by the image provider (kept for about 30 days). Recreate it to " +
              "continue. Your credits were refunded.",
          code: "model_expired",
          tuneId: err.tuneId,
          reqId: log.reqId,
        },
        { status: 409 }
      );
    }

    const info = errInfo(err);
    log.error("edit_failed", { userId: user.id, mode: input.mode, ...info });
    await refund("edit_failed");
    return NextResponse.json(
      { error: info.message || "Edit failed", reqId: log.reqId },
      { status: 500 }
    );
  }
}
