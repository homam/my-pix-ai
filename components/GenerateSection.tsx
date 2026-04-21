"use client";

import { useState } from "react";
import { Sparkles, Loader2, Download, Coins } from "lucide-react";
import { Model, GeneratedImage } from "@/types";

const PRESET_PROMPTS = [
  "Professional LinkedIn headshot, studio lighting, business attire",
  "Magazine cover editorial shoot, high fashion, dramatic lighting",
  "Casual portrait in a coffee shop, natural light, candid",
  "Corporate CEO portrait, modern office background",
  "Beach vacation, golden hour, relaxed and happy",
  "Fantasy warrior with armor in an epic landscape",
  "Astronaut in space with Earth in the background",
  "Renaissance oil painting style portrait",
  "Black and white artistic portrait, high contrast",
  "Street style fashion photography, urban background",
];

interface Props {
  model: Model;
  generatedImages: GeneratedImage[];
  creditBalance: number;
  creditCost: number;
}

export function GenerateSection({
  model,
  generatedImages: initialImages,
  creditBalance,
  creditCost,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [numImages, setNumImages] = useState(4);
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>(initialImages);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState(creditBalance);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;

    setGenerating(true);
    setError(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          prompt: prompt.trim(),
          numImages,
        }),
      });

      if (!res.ok) {
        const { error } = await res.json();
        throw new Error(error ?? "Generation failed");
      }

      const { images: newImages } = await res.json();
      setImages((prev) => [...newImages, ...prev]);
      setBalance((b) => b - numImages * creditCost);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Generate form */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-6">
        <h2 className="font-semibold mb-4">Generate photos</h2>

        <form onSubmit={handleGenerate} className="space-y-4">
          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Describe the photo you want
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Professional headshot in a modern office, business casual attire, warm lighting"
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors resize-none"
            />
          </div>

          {/* Preset prompts */}
          <div>
            <p className="text-xs text-gray-500 mb-2">Quick presets:</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrompt(p)}
                  className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5 text-gray-400 hover:text-white transition-colors"
                >
                  {p.split(",")[0]}
                </button>
              ))}
            </div>
          </div>

          {/* Num images */}
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium shrink-0">
              Number of photos:
            </label>
            {[1, 2, 4, 8].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setNumImages(n)}
                className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                  numImages === n
                    ? "bg-purple-600 text-white"
                    : "bg-white/5 text-gray-400 hover:bg-white/10"
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-sm text-gray-500">
              <Coins className="w-4 h-4" />
              <span>
                {numImages * creditCost} credit{numImages > 1 ? "s" : ""} ·{" "}
                {balance} remaining
              </span>
            </div>
            <button
              type="submit"
              disabled={generating || !prompt.trim() || balance < numImages}
              className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Generated images grid */}
      {images.length > 0 && (
        <div>
          <h2 className="font-semibold mb-4">
            Generated photos ({images.length})
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {images.map((img) => (
              <GeneratedImageCard key={img.id} image={img} />
            ))}
          </div>
        </div>
      )}

      {images.length === 0 && !generating && (
        <div className="text-center py-12 text-gray-600 text-sm">
          Your generated photos will appear here.
        </div>
      )}

      {/* Generating placeholders */}
      {generating && (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: numImages }).map((_, i) => (
              <div
                key={i}
                className="aspect-square rounded-xl bg-white/5 border border-white/8 animate-pulse"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GeneratedImageCard({ image }: { image: GeneratedImage }) {
  return (
    <div className="group relative aspect-square rounded-xl overflow-hidden bg-gray-900">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url}
        alt={image.prompt}
        className="w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-end p-3 opacity-0 group-hover:opacity-100">
        <div className="flex items-center justify-between w-full">
          <p className="text-xs text-white truncate flex-1 mr-2">
            {image.prompt}
          </p>
          <a
            href={image.url}
            download
            target="_blank"
            rel="noreferrer"
            className="shrink-0 w-8 h-8 bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-lg flex items-center justify-center transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="w-4 h-4 text-white" />
          </a>
        </div>
      </div>
    </div>
  );
}
