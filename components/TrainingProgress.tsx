"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, CheckCircle2, Circle } from "lucide-react";

// Astria FLUX LoRA training typically lands in 8–14 min; we anchor the
// progress bar at 12 min. The bar caps at 95% so it doesn't claim "done"
// before the model status actually flips.
const TARGET_DURATION_MS = 12 * 60_000;
const REFRESH_INTERVAL_MS = 20_000;

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function TrainingProgress({
  modelId,
  startedAt,
}: {
  modelId: string;
  // ISO string. Falls back to render time if not provided (legacy callers).
  startedAt?: string | null;
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick once a second so the elapsed clock and progress bar stay live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const start = startedAt ? new Date(startedAt).getTime() : now;
  const elapsedMs = Math.max(0, now - start);
  const rawPercent = Math.min(95, (elapsedMs / TARGET_DURATION_MS) * 100);
  const percent = Math.max(2, rawPercent); // give the bar visible thickness immediately

  // Phase markers — purely UX heuristic based on elapsed time.
  // Astria doesn't give granular sub-status, so this is a confidence bar.
  const phases = [
    { id: "queued", label: "Queued", reachedAtMs: 0 },
    { id: "training", label: "Training LoRA", reachedAtMs: 30_000 },
    { id: "finalizing", label: "Finalizing", reachedAtMs: 9 * 60_000 },
  ];

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/models/${modelId}/refresh`, {
        method: "POST",
      });
      if (res.ok) {
        const { status } = await res.json();
        setLastChecked(new Date());
        if (status === "ready" || status === "failed") {
          router.refresh();
        }
      }
    } finally {
      setRefreshing(false);
    }
  }

  // Auto-refresh while training. eslint-disable: refresh closes over `modelId`
  // which is stable for the lifetime of this component.
  useEffect(() => {
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  return (
    <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold mb-1">Training in progress</h2>
          <p className="text-sm text-gray-400">
            Elapsed {formatElapsed(elapsedMs)} · target ~12 minutes. You can
            close this tab — we&apos;ll keep training in the background.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          Check now
        </button>
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="h-2 bg-white/5 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-[width] duration-1000 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{Math.round(percent)}%</span>
          <span>
            {lastChecked
              ? `Last checked ${lastChecked.toLocaleTimeString()}`
              : "Auto-checking every 20s"}
          </span>
        </div>
      </div>

      {/* Phase markers */}
      <div className="flex items-center justify-between text-xs">
        {phases.map((p) => {
          const reached = elapsedMs >= p.reachedAtMs;
          return (
            <div
              key={p.id}
              className={`flex items-center gap-1.5 ${
                reached ? "text-blue-300" : "text-gray-600"
              }`}
            >
              {reached ? (
                <CheckCircle2 className="w-3.5 h-3.5" />
              ) : (
                <Circle className="w-3.5 h-3.5" />
              )}
              <span>{p.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
