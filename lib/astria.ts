import type { AstriaTune, AstriaPrompt } from "@/types";

const API_BASE = "https://api.astria.ai";
const FLUX_BASE_TUNE_ID = 1504944; // Astria's FLUX.1 dev base model ID

function headers() {
  return {
    Authorization: `Bearer ${process.env.ASTRIA_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export interface CreateTuneParams {
  title: string;
  imageUrls: string[];
  webhookUrl?: string;
  modelName?: string;
}

export async function createTune(params: CreateTuneParams): Promise<AstriaTune> {
  const { title, imageUrls, webhookUrl, modelName = "ohwx person" } = params;

  const body: Record<string, unknown> = {
    tune: {
      title,
      name: modelName,
      branch: "flux1",
      model_type: "lora",
      preset: "flux-lora-portrait",
      base_tune_id: FLUX_BASE_TUNE_ID,
      image_urls: imageUrls,
      steps: null,
      ...(webhookUrl ? { callback: webhookUrl } : {}),
    },
  };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/tunes`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        route: "lib/astria",
        event: "createTune_network_error",
        durationMs: Date.now() - startedAt,
        title,
        imageCount: imageUrls.length,
        message: msg,
      })
    );
    throw new Error(`Astria createTune network error: ${msg}`);
  }

  const durationMs = Date.now() - startedAt;

  if (!res.ok) {
    const text = await res.text();
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        route: "lib/astria",
        event: "createTune_http_error",
        status: res.status,
        durationMs,
        title,
        imageCount: imageUrls.length,
        // First 1KB of response is usually enough to diagnose, avoids logging huge HTML
        responseBody: text.slice(0, 1024),
      })
    );
    throw new Error(`Astria createTune failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as AstriaTune;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      route: "lib/astria",
      event: "createTune_success",
      status: res.status,
      durationMs,
      title,
      imageCount: imageUrls.length,
      tuneId: json.id,
    })
  );
  return json;
}

export interface GenerateParams {
  tuneId: number;
  prompt: string;
  numImages?: number;
  webhookUrl?: string;
  faceCorrect?: boolean;
  superResolution?: boolean;
  filmGrain?: boolean;
  cfgScale?: number;
  steps?: number;
  // null/empty string disables the suffix entirely.
  realismSuffix?: string | null;
  // Astria accepts 0 .. 2^32-1. Omit for a server-randomized seed.
  seed?: number;
  // Astria FLUX accepts enum strings like "1:1", "4:5", "9:16", "16:9", "3:2", "2:3".
  aspectRatio?: string;
}

const DEFAULT_REALISM_SUFFIX =
  "unretouched candid photograph, visible skin pores and texture, " +
  "individual beard hairs, natural skin imperfections, no beauty filter, " +
  "documentary photography, shot on 35mm film";

const envNum = (v: string | undefined, d: number) =>
  v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;
const envBool = (v: string | undefined, d: boolean) =>
  v === undefined ? d : v === "true";

export async function generateImages(params: GenerateParams): Promise<AstriaPrompt> {
  const {
    tuneId,
    prompt,
    numImages = 4,
    webhookUrl,
    faceCorrect = envBool(process.env.ASTRIA_FACE_CORRECT, false),
    superResolution = envBool(process.env.ASTRIA_SUPER_RES, false),
    filmGrain = envBool(process.env.ASTRIA_FILM_GRAIN, true),
    cfgScale = envNum(process.env.ASTRIA_CFG_SCALE, 3),
    steps = envNum(process.env.ASTRIA_STEPS, 40),
    realismSuffix = process.env.ASTRIA_REALISM_SUFFIX ?? DEFAULT_REALISM_SUFFIX,
    seed,
    aspectRatio,
  } = params;

  // Astria's FLUX LoRA trigger phrase (required — validated server-side)
  const triggered = `sks ohwx person ${prompt}`;
  const suffix = realismSuffix && realismSuffix.length > 0 ? `, ${realismSuffix}` : "";

  // Optional realism LoRA stack via Astria's inline syntax. Gate behind env var
  // until a working FLUX realism LoRA ID is verified — bad IDs 422 the request.
  const realismLora = process.env.ASTRIA_REALISM_LORA_ID;
  const realismLoraWeight = envNum(process.env.ASTRIA_REALISM_LORA_WEIGHT, 0.5);
  const loraTag = realismLora ? ` <lora:${realismLora}:${realismLoraWeight}>` : "";

  const fullPrompt = `${triggered}${suffix}${loraTag}`;

  // Note: FLUX on Astria does not support `negative_prompt` (422) or
  // `prompt_strength`. Realism is controlled via `cfg_scale` + `film_grain`
  // + the suffix above + (optionally) a stacked realism LoRA.
  const body: Record<string, unknown> = {
    prompt: {
      text: fullPrompt,
      num_images: numImages,
      super_resolution: superResolution,
      face_correct: faceCorrect,
      film_grain: filmGrain,
      cfg_scale: cfgScale,
      steps,
      ...(seed !== undefined ? { seed } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    },
  };

  if (webhookUrl) {
    body.prompt = { ...(body.prompt as object), callback: webhookUrl };
  }

  const res = await fetch(`${API_BASE}/tunes/${tuneId}/prompts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Astria generateImages failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function listPrompts(
  tuneId: number,
  { offset = 0 }: { offset?: number } = {}
): Promise<AstriaPrompt[]> {
  const res = await fetch(
    `${API_BASE}/tunes/${tuneId}/prompts?offset=${offset}`,
    { headers: headers() }
  );

  if (!res.ok) {
    throw new Error(`Astria listPrompts failed: ${res.status}`);
  }

  return res.json();
}

export async function getTune(tuneId: number): Promise<AstriaTune> {
  const res = await fetch(`${API_BASE}/tunes/${tuneId}`, {
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Astria getTune failed: ${res.status}`);
  }

  return res.json();
}

export async function getPrompt(
  tuneId: number,
  promptId: number
): Promise<AstriaPrompt> {
  const res = await fetch(`${API_BASE}/tunes/${tuneId}/prompts/${promptId}`, {
    headers: headers(),
  });

  if (!res.ok) {
    throw new Error(`Astria getPrompt failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Polls Astria until the prompt finishes rendering (images populated) or times out.
 * FLUX LoRA with 4 images usually completes in 15–40s.
 */
export async function waitForPrompt(
  tuneId: number,
  promptId: number,
  { timeoutMs = 120_000, intervalMs = 3000 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<AstriaPrompt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prompt = await getPrompt(tuneId, promptId);
    if (prompt.images && prompt.images.length > 0) return prompt;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Astria prompt ${promptId} did not complete within ${timeoutMs}ms`);
}
