// Composite job orchestration. Server-only; every function takes the
// SERVICE-ROLE client (`serviceClient`) — `authenticated` holds SELECT only on
// the composite tables (platform migration 0028), so all writes happen here,
// after the calling route has established who the user is.
//
// A job is one provider call: a render from a group's sources, or a correction
// of one version. Its life:
//
//   startJob    insert (idempotency key) → charge → prepare inputs → submit
//   advanceJob  poll the provider → finalize into a version → review → complete
//
// Rendering takes ~40–60 s and App Runner cuts requests at 120 s, so nothing
// waits for the provider inside a request: the browser polls GET
// /api/composites/jobs/[id] (and a fal webhook nudges the same code path), and
// each call advances the job as far as it can within a time budget.
//
// Exactly-once guarantees, each enforced by a conditional UPDATE rather than by
// reading first:
//   - a retried submit with the same idempotency key returns the first job and
//     never charges again (unique (user_id, idempotency_key));
//   - finalization and review run under a short lease, so two concurrent polls
//     cannot both turn one provider result into two versions;
//   - a failed or cancelled job is refunded once: `refunded_at` flips from null
//     only for the caller that wins the update, and the grant runs only then.

import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addCredits, deductCredits } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import { errInfo, type Logger } from "@/lib/log";
import { compositeProvider, type ProviderProfile } from "@/lib/composite/config";
import { classifyProviderError } from "@/lib/composite/errors";
import { engineFor, ProviderError, type SubmitInput } from "@/lib/composite/provider";
import { downscaleJpeg, probe } from "@/lib/composite/imaging";
import { reviewComposite, reviewerEnabled, REVIEW_MODEL } from "@/lib/composite/review";
import { allowedFrom, groupStatusFrom, isActiveJob } from "@/lib/composite/states";
import { formatTimestamp } from "@/lib/composite/selection";
import {
  compositePath,
  downloadObject,
  signReads,
  uploadObject,
} from "@/lib/composite/storage";
import type {
  CompositeGroup,
  CompositeJob,
  CompositeReview,
  CompositeSource,
  CompositeVersion,
  CorrectionMarks,
  CorrectionMode,
  GroupStatus,
} from "@/lib/composite/types";

type Svc = SupabaseClient<any, any, any>;

export class CompositeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "CompositeError";
  }
}

// A job the provider has not accepted within this long is treated as lost.
const SUBMIT_GRACE_MS = 3 * 60_000;
// …and one that has not finished within this long is cancelled and refunded.
const RENDER_TIMEOUT_MS = 20 * 60_000;
const LEASE_MS = 100_000;
// Worst case of one finalize or review step (the reviewer times out at 85 s).
const HEAVY_STEP_MS = 90_000;

// ------------------------------------------------------------------ loading

