// The composite state machine, as pure functions (unit-tested in
// verify/src/composite.unit.test.ts).
//
//   draft → uploading → preparing → ready_to_generate → queued → generating → review → complete
//                                                         ↘ failed / cancelled (terminal)
//
// The first half belongs to the GROUP (its sources), the second to a JOB. A
// correction is a new job linked to an existing version; it never rewrites that
// version, so a group with a finished version is "complete" again as soon as no
// job is active.

import type {
  CompositeJob,
  CompositeSource,
  GroupStatus,
  JobStatus,
} from "@/lib/composite/types";

export const ACTIVE_JOB_STATUSES: JobStatus[] = ["queued", "generating", "review"];
export const TERMINAL_JOB_STATUSES: JobStatus[] = ["complete", "failed", "cancelled"];

const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["queued", "generating", "review", "failed", "cancelled"],
  generating: ["generating", "review", "failed"],
  review: ["review", "complete"],
  complete: [],
  failed: [],
  cancelled: [],
};

export function isActiveJob(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** The job statuses an UPDATE may move away from to reach `to` (the SQL guard). */
export function allowedFrom(to: JobStatus): JobStatus[] {
  return (Object.keys(JOB_TRANSITIONS) as JobStatus[]).filter((from) =>
    JOB_TRANSITIONS[from].includes(to)
  );
}

/** Map a provider queue status onto ours. Unknown strings keep the job queued. */
export function jobStatusForProvider(providerStatus: string): JobStatus | "completed" | "failed" {
  switch (providerStatus) {
    case "IN_PROGRESS":
      return "generating";
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "ERROR":
      return "failed";
    default:
      return "queued";
  }
}

type SourceLike = Pick<CompositeSource, "kind" | "status" | "id" | "parent_source_id">;
type JobLike = Pick<CompositeJob, "status" | "created_at">;

/**
 * Derive a group's status from its sources, its jobs and whether it holds a
 * finished version. Stored on the row so lists can render without joins, and
 * recomputed after every mutation (lib/composite/jobs.ts syncGroupStatus).
 */
export function groupStatusFrom(
  sources: SourceLike[],
  jobs: JobLike[],
  hasVersion: boolean
): GroupStatus {
  const newestFirst = [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = newestFirst.find((j) => isActiveJob(j.status));
  if (active) return active.status;
  if (hasVersion) return "complete";
  const newest = newestFirst[0];
  if (newest?.status === "failed") return "failed";
  if (newest?.status === "cancelled") return "cancelled";

  if (sources.length === 0) return "draft";
  if (sources.some((s) => s.status === "pending")) return "uploading";
  const usable = sources.filter((s) => s.status === "uploaded");
  // A video contributes nothing until stills have been extracted from it.
  const videos = usable.filter((s) => s.kind === "video");
  const framesFor = (id: string) =>
    usable.some((s) => s.kind === "frame" && s.parent_source_id === id);
  if (videos.some((v) => !framesFor(v.id))) return "preparing";
  return usable.some((s) => s.kind !== "video") ? "ready_to_generate" : "draft";
}
