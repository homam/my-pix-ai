"use client";

import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import {
  Loader2,
  UserRoundPen,
  Wand2,
  Expand,
  ImagePlus,
  Shirt,
  Download,
  X,
  Upload,
} from "lucide-react";
import type { Model, GeneratedImage, GarmentTune } from "@/types";
import { uploadFile } from "@/lib/uploadClient";
import { MaskCanvas } from "@/components/studio/MaskCanvas";

type Tool = "faceswap" | "inpaint" | "outpaint" | "restore" | "tryon";

const TOOLS: { id: Tool; label: string; icon: typeof Wand2; blurb: string }[] = [
  {
    id: "faceswap",
    label: "Face swap",
    icon: UserRoundPen,
    blurb: "Put yourself into any photo",
  },
  {
    id: "inpaint",
    label: "Background & objects",
    icon: Wand2,
    blurb: "Paint over anything to replace or remove it",
  },
  {
    id: "outpaint",
    label: "Uncrop",
    icon: Expand,
    blurb: "Expand a photo beyond its edges",
  },
  {
    id: "restore",
    label: "Restore old photo",
    icon: ImagePlus,
    blurb: "Repair and colorize old or damaged photos",
  },
  {
    id: "tryon",
    label: "Outfit try-on",
    icon: Shirt,
    blurb: "See yourself wearing any garment",
  },
];

const ACCEPTED = { "image/jpeg": [], "image/png": [], "image/webp": [] };

interface Props {
  models: Model[];
  garments: GarmentTune[];
  recentImages: GeneratedImage[];
  creditBalance: number;
  garmentCost: number;
  initialTool?: Tool;
  initialSourceUrl?: string;
}

