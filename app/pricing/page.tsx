"use client";

import Link from "next/link";
import { Sparkles, Coins, Loader2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function PricingPage() {
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
    <div className="min-h-screen bg-[#0a0a0a]">
      <nav className="border-b border-white/5 backdrop-blur-sm sticky top-0 z-50 bg-black/50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-400" />
            <span className="text-lg font-semibold">MyPix AI</span>
          </Link>
          <Link
            href="/dashboard"
            className="text-sm bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            Dashboard
          </Link>
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <div className="inline-flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 rounded-full px-4 py-1.5 text-sm text-yellow-300 mb-8">
          <Coins className="w-4 h-4" />
          Dev mode — no payments
        </div>

        <h1 className="text-4xl md:text-5xl font-bold mb-4">Credits</h1>
        <p className="text-gray-400 text-lg mb-10">
          Stripe isn&apos;t wired up in this build. Click below to grant
          yourself 500 test credits instantly.
        </p>

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

        {message && (
          <p className="mt-6 text-sm text-green-400">{message}</p>
        )}

        <p className="text-xs text-gray-600 mt-12">
          New users start with 1000 free credits. Training a model costs 20
          credits; generating an image costs 1.
        </p>
      </div>
    </div>
  );
}
