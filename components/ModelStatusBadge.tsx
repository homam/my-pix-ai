import { ModelStatus } from "@/types";

const config: Partial<Record<ModelStatus, { label: string; className: string }>> = {
  pending: {
    label: "Pending",
    className: "bg-gray-500/15 text-gray-400 border-gray-500/20",
  },
  training: {
    label: "Training…",
    className: "bg-blue-500/15 text-blue-300 border-blue-500/20",
  },
  ready: {
    label: "Ready",
    className: "bg-green-500/15 text-green-300 border-green-500/20",
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/15 text-red-300 border-red-500/20",
  },
  expired: {
    label: "Expired",
    className: "bg-amber-500/15 text-amber-300 border-amber-500/20",
  },
};

export function ModelStatusBadge({ status }: { status: ModelStatus }) {
  // Fall back to a neutral badge for any unknown status so a value the running
  // build doesn't recognize (e.g. a newer status added in the DB before a
  // deploy) never crashes the page that renders it.
  const { label, className } = config[status] ?? {
    label: status
      ? String(status).charAt(0).toUpperCase() + String(status).slice(1)
      : "Unknown",
    className: "bg-gray-500/15 text-gray-400 border-gray-500/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 border rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {status === "training" && (
        <span className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-pulse" />
      )}
      {label}
    </span>
  );
}