/** Dropzone + recent-generations picker used by every tool that needs a source image. */
function SourcePicker({
  sourceUrl,
  onSource,
  recentImages,
  label,
}: {
  sourceUrl: string | null;
  onSource: (url: string, imageId?: string) => void;
  recentImages: GeneratedImage[];
  label: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setUploading(true);
      setError(null);
      try {
        const url = await uploadFile(file, file.name, "edit");
        onSource(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [onSource]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED,
    maxFiles: 1,
    disabled: uploading,
  });

  if (sourceUrl) {
    return (
      <div className="relative inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={sourceUrl}
          alt="Source"
          className="max-h-72 rounded-xl border border-white/10"
        />
        <button
          type="button"
          onClick={() => onSource("")}
          className="absolute -top-2 -right-2 bg-gray-900 border border-white/20 rounded-full p-1 text-gray-300 hover:text-white"
          title="Remove"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragActive
            ? "border-purple-500/60 bg-purple-500/5"
            : "border-white/10 hover:border-white/20"
        }`}
      >
        <input {...getInputProps()} />
        {uploading ? (
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-purple-400" />
        ) : (
          <>
            <Upload className="w-6 h-6 mx-auto mb-2 text-gray-500" />
            <p className="text-sm text-gray-400">{label}</p>
          </>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {recentImages.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-2">
            Or pick a recent generation
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {recentImages.map((img) => (
              <button
                key={img.id}
                type="button"
                onClick={() => onSource(img.url, img.id)}
                className="shrink-0 rounded-lg overflow-hidden border border-white/10 hover:border-purple-500/50 transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="h-20 w-20 object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSelect({
  models,
  value,
  onChange,
  allowNone,
}: {
  models: Model[];
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-purple-500/50"
    >
      {allowNone && <option value="">No model (generic fill)</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id} className="bg-gray-900">
          {m.name}
        </option>
      ))}
    </select>
  );
}

function ResultsGrid({ images }: { images: GeneratedImage[] }) {
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-6">
      {images.map((img) => (
        <div
          key={img.id}
          className="group relative rounded-xl overflow-hidden border border-white/10"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.url} alt={img.prompt} className="w-full object-cover" />
          <a
            href={img.url}
            download
            target="_blank"
            rel="noreferrer"
            className="absolute bottom-2 right-2 p-2 rounded-lg bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </a>
        </div>
      ))}
    </div>
  );
}

function SubmitButton({
  busy,
  disabled,
  cost,
  label,
}: {
  busy: boolean;
  disabled: boolean;
  cost: number;
  label: string;
}) {
  return (
    <button
      type="submit"
      disabled={disabled || busy}
      className="flex items-center justify-center gap-2 w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-4 py-3 text-sm font-medium transition-colors"
    >
      {busy ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          Working… (~30–60s)
        </>
      ) : (
        <>
          {label}
          <span className="text-purple-200/80">
            · {cost} credit{cost === 1 ? "" : "s"}
          </span>
        </>
      )}
    </button>
  );
}

export function StudioTools({
  models,
  garments: initialGarments,
  recentImages,
  creditBalance,
  garmentCost,
  initialTool,
  initialSourceUrl,
}: Props) {
  const [tool, setTool] = useState<Tool>(initialTool ?? "faceswap");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<GeneratedImage[]>([]);

  // Shared source image state (faceswap / inpaint / outpaint / restore).
  const [sourceUrl, setSourceUrl] = useState<string | null>(
    initialSourceUrl ?? null
  );
  const [sourceImageId, setSourceImageId] = useState<string | undefined>();

  // Per-tool state.
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [inpaintModelId, setInpaintModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [numImages, setNumImages] = useState(2);
  const [maskBlob, setMaskBlob] = useState<Blob | null>(null);
  const [outpaintRatio, setOutpaintRatio] = useState<"16:9" | "9:16" | "4:5" | "3:2">("16:9");
  const [colorize, setColorize] = useState(true);

  // Try-on state.
  const [garments, setGarments] = useState<GarmentTune[]>(initialGarments);
  const [garmentId, setGarmentId] = useState(initialGarments[0]?.id ?? "");
  const [garmentTitle, setGarmentTitle] = useState("");
  const [garmentUploading, setGarmentUploading] = useState(false);

  const onSource = useCallback((url: string, imageId?: string) => {
    setSourceUrl(url || null);
    setSourceImageId(imageId);
    setMaskBlob(null);
  }, []);

  function switchTool(t: Tool) {
    setTool(t);
    setError(null);
    setResults([]);
    setMaskBlob(null);
    setPrompt("");
  }

  // Poll pending garments so "training…" flips to ready without a refresh.
  useEffect(() => {
    if (!garments.some((g) => g.status === "pending")) return;
    const t = setInterval(async () => {
      const res = await fetch("/api/garments");
      if (!res.ok) return;
      const json = await res.json();
      setGarments(json.garments ?? []);
    }, 10_000);
    return () => clearInterval(t);
  }, [garments]);

  async function submitEdit(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setResults(json.images ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceUrl && tool !== "tryon") return;

    if (tool === "faceswap") {
      await submitEdit({
        mode: "faceswap",
        sourceUrl,
        sourceImageId,
        modelId,
        prompt: prompt.trim() || undefined,
        numImages,
      });
    } else if (tool === "inpaint") {
      if (!maskBlob) {
        setError("Paint over the area you want to change first");
        return;
      }
      setBusy(true);
      try {
        const maskUrl = await uploadFile(maskBlob, "mask.png", "edit");
        await submitEdit({
          mode: "inpaint",
          sourceUrl,
          sourceImageId,
          maskUrl,
          prompt: prompt.trim(),
          modelId: inpaintModelId || undefined,
          numImages,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Mask upload failed");
        setBusy(false);
      }
    } else if (tool === "outpaint") {
      const dims: Record<typeof outpaintRatio, [number, number]> = {
        "16:9": [1792, 1024],
        "9:16": [1024, 1792],
        "4:5": [1024, 1280],
        "3:2": [1536, 1024],
      };
      const [width, height] = dims[outpaintRatio];
      await submitEdit({
        mode: "outpaint",
        sourceUrl,
        sourceImageId,
        anchor: "center",
        width,
        height,
        prompt: prompt.trim() || undefined,
      });
    } else if (tool === "restore") {
      await submitEdit({
        mode: "restore",
        sourceUrl,
        sourceImageId,
        colorize,
        numImages: 1,
      });
    } else if (tool === "tryon") {
      await submitEdit({
        mode: "tryon",
        modelId,
        garmentId,
        prompt: prompt.trim() || undefined,
        numImages,
      });
    }
  }

  async function onGarmentDrop(files: File[]) {
    const file = files[0];
    if (!file) return;
    if (!garmentTitle.trim() || garmentTitle.trim().length < 2) {
      setError("Name the garment first (e.g. “red summer dress”)");
      return;
    }
    setGarmentUploading(true);
    setError(null);
    try {
      const imageUrl = await uploadFile(file, file.name, "garment");
      const res = await fetch("/api/garments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: garmentTitle.trim(), imageUrl }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Garment creation failed");
      setGarments((prev) => [json.garment, ...prev]);
      setGarmentId(json.garment.id);
      setGarmentTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Garment upload failed");
    } finally {
      setGarmentUploading(false);
    }
  }

  const garmentDropzone = useDropzone({
    onDrop: onGarmentDrop,
    accept: ACCEPTED,
    maxFiles: 1,
    disabled: garmentUploading,
    noClick: false,
  });

  const needsModel = tool === "faceswap" || tool === "tryon";
  const editCost = tool === "outpaint" || tool === "restore" ? 1 : numImages;
  const readyGarments = garments.filter((g) => g.status === "ready");
  const canSubmit =
    creditBalance >= editCost &&
    (tool === "tryon"
      ? !!modelId && !!garmentId && readyGarments.some((g) => g.id === garmentId)
      : !!sourceUrl) &&
    (!needsModel || !!modelId) &&
    (tool !== "inpaint" || prompt.trim().length >= 3);

  return (
    <div className="max-w-3xl">
      {/* Tool tabs */}
      <div className="flex gap-2 flex-wrap mb-8">
        {TOOLS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => switchTool(id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm border transition-colors ${
              tool === id
                ? "bg-purple-500/15 border-purple-500/40 text-purple-200"
                : "border-white/10 text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-400 mb-6">
        {TOOLS.find((t) => t.id === tool)?.blurb}
      </p>

      <form onSubmit={onSubmit} className="space-y-5">
        {/* Source image */}
        {tool !== "tryon" && (
          <SourcePicker
            sourceUrl={sourceUrl}
            onSource={onSource}
            recentImages={recentImages}
            label={
              tool === "restore"
                ? "Drop an old or damaged photo"
                : tool === "faceswap"
                  ? "Drop the photo you want to appear in"
                  : "Drop a photo to edit"
            }
          />
        )}

        {/* Inpaint mask */}
        {tool === "inpaint" && sourceUrl && (
          <MaskCanvas imageUrl={sourceUrl} onMaskChange={setMaskBlob} />
        )}

        {/* Model select */}
        {needsModel &&
          (models.length > 0 ? (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">
                {tool === "faceswap" ? "Whose face?" : "Who's wearing it?"}
              </label>
              <ModelSelect models={models} value={modelId} onChange={setModelId} />
            </div>
          ) : (
            <p className="text-sm text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
              You need a trained model for this tool — create one from the
              dashboard first.
            </p>
          ))}

        {tool === "inpaint" && models.length > 0 && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Person-aware fill (optional — pick your model if you&apos;re
              repainting yourself)
            </label>
            <ModelSelect
              models={models}
              value={inpaintModelId}
              onChange={setInpaintModelId}
              allowNone
            />
          </div>
        )}

        {/* Try-on garment manager */}
        {tool === "tryon" && (
          <div className="space-y-4">
            {garments.length > 0 && (
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">
                  Garment
                </label>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {garments.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => g.status === "ready" && setGarmentId(g.id)}
                      className={`shrink-0 rounded-lg overflow-hidden border-2 transition-colors relative ${
                        garmentId === g.id
                          ? "border-purple-500"
                          : "border-white/10 hover:border-white/30"
                      } ${g.status !== "ready" ? "opacity-50" : ""}`}
                      title={g.title}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={g.image_url}
                        alt={g.title}
                        className="h-24 w-24 object-cover"
                      />
                      {g.status === "pending" && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] text-gray-200">
                          preparing…
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
              <p className="text-xs text-gray-400">
                Add a garment ({garmentCost} credits) — a photo of someone
                wearing it works best
              </p>
              <input
                type="text"
                value={garmentTitle}
                onChange={(e) => setGarmentTitle(e.target.value)}
                placeholder="Garment name, e.g. red summer dress"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-purple-500/50"
              />
              <div
                {...garmentDropzone.getRootProps()}
                className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
                  garmentDropzone.isDragActive
                    ? "border-purple-500/60 bg-purple-500/5"
                    : "border-white/10 hover:border-white/20"
                }`}
              >
                <input {...garmentDropzone.getInputProps()} />
                {garmentUploading ? (
                  <Loader2 className="w-5 h-5 mx-auto animate-spin text-purple-400" />
                ) : (
                  <p className="text-xs text-gray-500">
                    Drop a garment photo here
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Prompt */}
        {tool !== "restore" && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              {tool === "inpaint"
                ? "What should replace the painted area?"
                : tool === "outpaint"
                  ? "What's beyond the edges? (optional)"
                  : tool === "tryon"
                    ? "Scene (optional)"
                    : "Scene tweaks (optional)"}
            </label>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                tool === "inpaint"
                  ? "e.g. a sunlit Tuscan vineyard / empty background"
                  : tool === "outpaint"
                    ? "e.g. a wide sandy beach"
                    : tool === "tryon"
                      ? "e.g. walking through Paris at golden hour"
                      : "e.g. smiling, golden hour light"
              }
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-purple-500/50"
            />
          </div>
        )}

        {/* Options row */}
        <div className="flex items-center gap-6 flex-wrap">
          {tool === "restore" && (
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={colorize}
                onChange={(e) => setColorize(e.target.checked)}
                className="accent-purple-500"
              />
              Colorize black &amp; white photos
            </label>
          )}
          {tool === "outpaint" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Expand to</span>
              {(["16:9", "9:16", "4:5", "3:2"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setOutpaintRatio(r)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                    outpaintRatio === r
                      ? "bg-purple-500/20 border-purple-500/40 text-purple-200"
                      : "border-white/10 text-gray-400 hover:text-white"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          {(tool === "faceswap" || tool === "inpaint" || tool === "tryon") && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Variations</span>
              {[1, 2, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setNumImages(n)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                    numImages === n
                      ? "bg-purple-500/20 border-purple-500/40 text-purple-200"
                      : "border-white/10 text-gray-400 hover:text-white"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
            {error}
          </p>
        )}

        <SubmitButton
          busy={busy}
          disabled={!canSubmit}
          cost={editCost}
          label={TOOLS.find((t) => t.id === tool)?.label ?? "Run"}
        />
        {creditBalance < editCost && (
          <p className="text-xs text-amber-300/90">
            Not enough credits — you have {creditBalance}.
          </p>
        )}
      </form>

      <ResultsGrid images={results} />
    </div>
  );
}
