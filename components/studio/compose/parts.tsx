"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Download,
  Film,
  Loader2,
  Star,
  XCircle,
} from "lucide-react";
import { nativeLabel, upscaledLabel, type ExportPlan } from "@/lib/composite/dimensions";
import { versionMediaUrl } from "@/lib/composite/client/api";
import type {
  CompositeReview,
  GroupStatus,
  JobStatus,
  ReviewIssue,
  ReviewStatus,
} from "@/lib/composite/types";
import type { SelectionNote } from "@/lib/composite/selection";

const STATUS: Record<GroupStatus | JobStatus, { label: string; tone: string; spin?: boolean }> = {
  draft: { label: "Draft", tone: "text-gray-400 border-white/10" },
  uploading: { label: "Uploading", tone: "text-sky-300 border-sky-500/30", spin: true },
  preparing: { label: "Preparing video", tone: "text-sky-300 border-sky-500/30", spin: true },
  ready_to_generate: { label: "Ready", tone: "text-gray-300 border-white/20" },
  queued: { label: "Queued", tone: "text-amber-300 border-amber-500/30", spin: true },
  generating: { label: "Rendering", tone: "text-brand-300 border-brand-500/40", spin: true },
  review: { label: "Checking result", tone: "text-brand-300 border-brand-500/40", spin: true },
  complete: { label: "Done", tone: "text-emerald-300 border-emerald-500/30" },
  failed: { label: "Failed", tone: "text-red-300 border-red-500/30" },
  cancelled: { label: "Cancelled", tone: "text-gray-400 border-white/10" },
};

export function StatusBadge({ status }: { status: GroupStatus | JobStatus }) {
  const s = STATUS[status] ?? STATUS.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] ${s.tone}`}>
      {s.spin && <Loader2 className="w-3 h-3 animate-spin" />}
      {s.label}
    </span>
  );
}

const NOTE_LABEL: Record<SelectionNote["kind"], string> = {
  anchor: "Anchor",
  kept: "Kept by you",
  auto: "Auto-picked",
  duplicate: "Near-duplicate",
  soft: "Soft / blurry",
  over_limit: "Over the limit",
};

export function SourceTile({
  url,
  label,
  sublabel,
  isFrame,
  selected,
  anchor,
  note,
  disabled,
  busy,
  onToggle,
  onAnchor,
}: {
  url: string | null;
  label: string;
  sublabel?: string;
  isFrame?: boolean;
  selected: boolean;
  anchor: boolean;
  note?: SelectionNote;
  disabled?: boolean;
  busy?: boolean;
  onToggle?: () => void;
  onAnchor?: () => void;
}) {
  const dim = note && (note.kind === "duplicate" || note.kind === "soft" || note.kind === "over_limit");
  return (
    <div
      className={`relative rounded-lg overflow-hidden transition-shadow ${
        anchor ? "ring-2 ring-brand-400" : selected ? "ring-2 ring-brand-500/70" : "ring-1 ring-white/10"
      } ${!selected ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || !onToggle}
        className="block w-full text-left disabled:cursor-default"
        title={selected ? "Click to leave this out" : "Click to include this"}
      >
        <div className="aspect-[3/4] bg-black/40">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={label} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
            </div>
          )}
        </div>
        <div className="px-1.5 py-1 bg-black/70">
          <p className="text-[10px] text-gray-200 truncate flex items-center gap-1">
            {isFrame && <Film className="w-3 h-3 shrink-0 text-sky-300" />}
            {label}
          </p>
          {sublabel && <p className="text-[10px] text-gray-500 truncate">{sublabel}</p>}
        </div>
      </button>
      {busy && (
        <span className="absolute top-1 left-1 bg-black/70 rounded px-1 py-0.5">
          <Loader2 className="w-3 h-3 animate-spin text-gray-300" />
        </span>
      )}
      {onAnchor && (
        <button
          type="button"
          onClick={onAnchor}
          disabled={disabled}
          className={`absolute top-1 right-1 p-1 rounded-md bg-black/70 ${
            anchor ? "text-brand-300" : "text-gray-400 hover:text-white"
          }`}
          title={anchor ? "Anchor — the composite is built around this one" : "Make this the anchor"}
        >
          <Star className="w-3.5 h-3.5" fill={anchor ? "currentColor" : "none"} />
        </button>
      )}
      {note && note.kind !== "auto" && (
        <span
          className={`absolute bottom-10 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/75 ${
            dim ? "text-amber-300" : "text-brand-200"
          }`}
        >
          {NOTE_LABEL[note.kind]}
        </span>
      )}
    </div>
  );
}

