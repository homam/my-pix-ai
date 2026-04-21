import Link from "next/link";
import { Model } from "@/types";
import { ModelStatusBadge } from "./ModelStatusBadge";
import { Images } from "lucide-react";

export function ModelCard({ model }: { model: Model }) {
  return (
    <Link
      href={`/models/${model.id}`}
      className="group block bg-white/3 border border-white/8 rounded-2xl p-6 hover:border-purple-500/30 hover:bg-white/5 transition-all"
    >
      {/* Cover image or placeholder */}
      <div className="aspect-video bg-white/5 rounded-xl mb-4 overflow-hidden flex items-center justify-center">
        {model.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={model.cover_image_url}
            alt={model.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <Images className="w-8 h-8 text-gray-600" />
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