export async function loadOwnedGroup(serviceClient: Svc, userId: string, groupId: string) {
  const { data, error } = await serviceClient
    .from("composite_groups")
    .select("*")
    .eq("id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`loading composite group failed: ${error.message}`);
  if (!data) throw new CompositeError("Composite not found", 404, "not_found");
  return data as CompositeGroup;
}

async function loadJob(serviceClient: Svc, jobId: string): Promise<CompositeJob> {
  const { data, error } = await serviceClient
    .from("composite_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (error || !data) throw new Error(`loading composite job failed: ${error?.message}`);
  return data as CompositeJob;
}

export async function loadSources(serviceClient: Svc, groupId: string): Promise<CompositeSource[]> {
  const { data, error } = await serviceClient
    .from("composite_sources")
    .select("*")
    .eq("group_id", groupId)
    .order("sequence", { ascending: true });
  if (error) throw new Error(`loading composite sources failed: ${error.message}`);
  return (data ?? []) as CompositeSource[];
}

// ------------------------------------------------------------- group status

export async function syncGroupStatus(serviceClient: Svc, groupId: string): Promise<GroupStatus> {
  const [sources, jobs, versions] = await Promise.all([
    serviceClient.from("composite_sources").select("id, kind, status, parent_source_id").eq("group_id", groupId),
    serviceClient.from("composite_jobs").select("status, created_at").eq("group_id", groupId),
    serviceClient.from("composite_versions").select("id", { count: "exact", head: true }).eq("group_id", groupId),
  ]);
  for (const r of [sources, jobs, versions]) {
    if (r.error) throw new Error(`syncGroupStatus read failed: ${r.error.message}`);
  }
  const status = groupStatusFrom(
    (sources.data ?? []) as Pick<CompositeSource, "id" | "kind" | "status" | "parent_source_id">[],
    (jobs.data ?? []) as Pick<CompositeJob, "status" | "created_at">[],
    (versions.count ?? 0) > 0
  );
  const { error } = await serviceClient
    .from("composite_groups")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", groupId);
  if (error) throw new Error(`syncGroupStatus write failed: ${error.message}`);
  return status;
}

// ------------------------------------------------------------ money, once

/** Refund a job's charge at most once. Returns true when THIS call refunded. */
export async function refundOnce(
  serviceClient: Svc,
  job: Pick<CompositeJob, "id" | "user_id" | "cost_credits">,
  reason: string,
  log: Logger
): Promise<boolean> {
  const { data: won, error } = await serviceClient
    .from("composite_jobs")
    .update({ refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .is("refunded_at", null)
    .not("charged_at", "is", null)
    .select("id, cost_credits");
  if (error) {
    log.error("composite_refund_claim_failed", { jobId: job.id, pgMessage: error.message });
    return false;
  }
  if (!won?.length) return false; // never charged, or already refunded
  const amount = (won[0] as { cost_credits: number }).cost_credits;
  try {
    await addCredits(serviceClient, job.user_id, amount, null, `Refund (composite: ${reason})`.slice(0, 200));
    log.info("composite_refunded", { jobId: job.id, userId: job.user_id, amount, reason });
    return true;
  } catch (err) {
    // Release the claim so a later advance can retry the grant.
    await serviceClient.from("composite_jobs").update({ refunded_at: null }).eq("id", job.id);
    log.error("composite_refund_failed", { jobId: job.id, userId: job.user_id, ...errInfo(err) });
    return false;
  }
}

async function failJob(serviceClient: Svc, job: CompositeJob, error: string, log: Logger): Promise<CompositeJob> {
  const now = new Date().toISOString();
  const { error: failErr } = await serviceClient
    .from("composite_jobs")
    .update({ status: "failed", error: error.slice(0, 1000), completed_at: now, updated_at: now, lease_until: null })
    .eq("id", job.id)
    .in("status", allowedFrom("failed"));
  if (failErr) log.error("composite_fail_write_failed", { jobId: job.id, pgMessage: failErr.message });
  log.warn("composite_job_failed", { jobId: job.id, userId: job.user_id, error });
  await refundOnce(serviceClient, job, "render failed", log);
  await syncGroupStatus(serviceClient, job.group_id);
  // Re-read: the refund marker was written after the status change.
  return loadJob(serviceClient, job.id);
}

/**
 * The job an idempotency key already created, if any. Routes call this FIRST:
 * a retried click must get its original job back even while that job is the
 * one keeping the group busy (which would otherwise answer 409 job_running).
 */
export async function findJobByKey(
  serviceClient: Svc,
  userId: string,
  idempotencyKey: string
): Promise<CompositeJob | null> {
  const { data, error } = await serviceClient
    .from("composite_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`idempotency lookup failed: ${error.message}`);
  return (data as CompositeJob | null) ?? null;
}

// -------------------------------------------------------------- webhooks

/** fal calls this when a job finishes; it only ever triggers a re-check. */
export function compositeWebhookUrl(jobId: string): string | undefined {
  const base = (process.env.COMPOSITE_WEBHOOK_PUBLIC_URL || process.env.ASTRIA_WEBHOOK_PUBLIC_URL || "").replace(/\/$/, "");
  const secret = webhookSecret();
  if (!base || !secret) return undefined;
  return `${base}/api/webhooks/fal-composite?job=${jobId}&sig=${webhookSignature(jobId)}`;
}

function webhookSecret(): string {
  return process.env.COMPOSITE_WEBHOOK_SECRET || process.env.ASTRIA_WEBHOOK_SECRET || "";
}

export function webhookSignature(jobId: string): string {
  return crypto.createHmac("sha256", webhookSecret()).update(`composite:${jobId}`).digest("hex").slice(0, 32);
}

export function verifyWebhookSignature(jobId: string, sig: string): boolean {
  if (!webhookSecret() || !sig) return false;
  const want = Buffer.from(webhookSignature(jobId));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ----------------------------------------------------------------- start

export interface StartJobInput {
  kind: "render" | "correction";
  group: CompositeGroup;
  userId: string;
  idempotencyKey: string;
  prompt: string;
  referenceSourceIds: string[];
  description: string;
  mode?: CorrectionMode;
  instruction?: string;
  marks?: CorrectionMarks | null;
  targetVersionId?: string;
  // Builds the provider input once the job exists (work files are keyed by job
  // id). Returns STORAGE PATHS, not URLs: they are signed at submit time, and
  // again if the job is resubmitted after a transient provider failure.
  prepare: (jobId: string) => Promise<PreparedInput>;
}

export interface PreparedInput {
  // In provider order: anchor / edit target first.
  inputPaths: string[];
  aspectRatio: SubmitInput["aspectRatio"];
  // The prepared edit target of a correction, kept for lineage.
  prepPath?: string | null;
}

// fal may wait minutes in its queue before it fetches the inputs.
const INPUT_URL_TTL_S = 6 * 3600;
// One free resubmission after a retryable provider failure (lib/composite/errors.ts).
const MAX_ATTEMPTS = 2;

/** Sign a job's inputs and hand them to its engine. */
async function submitPrepared(
  serviceClient: Svc,
  job: CompositeJob,
  profile: Pick<ProviderProfile, "id" | "model" | "resolution"> & Partial<ProviderProfile>,
  prepared: PreparedInput,
  attempt = 1
) {
  const urls = await signReads(serviceClient, prepared.inputPaths, INPUT_URL_TTL_S);
  const imageUrls = prepared.inputPaths.map((path) => {
    const url = urls.get(path);
    if (!url) throw new Error(`input ${path} is missing from storage`);
    return url;
  });
  return engineFor(profile).submit(
    {
      prompt: job.prompt,
      imageUrls,
      aspectRatio: prepared.aspectRatio,
      webhookUrl: compositeWebhookUrl(job.id),
      mock: {
        kind: job.kind,
        // A correction "returns" its prepared edit target; a render stitches all.
        images: () =>
          Promise.all(
            (job.kind === "render" ? prepared.inputPaths : prepared.inputPaths.slice(0, 1)).map((p) =>
              downloadObject(serviceClient, p)
            )
          ),
      },
    },
    { serviceClient, userId: job.user_id, groupId: job.group_id, jobId: job.id, attempt },
    profile as ProviderProfile
  );
}

export async function startJob(
  serviceClient: Svc,
  input: StartJobInput,
  log: Logger
): Promise<{ job: CompositeJob; duplicate: boolean }> {
  const profile = compositeProvider();
  if (!profile) {
    throw new CompositeError("Composites are not enabled on this server", 503, "composite_disabled");
  }

  const { data: inserted, error: insertErr } = await serviceClient
    .from("composite_jobs")
    .insert({
      group_id: input.group.id,
      user_id: input.userId,
      kind: input.kind,
      target_version_id: input.targetVersionId ?? null,
      mode: input.mode ?? null,
      instruction: input.instruction ?? null,
      marks: input.marks ?? null,
      idempotency_key: input.idempotencyKey,
      status: "queued",
      provider: profile.id,
      provider_model: profile.model,
      prompt: input.prompt,
      reference_source_ids: input.referenceSourceIds,
      options: { aspectRatio: input.group.aspect_ratio, resolution: profile.resolution },
      cost_credits: CREDIT_COSTS.COMPOSITE,
    })
    .select("*")
    .single();

  if (insertErr?.code === "23505" && /composite_jobs_one_active/.test(insertErr.message)) {
    throw new CompositeError("This composite is already rendering", 409, "job_running");
  }
  if (insertErr?.code === "23505") {
    // Same click retried: hand back the job it already created. No second charge.
    const { data: existing, error } = await serviceClient
      .from("composite_jobs")
      .select("*")
      .eq("user_id", input.userId)
      .eq("idempotency_key", input.idempotencyKey)
      .single();
    if (error || !existing) throw new Error(`idempotent lookup failed: ${error?.message}`);
    if ((existing as CompositeJob).group_id !== input.group.id) {
      throw new CompositeError("That request id was already used for another composite", 409, "idempotency_conflict");
    }
    log.info("composite_job_duplicate", { jobId: existing.id, userId: input.userId });
    return { job: existing as CompositeJob, duplicate: true };
  }
  if (insertErr || !inserted) throw new Error(`creating the job failed: ${insertErr?.message}`);
  let job = inserted as CompositeJob;

  let charged: { success: boolean; balance: number };
  try {
    charged = await deductCredits(serviceClient, input.userId, "COMPOSITE", input.description.slice(0, 120));
  } catch (err) {
    await failJob(serviceClient, job, `charging credits failed: ${errInfo(err).message}`, log);
    throw err;
  }
  if (!charged.success) {
    // Nothing was charged and nothing ran: drop the row, so the group does not
    // read "failed" and the same click can be retried after topping up.
    await serviceClient.from("composite_jobs").delete().eq("id", job.id).is("charged_at", null);
    throw new CompositeError(
      `Not enough credits — this costs ${CREDIT_COSTS.COMPOSITE}, you have ${charged.balance}.`,
      402,
      "insufficient_credits"
    );
  }
  await serviceClient
    .from("composite_jobs")
    .update({ charged_at: new Date().toISOString() })
    .eq("id", job.id);
  job = { ...job, charged_at: new Date().toISOString() };

  try {
    const prepared = await input.prepare(job.id);
    const sub = await submitPrepared(serviceClient, job, profile, prepared);
    const now = new Date().toISOString();
    const { data: submitted, error } = await serviceClient
      .from("composite_jobs")
      .update({
        provider_request_id: sub.requestId,
        status_url: sub.statusUrl,
        response_url: sub.responseUrl,
        cancel_url: sub.cancelUrl,
        submitted_at: now,
        updated_at: now,
        options: {
          ...job.options,
          prepPath: prepared.prepPath ?? null,
          inputPaths: prepared.inputPaths,
          aspectRatio: prepared.aspectRatio,
          attempts: 1,
        },
      })
      .eq("id", job.id)
      .select("*")
      .single();
    if (error || !submitted) throw new Error(`recording the submission failed: ${error?.message}`);
    job = submitted as CompositeJob;
    log.info("composite_job_submitted", {
      jobId: job.id,
      userId: input.userId,
      kind: input.kind,
      provider: profile.id,
      model: profile.model,
      requestId: sub.requestId,
      references: input.referenceSourceIds.length,
    });
  } catch (err) {
    log.error("composite_submit_failed", { jobId: job.id, ...errInfo(err) });
    const failed = await failJob(serviceClient, job, classifyProviderError(errInfo(err).message).message, log);
    throw Object.assign(
      new CompositeError("The image provider did not accept the request. Your credits were refunded.", 502, "submit_failed"),
      { job: failed }
    );
  }
  await syncGroupStatus(serviceClient, input.group.id);
  return { job, duplicate: false };
}

/**
 * A provider-side failure: resubmit once if it is the transient kind, else
 * fail (and refund) with a sentence the user can act on. The raw error goes to
 * the log only.
 */
async function providerFailed(serviceClient: Svc, job: CompositeJob, raw: string, log: Logger): Promise<CompositeJob> {
  const failure = classifyProviderError(raw);
  const attempts = job.options.attempts ?? 1;
  log.warn("composite_provider_failed", { jobId: job.id, attempts, retry: failure.retry, raw: raw.slice(0, 2000) });
  const inputPaths = job.options.inputPaths;
  if (failure.retry && attempts < MAX_ATTEMPTS && inputPaths?.length) {
    try {
      const sub = await submitPrepared(serviceClient, job, { id: job.provider as "fal" | "mock", model: job.provider_model, resolution: (job.options.resolution as "4K") ?? "4K" }, {
        inputPaths,
        aspectRatio: (job.options.aspectRatio ?? "16:9") as PreparedInput["aspectRatio"],
      }, attempts + 1);
      const now = new Date().toISOString();
      const { data } = await serviceClient
        .from("composite_jobs")
        .update({
          status: "queued",
          provider_request_id: sub.requestId,
          status_url: sub.statusUrl,
          response_url: sub.responseUrl,
          cancel_url: sub.cancelUrl,
          submitted_at: now,
          updated_at: now,
          lease_until: null,
          options: { ...job.options, attempts: attempts + 1 },
        })
        .eq("id", job.id)
        .in("status", ["queued", "generating"])
        .select("*");
      log.info("composite_job_resubmitted", { jobId: job.id, attempt: attempts + 1, requestId: sub.requestId });
      await syncGroupStatus(serviceClient, job.group_id);
      return (data?.[0] as CompositeJob | undefined) ?? (await loadJob(serviceClient, job.id));
    } catch (err) {
      log.error("composite_resubmit_failed", { jobId: job.id, ...errInfo(err) });
    }
  }
  return failJob(serviceClient, job, failure.message, log);
}

// --------------------------------------------------------------- cancel

export async function cancelJob(serviceClient: Svc, job: CompositeJob, log: Logger): Promise<CompositeJob> {
  if (job.status !== "queued") {
    throw new CompositeError("Only a job that has not started rendering can be cancelled", 409, "not_cancellable");
  }
  if (job.provider_request_id) {
    const stopped = await engineFor({ id: job.provider as "fal" | "mock" }).cancel(job).catch(() => false);
    if (!stopped) {
      throw new CompositeError("The provider has already started this render", 409, "not_cancellable");
    }
  }
  const now = new Date().toISOString();
  const { data } = await serviceClient
    .from("composite_jobs")
    .update({ status: "cancelled", completed_at: now, updated_at: now, lease_until: null })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("*");
  if (!data?.length) return loadJob(serviceClient, job.id);
  await refundOnce(serviceClient, job, "cancelled", log);
  await syncGroupStatus(serviceClient, job.group_id);
  log.info("composite_job_cancelled", { jobId: job.id, userId: job.user_id });
  return data[0] as CompositeJob;
}

// --------------------------------------------------------------- advance

async function claimLease(serviceClient: Svc, job: CompositeJob): Promise<boolean> {
  const now = new Date();
  const { data } = await serviceClient
    .from("composite_jobs")
    .update({ lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq("id", job.id)
    .eq("status", job.status)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  return Boolean(data?.length);
}

/**
 * Move a job forward as far as `budgetMs` allows. Safe to call concurrently and
 * repeatedly: every step is either idempotent or guarded by the lease.
 */
export async function advanceJob(
  serviceClient: Svc,
  jobId: string,
  log: Logger,
  { budgetMs = 80_000 }: { budgetMs?: number } = {}
): Promise<CompositeJob> {
  const deadline = Date.now() + budgetMs;
  let job = await loadJob(serviceClient, jobId);
  // Saving a version and reviewing it each take tens of seconds. A second one
  // runs in the same call only when the budget still covers a whole review.
  let heavyDone = false;
  const roomForHeavy = () => !heavyDone || deadline - Date.now() >= HEAVY_STEP_MS;

  for (let step = 0; step < 4 && isActiveJob(job.status) && Date.now() < deadline; step++) {
    const engine = engineFor({ id: job.provider as "fal" | "mock" });

    if (job.status === "queued" || job.status === "generating") {
      if (!job.provider_request_id) {
        if (Date.now() - Date.parse(job.created_at) > SUBMIT_GRACE_MS) {
          return failJob(serviceClient, job, "the request never reached the image provider", log);
        }
        return job;
      }
      if (job.submitted_at && Date.now() - Date.parse(job.submitted_at) > RENDER_TIMEOUT_MS) {
        await engine.cancel(job).catch(() => false);
        return failJob(serviceClient, job, "the render did not finish within 20 minutes", log);
      }
      let poll;
      try {
        poll = await engine.poll(job);
      } catch (err) {
        log.warn("composite_poll_failed", { jobId, ...errInfo(err) });
        return job; // transient; the next poll retries
      }
      if (poll.state === "failed") return providerFailed(serviceClient, job, poll.error, log);
      if (poll.state === "queued" || poll.state === "generating") {
        if (poll.state !== job.status) {
          const { data } = await serviceClient
            .from("composite_jobs")
            .update({ status: poll.state, updated_at: new Date().toISOString() })
            .eq("id", job.id)
            .in("status", allowedFrom(poll.state))
            .select("*");
          if (data?.[0]) job = data[0] as CompositeJob;
          await syncGroupStatus(serviceClient, job.group_id);
        }
        return job;
      }
      // completed
      if (!roomForHeavy() || !(await claimLease(serviceClient, job))) return job;
      job = await finalize(serviceClient, job, log);
      heavyDone = true;
      continue;
    }

    if (job.status === "review") {
      if (!roomForHeavy() || !(await claimLease(serviceClient, job))) return job;
      job = await runReview(serviceClient, job, log);
      heavyDone = true;
    }
  }
  return job;
}

// -------------------------------------------------------------- finalize

async function finalize(serviceClient: Svc, job: CompositeJob, log: Logger): Promise<CompositeJob> {
  const engine = engineFor({ id: job.provider as "fal" | "mock" });
  let image: Buffer;
  try {
    image = await engine.result(job, { serviceClient });
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      // finalize holds the lease; release it so a resubmitted job can finalize later.
      await serviceClient.from("composite_jobs").update({ lease_until: null }).eq("id", job.id);
      return providerFailed(serviceClient, { ...job, lease_until: null }, err.message, log);
    }
    // Retryable: drop the lease so the next poll tries again.
    await serviceClient.from("composite_jobs").update({ lease_until: null }).eq("id", job.id);
    log.warn("composite_result_fetch_failed", { jobId: job.id, ...errInfo(err) });
    return job;
  }

  const meta = await probe(image);
  const versionId = crypto.randomUUID();
  const nativePath = compositePath(job.user_id, job.group_id, "renders", `${versionId}.${meta.ext}`);
  const previewPath = compositePath(job.user_id, job.group_id, "renders", `${versionId}-preview.jpg`);
  const preview = await downscaleJpeg(image, 2048, 86);
  await uploadObject(serviceClient, nativePath, image, meta.mime);
  await uploadObject(serviceClient, previewPath, preview, "image/jpeg");

  const group = await loadOwnedGroup(serviceClient, job.user_id, job.group_id);
  const reviewOn = reviewerEnabled();

  let version: CompositeVersion | null = null;
  for (let attempt = 0; attempt < 4 && !version; attempt++) {
    const { data: last } = await serviceClient
      .from("composite_versions")
      .select("version_number")
      .eq("group_id", job.group_id)
      .order("version_number", { ascending: false })
      .limit(1);
    const next = ((last?.[0] as { version_number: number } | undefined)?.version_number ?? 0) + 1;
    const { data, error } = await serviceClient
      .from("composite_versions")
      .insert({
        id: versionId,
        group_id: job.group_id,
        user_id: job.user_id,
        job_id: job.id,
        parent_version_id: job.target_version_id,
        version_number: next,
        kind: job.kind,
        prompt: job.prompt,
        instruction: job.instruction,
        reference_source_ids: job.reference_source_ids,
        provider: job.provider,
        provider_model: job.provider_model,
        native_path: nativePath,
        native_mime: meta.mime,
        native_width: meta.width,
        native_height: meta.height,
        native_bytes: image.length,
        preview_path: previewPath,
        review_status: reviewOn ? "pending" : "unavailable",
        review: reviewOn
          ? null
          : ({ verdict: "flag", checks: [], mustPreserve: [], issues: [], model: "", reviewedAt: new Date().toISOString(), error: "automatic review is not configured on this server" } satisfies CompositeReview),
      })
      .select("*")
      .single();
    if (error?.code === "23505") continue; // a concurrent version took that number
    if (error || !data) throw new Error(`saving the version failed: ${error?.message}`);
    version = data as CompositeVersion;
  }
  if (!version) throw new Error("could not allocate a version number");

  const display =
    `${group.name} — v${version.version_number}` +
    (job.kind === "correction" && job.instruction ? `: ${job.instruction}` : "");
  const { error: galleryErr } = await serviceClient.from("generated_images").insert({
    user_id: job.user_id,
    model_id: null,
    prompt: display.slice(0, 500),
    url: `/api/composites/media/version/${version.id}`,
    kind: "composite",
    composite_version_id: version.id,
    settings: {
      fullPrompt: job.prompt,
      compositeGroupId: job.group_id,
      compositeVersionId: version.id,
      versionNumber: version.version_number,
      nativeWidth: meta.width,
      nativeHeight: meta.height,
    },
  });
  if (galleryErr) {
    // The version exists and is reachable from its project; only the All photos
    // entry is missing. Loud, not fatal.
    log.error("composite_gallery_insert_failed", { jobId: job.id, versionId: version.id, pgMessage: galleryErr.message });
  }

  const now = new Date().toISOString();
  const nextStatus = reviewOn ? "review" : "complete";
  const { data: moved } = await serviceClient
    .from("composite_jobs")
    .update({
      status: nextStatus,
      version_id: version.id,
      lease_until: null,
      updated_at: now,
      ...(nextStatus === "complete" ? { completed_at: now } : {}),
    })
    .eq("id", job.id)
    .select("*")
    .single();
  await serviceClient
    .from("composite_groups")
    .update({ current_version_id: version.id, updated_at: now })
    .eq("id", job.group_id);
  await syncGroupStatus(serviceClient, job.group_id);

  log.info("composite_version_saved", {
    jobId: job.id,
    versionId: version.id,
    versionNumber: version.version_number,
    native: `${meta.width}x${meta.height}`,
    bytes: image.length,
  });
  return (moved as CompositeJob) ?? (await loadJob(serviceClient, job.id));
}

// ---------------------------------------------------------------- review

function sourceLabel(s: CompositeSource, byId: Map<string, CompositeSource>): string {
  if (s.kind === "frame") {
    const parent = s.parent_source_id ? byId.get(s.parent_source_id) : undefined;
    return `frame at ${formatTimestamp(s.frame_time_s ?? 0)} of the video "${parent?.original_name ?? "video"}"`;
  }
  return `photo "${s.original_name}"`;
}

async function runReview(serviceClient: Svc, job: CompositeJob, log: Logger): Promise<CompositeJob> {
  const started = Date.now();
  let review: CompositeReview;
  let status: "passed" | "flagged" | "unavailable";
  const { data: version } = await serviceClient
    .from("composite_versions")
    .select("*")
    .eq("id", job.version_id!)
    .single();
  try {
    if (!version) throw new Error("the version to review is missing");
    const v = version as CompositeVersion;
    const group = await loadOwnedGroup(serviceClient, job.user_id, job.group_id);
    const sources = await loadSources(serviceClient, job.group_id);
    const byId = new Map(sources.map((s) => [s.id, s]));
    const used = job.reference_source_ids
      .map((id) => byId.get(id))
      .filter((s): s is CompositeSource => Boolean(s?.reference_path))
      .slice(0, 4);

    const composite = await downscaleJpeg(await downloadObject(serviceClient, v.preview_path), 1568, 85);
    const sourceImages = await Promise.all(
      used.map(async (s) => ({
        label: sourceLabel(s, byId),
        jpeg: await downscaleJpeg(await downloadObject(serviceClient, s.reference_path!), 1024, 82),
      }))
    );
    let correction;
    if (job.kind === "correction" && job.target_version_id) {
      const { data: prev } = await serviceClient
        .from("composite_versions")
        .select("preview_path")
        .eq("id", job.target_version_id)
        .single();
      if (prev) {
        correction = {
          mode: job.mode ?? "text",
          instruction: job.instruction ?? "",
          previous: await downscaleJpeg(await downloadObject(serviceClient, (prev as { preview_path: string }).preview_path), 1024, 82),
        };
      }
    }
    review = await reviewComposite({
      composite,
      sources: sourceImages,
      mustPreserve: group.must_preserve,
      scenePriority: group.scene_priority,
      correction,
    });
    status = review.verdict === "pass" ? "passed" : "flagged";
  } catch (err) {
    log.error("composite_review_failed", { jobId: job.id, ...errInfo(err) });
    review = {
      verdict: "flag",
      checks: [],
      mustPreserve: [],
      issues: [],
      model: REVIEW_MODEL,
      reviewedAt: new Date().toISOString(),
      error: errInfo(err).message.slice(0, 300),
    };
    status = "unavailable";
  }

  if (version) {
    await serviceClient
      .from("composite_versions")
      .update({ review, review_status: status })
      .eq("id", (version as CompositeVersion).id);
  }
  const now = new Date().toISOString();
  const { data: done } = await serviceClient
    .from("composite_jobs")
    .update({ status: "complete", completed_at: now, updated_at: now, lease_until: null })
    .eq("id", job.id)
    .eq("status", "review")
    .select("*");
  await syncGroupStatus(serviceClient, job.group_id);
  log.info("composite_reviewed", {
    jobId: job.id,
    versionId: job.version_id,
    status,
    issues: review.issues.length,
    ms: Date.now() - started,
  });
  return (done?.[0] as CompositeJob | undefined) ?? (await loadJob(serviceClient, job.id));
}
