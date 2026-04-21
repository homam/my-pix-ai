import Link from "next/link";
import { Sparkles } from "lucide-react";
import { CREDIT_PACKS, CREDIT_COSTS } from "@/types";
import { isStripeConfigured } from "@/lib/stripe";
import { StripePacks } from "@/components/StripePacks";
import { DevGrantButton } from "@/components/DevGrantButton";

export default function PricingPage() {
  const stripeOn = isStripeConfigured();

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

      {stripeOn ? (
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

          <StripePacks packs={CREDIT_PACKS} />

          <p className="text-gray-600 text-sm mt-12">
            Questions?{" "}
            <a
              href="mailto:hello@mypix.ai"
              className="text-gray-400 hover:text-white"
            >
              hello@mypix.ai
            </a>
          </p>
        </div>
      ) : (
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <div className="inline-flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 rounded-full px-4 py-1.5 text-sm text-yellow-300 mb-8">
            Dev mode — payments not configured
          </div>

          <h1 className="text-4xl md:text-5xl font-bold mb-4">Credits</h1>
          <p className="text-gray-400 text-lg mb-10">
            Stripe isn&apos;t set up on this deployment. Grant yourself test
            credits below, or set{" "}
            <code className="text-gray-300">STRIPE_SECRET_KEY</code> and the
            price IDs to enable checkout.
          </p>

          <DevGrantButton />

          <p className="text-xs text-gray-600 mt-12">
            New users start with 1000 free credits. Training a model costs{" "}
            {CREDIT_COSTS.TRAINING} credits; generating an image costs{" "}
            {CREDIT_COSTS.GENERATION}.
          </p>
        </div>
      )}
    </div>
  );
}
