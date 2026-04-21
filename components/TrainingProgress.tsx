"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function TrainingProgress({ modelId }: { modelId: string }) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

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

  // Auto-refresh every 20 seconds while training
  useEffect(() => {
    const id = setInterval(refresh, 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  return (
    <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-8 text-center">
      <div className="w-12 h-12 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
      <h2 className="text-lg font-medium mb-2">Training in progress</h2>
      <p className="text-gray-400 text-sm mb-6">
        This usually takes 10–15 minutes. You can leave this page and come
        back — we check status automatically.
      </p>
      <button
        onClick={refresh}
        disabled={refreshing}
        className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
      >
        <RefreshCw
          className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
        />
        Check status now
      </button>
      {lastChecked && (
        <p className="text-xs text-gray-500 mt-3">
          Last checked {lastChecked.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
