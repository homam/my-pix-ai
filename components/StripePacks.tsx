"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { CreditPack, CREDIT_COSTS } from "@/types";
import { formatPrice } from "@/lib/utils";

export function StripePacks({ packs }: { packs: CreditPack[] }) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleBuy(packId: string) {
    setLoadingId(packId);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = "/login?next=/pricing";
          return;
        }
        const { error } = await res.json();
        throw new Error(error ?? "Checkout failed");
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoadingId(null);
    }
  }

  return (
    <>
      <div className="grid md:grid-cols-3 gap-6">
        {packs.map((pack) => {
          const models = Math.floor(pack.credits / CREDIT_COSTS.TRAINING);
          const photos = pack.credits - models * CREDIT_COSTS.TRAINING;
          return (
            <div
              key={pack.id}
              className={`relative rounded-2xl p-8 border text-left ${
                pack.popular
                  ? "border-purple-500 bg-purple-500/5"
                  : "border-white/10 bg-white/3"
              }`}
            >
              {pack.popular && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-purple-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                  Most popular
                </div>
              )}
              <div className="mb-6">
                <h3 className="text-xl font-semibold mb-1">{pack.name}</h3>
                <p className="text-gray-500 text-sm">{pack.description}</p>
              </div>

              <div className="mb-6">
                <span className="text-4xl font-bold">
                  {formatPrice(pack.price)}
                </span>
                <span className="text-gray-500 ml-2">one-time</span>
              </div>

              <ul className="space-y-3 mb-8">
                {[
                  `${pack.credits} credits total`,
                  `${models} AI model${models !== 1 ? "s" : ""}`,
                  `Up to ${photos + models * CREDIT_COSTS.TRAINING - CREDIT_COSTS.TRAINING} generated photos`,
                  "FLUX.1 photorealistic quality",
                  "Credits never expire",
                ].map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                    <span className="text-gray-300">{feature}</span>
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handleBuy(pack.id)}
                disabled={loadingId !== null}
                className={`w-full inline-flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-medium transition-colors disabled:opacity-50 ${
                  pack.popular
                    ? "bg-purple-600 hover:bg-purple-500 text-white"
                    : "bg-white/10 hover:bg-white/15 text-white"
                }`}
              >
                {loadingId === pack.id && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                Get {pack.name}
              </button>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-6 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 inline-block">
          {error}
        </p>
      )}
    </>
  );
}
