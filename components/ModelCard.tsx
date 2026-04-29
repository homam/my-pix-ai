import Link from "next/link";
import { Model } from "@/types";
import { ModelStatusBadge } from "./ModelStatusBadge";
import { ModelThumbs } from "./ModelThumbs";
import { Images } from "lucide-react";

export function ModelCard({
  model,
  thumbnailUrls = [],
}: {
  model: Model;
  thumbnailUrls?: string[];
}) {
  return (
    <Link
      href={`/models/${model.id}`}
      className="group block bg-white/3 border border-white/8 rounded-2xl p-6 hover:border-purple-500/30 hover:bg-white/5 transition-all"
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
  );
}
