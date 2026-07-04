import Link from "next/link";
import { Model } from "@/types";
import { ModelStatusBadge } from "./ModelStatusBadge";
import { ModelThumbs } from "./ModelThumbs";
import { RetryTrainingButton } from "./RetryTrainingButton";
import { Images } from "lucide-react";

export function ModelCard({
  model,
  thumbnailUrls = [],
}: {
  model: Model;
  thumbnailUrls?: string[];
}) {
  // failed / expired models can be retrained in place from the stored photos
  // (same photos, new tune). Surface that action right on the card.
  const needsRetrain = model.status === "failed" || model.status === "expired";

  // Tint the card border by status so the list telegraphs state at a glance.
  const statusBorder =
    model.status === "expired"
      ? "border-amber-500/25"
      : model.status === "failed"
        ? "border-red-500/25"
        : "border-white/8";

  return (
    <div
      className={`group relative bg-white/3 border ${statusBorder} rounded-2xl p-6 transition-all hover:border-brand-500/30 hover:bg-white/5`}
    >
      {/* Stretched link: the whole card navigates to the model, but it stays a
          real <a href> (cmd/ctrl/middle-click open a new tab, right-click offers
          "copy link"). The Retrain button below sits above the ::after overlay
          (relative z-10), so it keeps its own click instead of navigating. */}
      <Link
        href={`/models/${model.id}`}
        className="after:absolute after:inset-0 after:rounded-2xl after:content-['']"
      >
        <div className="mb-4">
          {model.cover_image_url ? (
            <div className="aspect-video bg-white/5 rounded-xl overflow-hidden flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={model.cover_image_url}
                alt={model.name}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            </div>
          ) : thumbnailUrls.length > 0 ? (
            <ModelThumbs urls={thumbnailUrls} limit={5} size="sm" />
          ) : (
            <div className="aspect-video bg-white/5 rounded-xl flex items-center justify-center">
              <Images className="w-8 h-8 text-gray-600" />
            </div>
          )}
        </div>

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-semibold truncate">{model.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(model.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
          <ModelStatusBadge status={model.status} />
        </div>
      </Link>

      {needsRetrain && (
        <div className="relative z-10 mt-4">
          {model.status === "expired" && (
            <p className="text-xs text-amber-300/80 mb-2">
              Training data expired — retrain to generate again (20 credits).
            </p>
          )}
          <RetryTrainingButton
            modelId={model.id}
            label={model.status === "expired" ? "Retrain model" : "Retry training"}
            size="sm"
            fullWidth
          />
        </div>
      )}
    </div>
  );
}
