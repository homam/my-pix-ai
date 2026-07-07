// Image-provider seam. The generate route talks to this interface instead of a
// specific backend, so Astria (default, identity-specialized) and fal (optional,
// FLUX.2) can be selected per request without duplicating the credit/mirror/
// persist plumbing around them.
//
// Astria is and remains the primary provider. fal is only reachable when
// FAL_KEY is set AND the model was trained on fal (see lib/fal.ts identity
// caveat) — otherwise getProvider("fal") throws before any credits are touched.

import { generateImages, waitForPrompt } from "@/lib/astria";
import { falGenerateFlux2, isFalConfigured } from "@/lib/fal";

export type ProviderId = "astria" | "fal";

// The person's identity handles across backends. Astria uses a numeric tune id;
// fal uses a hosted LoRA weights URL. A model may have one or both.
export interface ProviderModel {
  astriaTuneId: number | null;
  falLoraUrl: string | null;
}

// One provider-agnostic render request. The route builds this from validated
// input + the chosen realism preset; each adapter maps it to its own API.
export interface RenderRequest {
  prompt: string; // raw user prompt (trigger token added per-provider)
  numImages: number;
  seed: number | null;
  aspectRatio: string;
  realismSuffix: string | null;
  cfgScale: number;
  filmGrain: boolean;
  faceCorrect: boolean;
  superResolution: boolean;
  faceSwap: boolean;
  inpaintFaces: boolean;
  hiresFix: boolean;
  colorGrading: string | null;
  webhookUrl?: string;
}

export interface RenderedImage {
  sourceUrl: string;
  // Numeric for Astria (its prompt id), string for fal (its request id). The
  // route stores the numeric form in astria_prompt_id and the string form in
  // astria_image_id, leaving astria_prompt_id null for fal rows.
  providerPromptId: string;
  seed: number | null;
}

export interface ImageProvider {
  id: ProviderId;
  /** Submit one render and resolve once the images are ready. */
  render(model: ProviderModel, req: RenderRequest): Promise<RenderedImage[]>;
}

// fal's image_size enum keyed by our aspect-ratio strings. Anything unmapped
// falls back to a square so an odd ratio never hard-fails the request.
const FAL_IMAGE_SIZE: Record<string, string> = {
  "1:1": "square_hd",
  "4:5": "portrait_4_3",
  "2:3": "portrait_4_3",
  "9:16": "portrait_16_9",
  "3:2": "landscape_4_3",
  "16:9": "landscape_16_9",
};

const astriaProvider: ImageProvider = {
  id: "astria",
  async render(model, req) {
    if (!model.astriaTuneId) {
      throw new Error("model has no Astria tune");
    }
    const prompt = await generateImages({
      tuneId: model.astriaTuneId,
      prompt: req.prompt,
      numImages: req.numImages,
      faceCorrect: req.faceCorrect,
      superResolution: req.superResolution,
      filmGrain: req.filmGrain,
      faceSwap: req.faceSwap,
      inpaintFaces: req.inpaintFaces,
      hiresFix: req.hiresFix,
      colorGrading: req.colorGrading,
      cfgScale: req.cfgScale,
      realismSuffix: req.realismSuffix,
      aspectRatio: req.aspectRatio,
      ...(req.seed != null ? { seed: req.seed } : {}),
      ...(req.webhookUrl ? { webhookUrl: req.webhookUrl } : {}),
    });
    const ready = await waitForPrompt(model.astriaTuneId, prompt.id);
    return (ready.images ?? []).map((url) => ({
      sourceUrl: url,
      providerPromptId: String(prompt.id),
      seed: req.seed,
    }));
  },
};

const falProvider: ImageProvider = {
  id: "fal",
  async render(model, req) {
    if (!model.falLoraUrl) {
      // No FLUX.2 LoRA trained on fal for this person yet. Astria-trained
      // weights are not portable — training on fal is a separate step.
      throw new Error(
        "model has no FLUX.2 (fal) LoRA — train this model on fal first"
      );
    }
    const suffix =
      req.realismSuffix && req.realismSuffix.length > 0
        ? `, ${req.realismSuffix}`
        : "";
    const out = await falGenerateFlux2({
      prompt: `${req.prompt}${suffix}`,
      loraUrl: model.falLoraUrl,
      numImages: req.numImages,
      imageSize: FAL_IMAGE_SIZE[req.aspectRatio] ?? "square_hd",
      // NOTE: deliberately NOT passing req.cfgScale as guidance_scale — that is
      // Astria's FLUX.1 CFG scale (realism presets 1.5/3/5) and does not map to
      // fal's FLUX.2 guidance. falGenerateFlux2 applies FAL_GUIDANCE_SCALE (~3.0)
      // and FAL_LORA_SCALE (~1.2), both tuned for face-identity LoRAs.
      ...(req.seed != null ? { seed: req.seed } : {}),
      ...(req.webhookUrl ? { webhookUrl: req.webhookUrl } : {}),
    });
    return out.images.map((url) => ({
      sourceUrl: url,
      providerPromptId: out.requestId,
      seed: out.seed,
    }));
  },
};

/**
 * Resolve a provider by id. Throws (before any credits are deducted) when fal
 * is requested but not configured, so the route surfaces a clean 4xx.
 */
export function getProvider(id: ProviderId): ImageProvider {
  if (id === "fal") {
    if (!isFalConfigured()) {
      throw new Error("FLUX.2 (fal) provider is not enabled on this server");
    }
    return falProvider;
  }
  return astriaProvider;
}