const CHECK_LABEL: Record<string, string> = {
  duplicate_elements: "Nothing duplicated (sun, wings, landmarks)",
  seams: "No visible seams",
  horizon: "Continuous horizon / waterline",
  light_reflection: "Light and reflections agree",
  geometry: "Foreground geometry",
  invented_content: "Nothing invented",
  correction_applied: "Correction applied, nothing else changed",
};

function CheckIcon({ status }: { status: string }) {
  if (status === "pass" || status === "preserved") return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
  if (status === "fail" || status === "missing") return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
  return <CircleHelp className="w-4 h-4 text-amber-300 shrink-0" />;
}

export function ReviewPanel({
  status,
  review,
  onFix,
}: {
  status: ReviewStatus;
  review: CompositeReview | null;
  onFix?: (issue: ReviewIssue) => void;
}) {
  if (status === "pending") {
    return (
      <div className="text-sm text-gray-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking the result against your photos…
      </div>
    );
  }
  if (status === "unavailable" || !review) {
    return (
      <p className="text-sm text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
        The automatic check could not run{review?.error ? ` (${review.error})` : ""}. Look closely at the
        sun and its reflection, the horizon, and anything that might appear twice before you use it.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p
        className={`text-sm flex items-center gap-2 ${
          status === "passed" ? "text-emerald-300" : "text-amber-300"
        }`}
      >
        {status === "passed" ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
        {status === "passed"
          ? "Automatic check passed"
          : "Automatic check flagged something — review before using it"}
      </p>
      {review.issues.some((i) => i.summary.trim()) && (
        <ul className="space-y-2">
          {review.issues.filter((i) => i.summary.trim()).map((issue, i) => (
            <li key={i} className="bg-white/5 border border-white/10 rounded-xl p-3 text-sm">
              <p className="text-gray-200">
                <span
                  className={`text-[10px] uppercase tracking-wide mr-2 ${
                    issue.severity === "high" ? "text-red-300" : issue.severity === "medium" ? "text-amber-300" : "text-gray-400"
                  }`}
                >
                  {issue.severity}
                </span>
                {issue.summary}
              </p>
              {onFix && (
                <button
                  type="button"
                  onClick={() => onFix(issue)}
                  className="mt-2 text-xs text-brand-300 hover:text-brand-200"
                >
                  Fix this →
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {review.mustPreserve.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-1">Details you asked to keep</p>
          <ul className="space-y-1">
            {review.mustPreserve.map((p, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                <CheckIcon status={p.status} />
                <span>
                  “{p.detail}” — {p.status}
                  {p.note ? <span className="text-gray-500"> · {p.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.checks.length > 0 && (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer select-none">All checks</summary>
          <ul className="mt-2 space-y-1">
            {review.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <CheckIcon status={c.status} />
                <span>
                  {CHECK_LABEL[c.id] ?? c.id}
                  {c.note ? <span className="text-gray-500"> · {c.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Both files, with dimensions shown BEFORE download and the export labelled. */
export function DownloadLinks({ versionId, plan }: { versionId: string; plan: ExportPlan }) {
  const up = upscaledLabel(plan);
  return (
    <div className="space-y-2">
      <a
        href={versionMediaUrl(versionId, "native", true)}
        className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-3 py-2 text-sm"
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>
          Download native render
          <span className="block text-[11px] text-gray-400">{nativeLabel(plan)}</span>
        </span>
      </a>
      {up && (
        <a
          href={versionMediaUrl(versionId, "upscaled", true)}
          className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-3 py-2 text-sm"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span>
            Download 4K-size export (upscaled)
            <span className="block text-[11px] text-amber-300/80">{up}</span>
          </span>
        </a>
      )}
    </div>
  );
}
