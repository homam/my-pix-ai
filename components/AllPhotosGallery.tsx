"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Download,
  Trash2,
  Wand2,
  X,
  Loader2,
  Images,
} from "lucide-react";
import type { GeneratedImage, ImageKind, Model } from "@/types";

const KIND_LABELS: Record<ImageKind, string> = {
  generation: "Generations",
  faceswap: "Face swaps",
  inpaint: "Edits",
  outpaint: "Uncrops",
  restore: "Restorations",
  tryon: "Try-ons",
};

interface Props {
  images: GeneratedImage[];
  models: Pick<Model, "id" | "name">[];
}

export function AllPhotosGallery({ images: initialImages, models }: Props) {
  const [images, setImages] = useState(initialImages);
  const [filter, setFilter] = useState<ImageKind | "all">("all");
  const [detail, setDetail] = useState<GeneratedImage | null>(null);
  const [deleting, setDeleting] = useState(false);

  const modelNames = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models]
  );

  // Only offer chips for kinds that actually exist in the library.
  const presentKinds = useMemo(() => {
    const kinds = new Set<ImageKind>();
    for (const img of images) kinds.add(img.kind ?? "generation");
    return (Object.keys(KIND_LABELS) as ImageKind[]).filter((k) =>
      kinds.has(k)
    );
  }, [images]);

  const visible =
    filter === "all"
      ? images
      : images.filter((img) => (img.kind ?? "generation") === filter);

  async function deleteImage(img: GeneratedImage) {
    if (!confirm("Delete this photo? This can't be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/images/${img.id}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: null }));
        throw new Error(error ?? "Delete failed");
      }
      setImages((prev) => prev.filter((i) => i.id !== img.id));
      setDetail(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  if (images.length === 0) {
    return (
      <div className="bg-white/5 border border-white/10 rounded-xl p-12 text-center">
        <Images className="w-8 h-8 mx-auto mb-3 text-gray-600" />
        <p className="text-gray-400 text-sm">
          No photos yet. Generate some from a model, or try the{" "}
          <Link href="/studio" className="text-brand-400 hover:text-brand-300">
            Studio
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Kind filter — only shown when there's more than one kind */}
      {presentKinds.length > 1 && (
        <div className="flex gap-2 flex-wrap mb-6">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
              filter === "all"
                ? "bg-brand-500/20 border-brand-500/40 text-brand-200"
                : "border-white/10 text-gray-400 hover:text-white"
            }`}
          >
            All ({images.length})
          </button>
          {presentKinds.map((k) => {
            const count = images.filter(
              (i) => (i.kind ?? "generation") === k
            ).length;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                  filter === k
                    ? "bg-brand-500/20 border-brand-500/40 text-brand-200"
                    : "border-white/10 text-gray-400 hover:text-white"
                }`}
              >
                {KIND_LABELS[k]} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {visible.map((img) => (
          <button
            key={img.id}
            type="button"
            onClick={() => setDetail(img)}
            className="group relative rounded-xl overflow-hidden border border-white/10 hover:border-brand-500/40 transition-colors text-left"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url}
              alt={img.prompt}
              loading="lazy"
              className="w-full aspect-square object-cover"
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <p className="text-[11px] text-gray-200 line-clamp-2">
                {img.prompt}
              </p>
            </div>
          </button>
        ))}
      </div>

      {/* Detail modal */}
      {detail && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="bg-[#111] border border-white/10 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={detail.url}
                alt={detail.prompt}
                className="w-full rounded-t-2xl"
              />
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="absolute top-3 right-3 p-2 rounded-lg bg-black/60 text-gray-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <p className="text-sm text-gray-200">{detail.prompt}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {KIND_LABELS[detail.kind ?? "generation"]}
                  {detail.model_id && modelNames.has(detail.model_id) && (
                    <> · {modelNames.get(detail.model_id)}</>
                  )}
                  {" · "}
                  {new Date(detail.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {detail.model_id && (
                  <Link
                    href={`/models/${detail.model_id}`}
                    className="flex-1 inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                  >
                    Open model
                  </Link>
                )}
                <Link
                  href={`/studio?tool=inpaint&src=${encodeURIComponent(detail.url)}`}
                  className="inline-flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                  title="Edit in Studio"
                >
                  <Wand2 className="w-4 h-4" />
                  Edit
                </Link>
                <a
                  href={detail.url}
                  download
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </a>
                <button
                  type="button"
                  onClick={() => deleteImage(detail)}
                  disabled={deleting}
                  className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 transition-colors disabled:opacity-50"
                  title="Delete"
                >
                  {deleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
