// Row shapes of the mypix.composite_* tables (platform migration 0028) and the
// small value types the composite pipeline passes around. See docs/COMPOSITES.md.

/**
 * One state set for the whole journey. A group walks the preparation half;
 * once a job exists the group mirrors its newest active job (lib/composite/states.ts).
 */
export type GroupStatus =
  | "draft"
  | "uploading"
  | "preparing"
  | "ready_to_generate"
  | "queued"
  | "generating"
  | "review"
  | "complete"
  | "failed"
  | "cancelled";

export type JobStatus =
  | "queued"
  | "generating"
  | "review"
  | "complete"
  | "failed"
  | "cancelled";

export type SourceKind = "photo" | "video" | "frame";
export type CompositeStyle = "faithful" | "polished";
export type CompositeAspect = "21:9" | "16:9" | "3:2" | "1:1";
export const COMPOSITE_ASPECTS: CompositeAspect[] = ["21:9", "16:9", "3:2", "1:1"];

export interface CompositeGroup {
  id: string;
  user_id: string;
  name: string;
  status: GroupStatus;
  scene_priority: string | null;
  must_preserve: string[];
  style: CompositeStyle;
  aspect_ratio: CompositeAspect;
  anchor_source_id: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompositeSource {
  id: string;
  group_id: string;
  user_id: string;
  kind: SourceKind;
  parent_source_id: string | null;
  original_name: string;
  mime_type: string;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  frame_time_s: number | null;
  sequence: number;
  // The original as uploaded; null when it was not stored (see `note`).
  storage_path: string | null;
  // The downscaled still the provider receives (photos and frames).
  reference_path: string | null;
  sharpness: number | null;
  phash: string | null;
  selected: boolean;
  pinned: boolean;
  status: "pending" | "uploaded" | "failed";
  note: string | null;
  created_at: string;
}

/** A user's pointer on the edit target, in 0–1 image coordinates. */
export interface MarkPoint {
  x: number;
  y: number;
}
export interface CorrectionMarks {
  // The element that is wrong; `r` is the circle radius as a fraction of width.
  what?: MarkPoint & { r: number };
  // Where that element should be (move mode only).
  where?: MarkPoint;
}
export type CorrectionMode = "text" | "area" | "move";

export interface CompositeJob {
  id: string;
  group_id: string;
  user_id: string;
  kind: "render" | "correction";
  target_version_id: string | null;
  mode: CorrectionMode | null;
  instruction: string | null;
  marks: CorrectionMarks | null;
  idempotency_key: string;
  status: JobStatus;
  provider: string;
  provider_model: string;
  provider_request_id: string | null;
  status_url: string | null;
  response_url: string | null;
  cancel_url: string | null;
  prompt: string;
  reference_source_ids: string[];
  options: {
    aspectRatio?: string;
    resolution?: string;
    prepPath?: string | null;
    // Storage paths of the provider inputs, re-signed on a resubmission.
    inputPaths?: string[];
    attempts?: number;
  };
  cost_credits: number;
  charged_at: string | null;
  refunded_at: string | null;
  lease_until: string | null;
  error: string | null;
  version_id: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ReviewStatus = "pending" | "passed" | "flagged" | "unavailable";

export type CheckId =
  | "duplicate_elements"
  | "seams"
  | "horizon"
  | "light_reflection"
  | "geometry"
  | "invented_content"
  | "correction_applied";

export interface ReviewCheck {
  id: CheckId;
  status: "pass" | "fail" | "uncertain";
  note: string;
}
export interface PreserveCheck {
  detail: string;
  status: "preserved" | "missing" | "uncertain";
  note: string;
}
export interface ReviewIssue {
  summary: string;
  severity: "high" | "medium" | "low";
  // Where the wrong element is and, for a misplaced element, where it belongs —
  // 0–1 image coordinates, so the UI can pre-fill a "move" correction.
  element: MarkPoint | null;
  target: MarkPoint | null;
  suggestedInstruction: string;
}
export interface CompositeReview {
  verdict: "pass" | "flag";
  checks: ReviewCheck[];
  mustPreserve: PreserveCheck[];
  issues: ReviewIssue[];
  model: string;
  reviewedAt: string;
  // Present when the review could not run; the version is then "unavailable".
  error?: string;
}

export interface CompositeVersion {
  id: string;
  group_id: string;
  user_id: string;
  job_id: string | null;
  parent_version_id: string | null;
  version_number: number;
  kind: "render" | "correction";
  prompt: string;
  instruction: string | null;
  reference_source_ids: string[];
  provider: string;
  provider_model: string;
  native_path: string;
  native_mime: string;
  native_width: number;
  native_height: number;
  native_bytes: number | null;
  preview_path: string;
  export_path: string | null;
  export_width: number | null;
  export_height: number | null;
  review_status: ReviewStatus;
  review: CompositeReview | null;
  created_at: string;
}
