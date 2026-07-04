"use client";

import { useState } from "react";
import { Loader2, Coins, Sparkles, X } from "lucide-react";
import { GeneratedImage } from "@/types";
import { PROMPT_PACKS, PromptPack, packImageCount } from "@/lib/packs";

interface Props {
  modelId: string;
  balance: number;
  creditCost: number;
  /** Disable starting a pack while the main generate form is busy. */
  busy?: boolean;
  /** Prepend freshly generated images to the gallery. */
  onImages: (images: GeneratedImage[]) => void;
  /** Decrement the displayed balance by the number of credits actually spent. */
  onSpend: (credits: number) => void;
}

const CONCURRENCY = 3;

export function PackPicker({
  modelId,
  balance,
  creditCost,
  busy,
  onImages,
  onSpend,
}: Props) {
  const [pending, setPending] = useState<PromptPack | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [result, setResult] = useState<string | null>(null);

  async function generateOne(pack: PromptPack, prompt: string): Promise<number> {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId,
        prompt,
        numImages: pack.imagesPerPrompt,
        realism: pack.defaults.realism,
        aspectRatio: pack.defaults.aspectRatio,
        filmGrain: pack.defaults.filmGrain,
        faceCorrect: pack.defaults.faceCorrect,
        superResolution: pack.defaults.superResolution,
        variety: false,
        seed: null,
      }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "" }));
      throw new Error(error || "Generation failed");
    }
    const { images } = (await res.json()) as { images: GeneratedImage[] };
    if (images.length > 0) {
      onImages(images);
      onSpend(images.length * creditCost);
    }
    return images.length;
  }

  async function runPack(pack: PromptPack) {
    setPending(null);
    setRunningId(pack.id);
    setResult(null);
    const total = pack.prompts.length;
    setProgress({ done: 0, total });

    const queue = [...pack.prompts];
    let done = 0;
    let failed = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const prompt = queue.shift();
        if (prompt === undefined) break;
        try {
          await generateOne(pack, prompt);
        } catch {
          failed++;
        } finally {
          done++;
          setProgress({ done, total });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    );

    setRunningId(null);
    setProgress(null);
    setResult(
      failed === 0
        ? `Done — ${pack.name} pack generated.`
        : `${pack.name} pack finished with ${failed} of ${total} prompt${
            total === 1 ? "" : "s"
          } failed (those credits were refunded).`
    );
  }

  const anyRunning = runningId !== null;

  return (
    <div className="bg-white/3 border border-white/8 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold">One-click packs</h2>
        {result && <span className="text-xs text-gray-400">{result}</span>}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Generate a whole themed set at once. Each photo costs {creditCost} credit
        {creditCost === 1 ? "" : "s"}.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {PROMPT_PACKS.map((pack) => {
          const cost = packImageCount(pack) * creditCost;
          const isThisRunning = runningId === pack.id;
          const tooExpensive = cost > balance;
          const disabled = busy || anyRunning || tooExpensive;
          return (
            <button
              key={pack.id}
              type="button"
              onClick={() => setPending(pack)}
              disabled={disabled}
              className="text-left bg-white/5 border border-white/10 rounded-xl p-4 hover:border-brand-500/40 hover:bg-white/8 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">{pack.emoji}</span>
                <span className="font-medium text-sm">{pack.name}</span>
              </div>
              <p className="text-xs text-gray-500 mb-3 line-clamp-2">{pack.blurb}</p>
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1 text-gray-400">
                  <Coins className="w-3.5 h-3.5" />
                  {cost} credits · {packImageCount(pack)} photos
                </span>
                {isThisRunning && progress && (
                  <span className="inline-flex items-center gap-1 text-brand-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {progress.done}/{progress.total}
                  </span>
                )}
                {tooExpensive && !isThisRunning && (
                  <span className="text-gray-600">Not enough credits</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {pending && (
        <ConfirmPackModal
          pack={pending}
          cost={packImageCount(pending) * creditCost}
          onCancel={() => setPending(null)}
          onConfirm={() => runPack(pending)}
        />
      )}
    </div>
  );
}

function ConfirmPackModal({
  pack,
  cost,
  onCancel,
  onConfirm,
}: {
  pack: PromptPack;
  cost: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-neutral-900 border border-white/10 rounded-2xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{pack.emoji}</span>
            <div>
              <h3 className="font-semibold">{pack.name}</h3>
              <p className="text-xs text-gray-500">{pack.blurb}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-300 mb-4">
          This generates{" "}
          <strong>
            {packImageCount(pack)} photo{packImageCount(pack) === 1 ? "" : "s"}
          </strong>{" "}
          for <strong>{cost} credits</strong> across {pack.prompts.length} scene
          {pack.prompts.length === 1 ? "" : "s"}. They&apos;ll appear in your gallery
          as they finish.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Generate pack
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
