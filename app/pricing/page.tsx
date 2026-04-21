import Link from "next/link";
import { Check, Sparkles } from "lucide-react";
import { CREDIT_PACKS, CREDIT_COSTS } from "@/types";
import { formatPrice } from "@/lib/utils";

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <nav className="border-b border-white/5 backdrop-blur-sm sticky top-0 z-50 bg-black/50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-400" />
            <span className="text-lg font-semibold">MyPix AI</span>
          </Link>
          <Link
            href="/login"
            className="text-sm bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            Get started
          </Link>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-24 text-center">
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          Simple credit pricing
        </h1>
        <p className="text-gray-400 text-lg mb-4">
          Buy credits once. Use them whenever. No subscription required.
        </p>
        <div className="inline-flex items-center gap-4 text-sm text-gray-500 mb-16">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-purple-400 rounded-full" />
            {CREDIT_COSTS.TRAINING} credits to train a model (~10 min)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-pink-400 rounded-full" />
            {CREDIT_COSTS.GENERATION} credit per generated photo
          </span>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {CREDIT_PACKS.map((pack) => (
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
                <span className="text-4xl font-bold">{formatPrice(pack.price)}</span>
                <span className="text-gray-500 ml-2">one-time</span>
              </div>

              <ul className="space-y-3 mb-8">
                {[
                  `${pack.credits} credits total`,
                  `${Math.floor(pack.credits / CREDIT_COSTS.TRAINING)} AI model${Math.floor(pack.credits / CREDIT_COSTS.TRAINING) > 1 ? "s" : ""}`,
                  `Up to ${pack.credits - CREDIT_COSTS.TRAINING * Math.floor(pack.credits / CREDIT_COSTS.TRAINING) + (Math.floor(pack.credits / CREDIT_COSTS.TRAINING) - 1) * CREDIT_COSTS.TRAINING} generated photos`,
                  "FLUX.1 photorealistic quality",
                  "Credits never expire",
                ].map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                    <span className="text-gray-300">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={`/login?next=/checkout/${pack.id}`}
                className={`block text-center py-3 px-6 rounded-xl font-medium transition-colors ${
                  pack.popular
                    ? "bg-purple-600 hover:bg-purple-500 text-white"
                    : "bg-white/10 hover:bg-white/15 text-white"
                }`}
              >
                Get {pack.name}
              </Link>
            </div>
          ))}
        </div>

        <p className="text-gray-600 text-sm mt-12">
          Questions? Email us at{" "}
          <a
            href="mailto:hello@mypix.ai"
            className="text-gray-400 hover:text-white"
          >
            hello@mypix.ai
          </a>
        </p>
      </div>
    </div>
  );
}
