"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Coins, Loader2 } from "lucide-react";

export function DevGrantButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function grant() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/dev/grant-credits", { method: "POST" });
      if (res.ok) {
        const { granted } = await res.json();
        setMessage(`+${granted} credits added to your account.`);
        router.refresh();
      } else if (res.status === 401) {
        window.location.href = "/login";
      } else {
        setMessage("Grant endpoint disabled.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={grant}
        disabled={loading}
        className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white px-8 py-4 rounded-xl text-lg font-medium transition-colors"
      >
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Coins className="w-5 h-5" />
        )}
        Grant me 500 credits
      </button>
      {message && <p className="mt-6 text-sm text-green-400">{message}</p>}
    </>
  );
}
