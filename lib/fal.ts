// fal.ai FLUX.2 client — the second image engine (training + inference).
//
// Astria remains the primary engine and its face/identity tooling. fal is used
// to reach FLUX.2 output, which Astria does not expose as a base tune. This
// client talks to fal's public queue REST API directly (no SDK dependency) and
// is inert until FAL_KEY is set.
//
// A model is bound to ONE engine at training time: a LoRA trained on Astria
// cannot render on fal and vice versa. To offer FLUX.2 for a person you train
// that person on fal here and store the resulting weights URL on the model.
//
// Docs: https://docs.fal.ai/model-endpoints/queue
//       https://fal.ai/models/fal-ai/flux-2/lora
//       https://fal.ai/models/fal-ai/flux-2-trainer

const QUEUE_BASE = "https://queue.fal.run";

const GEN_MODEL = "fal-ai/flux-2/lora";
const TRAIN_MODEL = "fal-ai/flux-2-trainer";

// Rare trigger token bound to the subject during training (via default_caption)
// and required in every generation prompt — fal's trainer has no trigger_word
// field, so the caption carries it. Mirrors Astria's "ohwx person" convention.
export const FAL_TRIGGER = "ohwx person";
const FAL_DEFAULT_CAPTION = `a photo of ${FAL_TRIGGER}`;

export function isFalConfigured(): boolean {
  return Boolean(process.env.FAL_KEY);
}

// Identity/quality tuning for the fal (FLUX.2) engine. Defaults are chosen for
// single-subject face LoRAs, NOT copied from Astria — the two engines use
// different scales, so reusing Astria's CFG numbers as fal guidance is wrong:
//   - loraScale > 1 strengthens likeness (a LoRA at 1.0 often renders a weak,
//     "sort-of-like-me" face; 1.2 is a good identity default, up to ~1.4).
//   - fal's FLUX.2 wants guidance ~2.5–3.5 (its own default is 2.5); Astria's
//     realism-preset CFG (1.5/3/5) does not translate.
// Both overridable per-deployment (tune without a code change / redeploy).
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
export function falLoraScale(): number {
  return envNum("FAL_LORA_SCALE", 1.2);
}
export function falGuidanceScale(): number {
  return envNum("FAL_GUIDANCE_SCALE", 3.0);
}

function headers() {
  return {
    Authorization: `Key ${process.env.FAL_KEY}`,
    "Content-Type": "application/json",
  };
}

interface QueueSubmitResponse {
  request_id: string;
  // fal returns the canonical polling URLs here. They must be used verbatim —
  // for sub-path models like fal-ai/flux-2/lora the status/result URLs live
  // under the PARENT app path (fal-ai/flux-2/requests/...), so reconstructing
  // them from the model id is wrong. Optional only as a defensive guard.
  status_url?: string;
  response_url?: string;
}

export type FalStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | string;

interface QueueStatus {
  status: FalStatus;
}

/**
 * Submit a job to fal's queue. Optionally register a webhook so fal POSTs the
 * result on completion (like Astria callbacks). Without one, poll via status.
 */
async function submit(
  model: string,
  input: Record<string, unknown>,
  webhookUrl?: string
): Promise<QueueSubmitResponse> {
  if (!isFalConfigured()) {
    throw new Error("fal is not configured: FAL_KEY is unset");
  }
  const url = new URL(`${QUEUE_BASE}/${model}`);
  if (webhookUrl) url.searchParams.set("fal_webhook", webhookUrl);

  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal submit failed: ${res.status} ${text.slice(0, 1024)}`);
  }
  return res.json();
}

async function getStatusByUrl(statusUrl: string): Promise<QueueStatus> {
  const res = await fetch(statusUrl, { headers: headers() });
  if (!res.ok) {
    throw new Error(`fal status failed: ${res.status}`);
  }
  return res.json();
}

async function getResultByUrl<T>(responseUrl: string): Promise<T> {
  const res = await fetch(responseUrl, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal result failed: ${res.status} ${text.slice(0, 1024)}`);
  }
  return res.json();
}

/**
 * Polls a queued fal job (by its fal-provided status/result URLs) until
 * COMPLETED (returns the result) or FAILED / timeout (throws). Only used for
 * inference, which finishes in well under a minute; training is long-running
 * and polled by the refresh route instead.
 */
