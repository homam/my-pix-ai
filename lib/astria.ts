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
      preset: "flux-lora-portrait",
      base_tune_id: FLUX_BASE_TUNE_ID,
      image_urls: imageUrls,
      steps: null,
      ...(webhookUrl ? { callback: webhookUrl } : {}),
    },
  };

  const res = await fetch(`${API_BASE}/tunes`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Astria createTune failed: ${res.status} ${text}`);
  }

  return res.json();
}

export interface GenerateParams {
  tuneId: number;
  prompt: string;
  numImages?: number;
  webhookUrl?: string;
}

export async function generateImages(params: GenerateParams): Promise<AstriaPrompt> {
  const { tuneId, prompt, numImages = 4, webhookUrl } = params;

  // Prepend the trigger token for face LoRA
  const fullPrompt = `ohwx person ${prompt}`;

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
