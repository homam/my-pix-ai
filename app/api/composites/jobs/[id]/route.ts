import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeCaller, failure, unauthorized } from "@/lib/composite/http";
import { advanceJob, cancelJob } from "@/lib/composite/jobs";
import { exportPlan } from "@/lib/composite/dimensions";
import { isOwnCompositePath, signRead } from "@/lib/composite/storage";
import { publicJob } from "@/lib/composite/view";
import type { CompositeJob, CompositeVersion } from "@/lib/composite/types";

// GET    /api/composites/jobs/[id] — the job's status. Each poll also ADVANCES it
//        (provider status → save the version → review), one heavy step per call,
//        so no single request outlives App Runner's 120 s cap.
// DELETE /api/composites/jobs/[id] — cancel while still queued; refunded once.
//
// Ownership: the row is read with the caller's RLS client first. A job id that
// is not theirs is indistinguishable from one that does not exist.

export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

async function ownJob(caller: NonNullable<Awaited<ReturnType<typeof compositeCaller>>>, id: string) {
  const { data, error } = await caller.supabase
    .from("composite_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`reading the job failed: ${error.message}`);
  return data as CompositeJob | null;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/jobs/[id]");
  const { id } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  try {
    if (!(await ownJob(caller, id))) {
      return NextResponse.json({ error: "Job not found", reqId: log.reqId }, { status: 404 });
    }
    const job = await advanceJob(caller.serviceClient, id, log, { budgetMs: 60_000 });

    let version = null;
    if (job.version_id) {
      const { data } = await caller.supabase
        .from("composite_versions")
        .select("*")
        .eq("id", job.version_id)
        .maybeSingle();
      const v = data as CompositeVersion | null;
      if (v && isOwnCompositePath(v.preview_path, caller.user.id, v.group_id)) {
        version = {
          ...v,
          previewUrl: await signRead(caller.serviceClient, v.preview_path, 3600),
          plan: exportPlan({ width: v.native_width, height: v.native_height }),
        };
      }
    }
    return NextResponse.json(
      { job: publicJob(job), version, reqId: log.reqId },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    return failure(log, err, "composite_job_poll_failed", { userId: caller.user.id, jobId: id });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/jobs/[id]");
  const { id } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  try {
    const job = await ownJob(caller, id);
    if (!job) return NextResponse.json({ error: "Job not found", reqId: log.reqId }, { status: 404 });
    const cancelled = await cancelJob(caller.serviceClient, job, log);
    return NextResponse.json({ job: publicJob(cancelled), reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composite_job_cancel_failed", { userId: caller.user.id, jobId: id });
  }
}
