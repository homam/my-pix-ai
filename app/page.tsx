import Link from "next/link";
import { ArrowRight, Camera, Sparkles, Zap, Shield, Star } from "lucide-react";

const SAMPLE_IMAGES = [
  "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400&h=500&fit=crop",
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=500&fit=crop",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=500&fit=crop",
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&h=500&fit=crop",
];

const SCENARIOS = [
  "Professional headshot in a NYC office",
  "On a yacht in the Mediterranean",
  "Magazine cover in Paris fashion week",
  "Astronaut floating in space",
  "CEO portrait for Forbes cover",
  "On a beach in Bali at sunset",
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Nav */}
      <nav className="border-b border-white/5 backdrop-blur-sm sticky top-0 z-50 bg-black/50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-400" />
            <span className="text-lg font-semibold">MyPix AI</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/pricing"
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Login
            </Link>
            <Link
              href="/login"
              className="text-sm bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Get started free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 bg-purple-500/10 border border-purple-500/20 rounded-full px-4 py-1.5 text-sm text-purple-300 mb-8">
          <Zap className="w-3.5 h-3.5" />
          Powered by FLUX.1 — state-of-the-art photorealism
        </div>

        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 text-balance">
          Your AI photo studio,{" "}
          <span className="gradient-text">trained on you</span>
        </h1>

        <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10 text-balance">
          Upload 15–25 photos. We train a personal AI model on your likeness in
          under 15 minutes. Then generate photorealistic photos of yourself in
          any scenario, outfit, or style — forever.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-4">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-8 py-4 rounded-xl text-lg font-medium transition-colors glow"
          >
            Create your AI model
            <ArrowRight className="w-5 h-5" />
          </Link>
          <Link
            href="/pricing"
            className="inline-flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white px-8 py-4 rounded-xl text-lg font-medium transition-colors"
          >
            View pricing
          </Link>
        </div>
        <p className="text-sm text-gray-500">
          First model free. No subscription required.
        </p>
      </section>

      {/* Sample image grid */}
      <section className="max-w-7xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {SAMPLE_IMAGES.map((src, i) => (
            <div
              key={i}
              className="aspect-[4/5] rounded-2xl overflow-hidden bg-gray-900 relative group"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`Sample AI photo ${i + 1}`}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute bottom-3 left-3 right-3 bg-black/60 backdrop-blur-sm rounded-lg px-3 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-xs text-white truncate">{SCENARIOS[i]}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-white/5 py-24">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
            How it works
          </h2>
          <p className="text-gray-400 text-center mb-16">
            Three steps. Fifteen minutes. Infinite photos.
          </p>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: Camera,
                step: "01",
                title: "Upload your photos",
                desc: "Upload 15–25 clear, varied photos of your face. Different angles, lighting, and expressions work best.",
              },
              {
                icon: Zap,
                step: "02",
                title: "We train your model",
                desc: "Our FLUX.1 fine-tuning pipeline trains a personal AI model that captures your exact likeness in ~10 minutes.",
              },
              {
                icon: Sparkles,
                step: "03",
                title: "Generate anything",
                desc: "Pick a scenario or write your own prompt. Generate photorealistic photos of yourself anywhere, in anything.",
              },
            ].map(({ icon: Icon, step, title, desc }) => (
              <div
                key={step}
                className="bg-white/3 border border-white/5 rounded-2xl p-8 hover:border-purple-500/30 transition-colors"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-purple-500/15 rounded-xl flex items-center justify-center">
                    <Icon className="w-5 h-5 text-purple-400" />
                  </div>
                  <span className="text-sm font-mono text-purple-400">
                    {step}
                  </span>
                </div>
                <h3 className="text-xl font-semibold mb-2">{title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Scenario examples */}
      <section className="py-24">
        <div className="max-w-7xl mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
            Any scenario. Any style.
          </h2>
          <p className="text-gray-400 text-center mb-16">
            From professional headshots to fantasy worlds — generate it all.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            {[
              "Professional LinkedIn headshot",
              "Astronaut on Mars",
              "Renaissance oil painting",
              "CEO for Forbes cover",
              "Fantasy warrior",
              "Beach vacation in Maldives",
              "NYC fashion shoot",
              "Cyberpunk city at night",
              "Wedding portrait",
              "Action movie poster",
              "Vintage 1950s style",
              "Underwater photographer",
            ].map((scenario) => (
              <span
                key={scenario}
                className="bg-white/5 border border-white/10 rounded-full px-4 py-2 text-sm text-gray-300"
              >
                {scenario}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Trust signals */}
      <section className="border-t border-white/5 py-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-8 text-center">
            {[
              {
                icon: Shield,
                title: "Privacy first",
                desc: "Your photos are encrypted at rest. We never use your images to train shared models. Delete your data anytime.",
              },
              {
                icon: Zap,
                title: "Fast turnaround",
                desc: "Models train in 10–15 minutes. Image generation completes in under 30 seconds.",
              },
              {
                icon: Star,
                title: "State-of-the-art quality",
                desc: "Built on FLUX.1 — the same model powering the best AI photo services in the world.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex flex-col items-center">
                <div className="w-12 h-12 bg-purple-500/15 rounded-2xl flex items-center justify-center mb-4">
                  <Icon className="w-6 h-6 text-purple-400" />
                </div>
                <h3 className="font-semibold mb-2">{title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Ready to see yourself{" "}
            <span className="gradient-text">everywhere?</span>
          </h2>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-10 py-4 rounded-xl text-lg font-medium transition-colors"
          >
            Start for free
            <ArrowRight className="w-5 h-5" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-500">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span>MyPix AI</span>
          </div>
          <div className="flex gap-6">
            <Link href="/privacy" className="hover:text-gray-300 transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-gray-300 transition-colors">
              Terms
            </Link>
            <Link href="/pricing" className="hover:text-gray-300 transition-colors">
              Pricing
            </Link>
          </div>
          <p>© 2026 MyPix AI. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
