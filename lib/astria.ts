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
}

export async function generateImages(params: GenerateParams): Promise<AstriaPrompt> {
  const { tuneId, prompt, numImages = 4, webhookUrl } = params;

  // Astria's FLUX LoRA trigger phrase (required — validated server-side)
  const fullPrompt = `sks ohwx person ${prompt}`;

  const body: Record<string, unknown> = {
    prompt: {
      text: fullPrompt,
      num_images: numImages,
      super_resolution: true,
      face_correct: true,
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