async function waitForFalResult<T>(
  statusUrl: string,
  responseUrl: string,
  // 100s, not more: App Runner cuts requests at a hard 120s — timing out inside
  // that window lets the caller's refund path run instead of a severed socket.
  { timeoutMs = 100_000, intervalMs = 3000 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await getStatusByUrl(statusUrl);
    if (status === "COMPLETED") return getResultByUrl<T>(responseUrl);
    if (status === "FAILED") {
      throw new Error(`fal request failed: ${responseUrl}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`fal request did not complete within ${timeoutMs}ms`);
}

// ------------------------------ Generation ------------------------------

export interface FalGenerateParams {
  prompt: string; // user prompt + realism suffix; trigger is prepended here
  loraUrl: string; // the person's fal-trained FLUX.2 LoRA weights URL
  loraScale?: number;
  numImages?: number;
  seed?: number;
  // fal enum: square_hd, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9
  imageSize?: string;
  guidanceScale?: number;
  numInferenceSteps?: number;
  webhookUrl?: string;
}

interface FalImage {
  url: string;
  width?: number;
  height?: number;
}
interface FalGenOutput {
  images: FalImage[];
  seed?: number;
}

export interface FalRenderResult {
  images: string[]; // source image URLs (mirror these — fal URLs expire)
  requestId: string;
  seed: number | null;
}

/** Runs FLUX.2 LoRA inference on fal and returns the source image URLs. */
export async function falGenerateFlux2(
  params: FalGenerateParams
): Promise<FalRenderResult> {
  const {
    prompt,
    loraUrl,
    loraScale = falLoraScale(),
    numImages = 4,
    seed,
    imageSize = "portrait_4_3",
    guidanceScale = falGuidanceScale(),
    numInferenceSteps = 28,
    webhookUrl,
  } = params;

  const input: Record<string, unknown> = {
    prompt: `${FAL_TRIGGER}, ${prompt}`,
    loras: [{ path: loraUrl, scale: loraScale }],
    num_images: numImages,
    image_size: imageSize,
    guidance_scale: guidanceScale,
    num_inference_steps: numInferenceSteps,
    ...(seed !== undefined ? { seed } : {}),
  };

  const sub = await submit(GEN_MODEL, input, webhookUrl);
  // Prefer fal's returned URLs; fall back to reconstruction only if absent.
  const statusUrl =
    sub.status_url ?? `${QUEUE_BASE}/${GEN_MODEL}/requests/${sub.request_id}/status`;
  const responseUrl =
    sub.response_url ?? `${QUEUE_BASE}/${GEN_MODEL}/requests/${sub.request_id}`;
  const out = await waitForFalResult<FalGenOutput>(statusUrl, responseUrl);

  return {
    images: (out.images ?? []).map((i) => i.url),
    requestId: sub.request_id,
    seed: out.seed ?? seed ?? null,
  };
}

// ------------------------------- Training -------------------------------

export interface FalSubmitTrainingParams {
  // Public URL of a zip archive of the person's training images (fal ingests a
  // zip, not loose URLs — build it with lib/zip.ts and host it in our bucket).
  imageDataUrl: string;
  steps?: number;
  webhookUrl?: string;
}

/**
 * Kicks off a FLUX.2 LoRA training job on fal and returns its request id. Does
 * NOT wait — training runs for many minutes; the refresh route polls
 * falTrainingStatus() (or a webhook fires) to finish it. Cost ≈ $0.0064/step
 * (~$9.60 at the 1500-step Balanced default), notably pricier than Astria's
 * ~$1.50 portrait tune. Callers normally pass a resolved step count from the
 * training-quality preset (lib/trainingPresets.ts); the default here is the
 * Balanced value so an unspecified train isn't the too-light 1000 that made
 * Ultra likeness trail Standard.
 */
export async function falSubmitTraining(
  params: FalSubmitTrainingParams
): Promise<{ requestId: string }> {
  const { imageDataUrl, steps = 1500, webhookUrl } = params;

  const input: Record<string, unknown> = {
    image_data_url: imageDataUrl,
    steps,
    default_caption: FAL_DEFAULT_CAPTION,
    output_lora_format: "fal",
  };

  const { request_id } = await submit(TRAIN_MODEL, input, webhookUrl);
  return { requestId: request_id };
}

interface FalFile {
  url: string;
}
interface FalTrainOutput {
  diffusers_lora_file: FalFile;
  config_file?: FalFile;
}

export interface FalTrainingStatus {
  status: FalStatus;
  // Populated only once status === "COMPLETED".
  loraUrl: string | null;
}

/**
 * Checks a training job's status. When COMPLETED, resolves the trained LoRA
 * weights URL to persist on the model. Used by the refresh polling endpoint.
 */
export async function falTrainingStatus(
  requestId: string
): Promise<FalTrainingStatus> {
  // The trainer's status/result URLs reconstruct correctly from its own model
  // id (verified: fal-ai/flux-2-trainer/requests/<id>[/status]). We only keep
  // the request id, so rebuild here rather than persisting the URLs.
  const base = `${QUEUE_BASE}/${TRAIN_MODEL}/requests/${requestId}`;
  const { status } = await getStatusByUrl(`${base}/status`);
  if (status !== "COMPLETED") {
    return { status, loraUrl: null };
  }
  const out = await getResultByUrl<FalTrainOutput>(base);
  return { status, loraUrl: out.diffusers_lora_file?.url ?? null };
}
