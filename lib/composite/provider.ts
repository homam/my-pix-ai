// Composite engines: the provider seam for multi-reference renders and
// corrections. Server-only.
//
// Every engine is asynchronous by contract — submit returns at once, the job is
// advanced by polling (or a fal webhook nudge) — because a native-4K render took
// 40–60 s in the spike and App Runner cuts every request at 120 s. Nothing in
// this module ever waits for a render to finish inside one request.
//
//   fal  — fal's queue API; default model fal-ai/nano-banana-pro/edit
//          (Gemini 3 Pro Image). Inputs are short-lived signed URLs to the
//          private composites bucket.
//   mock — stitches the references side by side with sharp and "completes"
//          instantly. Development and the smoke journey only (config.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { falQueueResult, falQueueStatus, falQueueSubmit } from "@/lib/fal";
import type { ProviderProfile } from "@/lib/composite/config";
import { mockStitch } from "@/lib/composite/imaging";
import { compositePath, downloadObject, uploadObject } from "@/lib/composite/storage";
import type { CompositeAspect } from "@/lib/composite/types";
import type { ProviderAspect } from "@/lib/composite/dimensions";

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface SubmitInput {
  prompt: string;
  // In order: anchor/edit target first. Signed URLs the provider can fetch.
  imageUrls: string[];
  // Renders use the group's setting; corrections keep their target's shape.
  aspectRatio: CompositeAspect | ProviderAspect;
  webhookUrl?: string;
  // What the mock engine composes from (render: references; correction: the
  // edit target alone). Real engines fetch imageUrls themselves.
  mock?: { kind: "render" | "correction"; images: () => Promise<Buffer[]> };
}

export interface SubmitContext {
  serviceClient: SupabaseClient<any, any, any>;
  userId: string;
  groupId: string;
  jobId: string;
  // 1 for the first submission, 2 for the automatic resubmission.
  attempt: number;
}

export interface Submission {
  requestId: string;
  statusUrl: string | null;
  responseUrl: string | null;
  cancelUrl: string | null;
}

export type PollState =
  | { state: "queued" | "generating" }
  | { state: "completed" }
  | { state: "failed"; error: string };

export interface JobHandles {
  provider_request_id: string | null;
  status_url: string | null;
  response_url: string | null;
  cancel_url: string | null;
}

export interface CompositeEngine {
  submit(input: SubmitInput, ctx: SubmitContext, profile: ProviderProfile): Promise<Submission>;
  poll(job: JobHandles): Promise<PollState>;
  /** The rendered image's bytes. Throws ProviderError when there is none. */
  result(job: JobHandles, ctx: Pick<SubmitContext, "serviceClient">): Promise<Buffer>;
  /** true = the provider will not run it (cancelled while queued). */
  cancel(job: JobHandles): Promise<boolean>;
}

// ----------------------------------------------------------------------- fal

interface FalImage {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

const falEngine: CompositeEngine = {
  async submit(input, _ctx, profile) {
    // fal's queue accepts anything and fails it later (with a charge-free 422);
    // refuse an incomplete request here instead.
    if (!input.prompt?.trim() || !input.imageUrls?.length) {
      throw new ProviderError("refusing to submit a request without a prompt or input images");
    }
    const sub = await falQueueSubmit(
      profile.model,
      {
        prompt: input.prompt,
        image_urls: input.imageUrls,
        aspect_ratio: input.aspectRatio,
        resolution: profile.resolution,
        output_format: "png",
        num_images: 1,
      },
      input.webhookUrl
    );
    return {
      requestId: sub.request_id,
      statusUrl: sub.status_url ?? null,
      responseUrl: sub.response_url ?? null,
      cancelUrl: sub.cancel_url ?? null,
    };
  },

  async poll(job) {
    if (!job.status_url) return { state: "failed", error: "no status url recorded for this request" };
    const st = await falQueueStatus(job.status_url);
    if (st.error) return { state: "failed", error: String(st.error).slice(0, 500) };
    switch (st.status) {
      case "IN_PROGRESS":
        return { state: "generating" };
      case "COMPLETED":
        return { state: "completed" };
      case "FAILED":
      case "ERROR":
        return { state: "failed", error: `provider reported ${st.status}` };
      default:
        return { state: "queued" };
    }
  },

  async result(job) {
    if (!job.response_url) throw new ProviderError("no response url recorded for this request");
    let out: { images?: FalImage[]; detail?: unknown };
    try {
      out = await falQueueResult<{ images?: FalImage[]; detail?: unknown }>(job.response_url);
    } catch (err) {
      // A COMPLETED request whose result is a 4xx (validation, safety) failed.
      throw new ProviderError(err instanceof Error ? err.message : String(err));
    }
    const url = out.images?.[0]?.url;
    if (!url) throw new ProviderError("the provider returned no image");
    const res = await fetch(url);
    if (!res.ok) throw new ProviderError(`downloading the render failed: HTTP ${res.status}`, true);
    return Buffer.from(await res.arrayBuffer());
  },

  async cancel(job) {
    if (!job.cancel_url) return false;
    const res = await fetch(job.cancel_url, {
      method: "PUT",
      headers: { Authorization: `Key ${process.env.FAL_KEY}` },
    });
    // 202 CANCELLATION_REQUESTED while queued; 400 ALREADY_COMPLETED otherwise.
    return res.status === 202 || res.status === 200;
  },
};

// ---------------------------------------------------------------------- mock

// The smoke journey proves "a failed job refunds exactly once" without a paid
// provider: a prompt carrying this marker makes the mock job fail on its first
// poll. The mock engine is unavailable in production builds (config.ts).
export const MOCK_FAIL_MARKER = "[mock:fail]";
// …and this one fails only the first attempt, the way nano-banana-pro's
// transient "could not generate images" does — proving the free resubmission.
export const MOCK_FAIL_ONCE_MARKER = "[mock:fail-once]";

const mockEngine: CompositeEngine = {
  async submit(input, ctx) {
    if (input.prompt.includes(MOCK_FAIL_MARKER)) {
      return { requestId: "mock:fail", statusUrl: null, responseUrl: null, cancelUrl: null };
    }
    if (input.prompt.includes(MOCK_FAIL_ONCE_MARKER) && ctx.attempt === 1) {
      return { requestId: "mock:fail-transient", statusUrl: null, responseUrl: null, cancelUrl: null };
    }
    if (!input.mock) throw new ProviderError("mock engine needs its input images");
    const images = await input.mock.images();
    const out =
      input.mock.kind === "render"
        ? await mockStitch(images, input.aspectRatio as CompositeAspect)
        : images[0]!; // a correction "returns" its prepared edit target
    const path = compositePath(ctx.userId, ctx.groupId, "work", `${ctx.jobId}-mock.png`);
    await uploadObject(ctx.serviceClient, path, out, input.mock.kind === "render" ? "image/png" : "image/jpeg");
    return { requestId: path, statusUrl: null, responseUrl: null, cancelUrl: null };
  },
  async poll(job) {
    if (job.provider_request_id === "mock:fail") return { state: "failed", error: "mock failure requested" };
    if (job.provider_request_id === "mock:fail-transient") {
      return { state: "failed", error: "Could not generate images with the given prompts and images (mock)" };
    }
    return { state: "completed" };
  },
  async result(job, ctx) {
    if (!job.provider_request_id) throw new ProviderError("mock request has no output");
    return downloadObject(ctx.serviceClient, job.provider_request_id);
  },
  async cancel() {
    return false;
  },
};

export function engineFor(profile: Pick<ProviderProfile, "id">): CompositeEngine {
  return profile.id === "mock" ? mockEngine : falEngine;
}
