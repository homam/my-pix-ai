"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { Upload, X, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { CREDIT_COSTS } from "@/types";
import { EngineOption, type Engine } from "@/components/EngineOption";
import { uploadTrainingPhotos } from "@/lib/photoUpload";

const MIN_PHOTOS = 10;
const MAX_PHOTOS = 30;
const ACCEPTED_TYPES = { "image/jpeg": [], "image/png": [], "image/webp": [] };

type PhotoSource = "reuse" | "new";
type Phase = "idle" | "uploading" | "starting" | "done";

interface Picked {
  file: File;
  preview: string;
}

/**
 * Retrain an existing model: re-roll on the same photos, upload a fresh set,
 * and/or switch engine (Standard ↔ Ultra). Posts to /api/models/[id]/retry,
 * which flips the model to `training`; we refresh so the page shows progress.
 */
export function RetrainPanel({
  modelId,
  currentProvider,
  storedPhotoCount,
  ultraAvailable,
  creditBalance,
}: {
  modelId: string;
  currentProvider: Engine;
  storedPhotoCount: number;
  ultraAvailable: boolean;
  creditBalance: number;
}) {
  const router = useRouter();
  const canReuse = storedPhotoCount >= MIN_PHOTOS;

  const [engine, setEngine] = useState<Engine>(currentProvider);
  const [source, setSource] = useState<PhotoSource>(canReuse ? "reuse" : "new");
  const [files, setFiles] = useState<Picked[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const submitting = phase !== "idle" && phase !== "done";

  const onDrop = useCallback((accepted: File[]) => {
    setFiles((prev) =>
      [
        ...prev,
        ...accepted.map((file) => ({
          file,
          preview: URL.createObjectURL(file),
        })),
      ].slice(0, MAX_PHOTOS)
    );
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxFiles: MAX_PHOTOS,
    disabled: submitting,
  });

  function removeFile(idx: number) {
    setFiles((prev) => {
      URL.revokeObjectURL(prev[idx].preview);
      return prev.filter((_, i) => i !== idx);
    });
  }

  const enoughNew = files.length >= MIN_PHOTOS;
  const canSubmit =
    !submitting &&
    creditBalance >= CREDIT_COSTS.TRAINING &&
    (source === "reuse" ? canReuse : enoughNew);

  const switching = engine !== currentProvider;

  async function handleSubmit() {
    setError(null);

    if (creditBalance < CREDIT_COSTS.TRAINING) {
      setError(`Retraining costs ${CREDIT_COSTS.TRAINING} credits. You have ${creditBalance}.`);
      return;
    }

    try {
      let imageUrls: string[] | undefined;

      if (source === "new") {
        if (files.length < MIN_PHOTOS) {
          setError(`Upload at least ${MIN_PHOTOS} photos.`);
          return;
        }
        setPhase("uploading");
        setProgress({ done: 0, total: files.length });
        const { urls, errors } = await uploadTrainingPhotos(
          modelId,
          files.map((f) => f.file),
          { onProgress: (done, total) => setProgress({ done, total }) }
        );
        if (urls.length < MIN_PHOTOS) {
          setPhase("idle");
          setError(
            `Only ${urls.length} of ${files.length} photos uploaded${
              errors.length ? ` (${errors[0]})` : ""
            }. Need at least ${MIN_PHOTOS} — try again.`
          );
          return;
        }
        imageUrls = urls;
      }

      setPhase("starting");
      const res = await fetch(`/api/models/${modelId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: engine,
          ...(imageUrls ? { imageUrls } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          `${json.error ?? "Failed to start retraining"}${
            json.reqId ? ` [reqId: ${json.reqId}]` : ""
          }`
        );
      }

      setPhase("done");
      // Model is now `training` — refresh so the page swaps to the progress UI.
      router.refresh();
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="space-y-5">
      {/* Engine picker — only when the Ultra engine is enabled on this server. */}
      {ultraAvailable && (
        <div>
          <label className="block text-sm font-medium mb-2">Engine</label>
          <div className="grid grid-cols-2 gap-3">
            <EngineOption
              selected={engine === "astria"}
              disabled={submitting}
              onSelect={() => setEngine("astria")}
              title="Standard"
              subtitle="Fast, high-quality results. Ready in minutes."
            />
            <EngineOption
              selected={engine === "fal"}
              disabled={submitting}
              onSelect={() => setEngine("fal")}
              title="Ultra"
              subtitle="Our newest engine — maximum realism. Takes a bit longer."
              badge="New"
            />
          </div>
          {switching && (
            <p className="text-xs text-amber-300/80 mt-2">
              Switching engine retrains this person from scratch on the new engine.
            </p>
          )}
        </div>
      )}

      {/* Photo source */}
      <div>
        <label className="block text-sm font-medium mb-2">Photos</label>
        <div className="space-y-2">
          <SourceRadio
            checked={source === "reuse"}
            disabled={!canReuse || submitting}
            onChange={() => setSource("reuse")}
            title="Reuse current photos"
            subtitle={
              canReuse
                ? `Retrain on the ${storedPhotoCount} photo${storedPhotoCount === 1 ? "" : "s"} already uploaded.`
                : "No stored photos available — upload a new set."
            }
          />
          <SourceRadio
            checked={source === "new"}
            disabled={submitting}
            onChange={() => setSource("new")}
            title="Upload new photos"
            subtitle="Replace the set with fresh photos, then retrain."
          />
        </div>
      </div>

      {/* New-photo dropzone */}
      {source === "new" && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">
              {files.length}/{MAX_PHOTOS} selected
            </span>
            <span
              className={`text-xs ${enoughNew ? "text-green-400" : "text-gray-500"}`}
            >
              {enoughNew ? `✓ ready` : `${MIN_PHOTOS - files.length} more needed`}
            </span>
          </div>
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              isDragActive
                ? "border-purple-500 bg-purple-500/5"
                : "border-white/10 hover:border-purple-500/50 hover:bg-white/3"
            } ${submitting ? "opacity-50 pointer-events-none" : ""}`}
          >
            <input {...getInputProps()} />
            <Upload className="w-6 h-6 text-gray-500 mx-auto mb-2" />
            <p className="text-sm text-gray-400">
              {isDragActive ? "Drop photos here…" : "Drag & drop or click to select"}
            </p>
            <p className="text-xs text-gray-600 mt-1">
              JPG, PNG, WebP · {MIN_PHOTOS}–{MAX_PHOTOS} photos
            </p>
          </div>

          {files.length > 0 && (
            <div className="grid grid-cols-6 gap-2 mt-3">
              {files.map((f, i) => (
                <div
                  key={i}
                  className="relative aspect-square rounded-lg overflow-hidden bg-gray-900 group"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.preview}
                    alt={f.file.name}
                    className="w-full h-full object-cover"
                  />
                  {!submitting && (
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3 text-white" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-gray-500">
          Costs {CREDIT_COSTS.TRAINING} credits · You have {creditBalance}
        </p>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          {phase === "uploading"
            ? `Uploading ${progress.done}/${progress.total}…`
            : phase === "starting"
              ? "Starting…"
              : phase === "done"
                ? "Started!"
                : "Retrain"}
        </button>
      </div>
    </div>
  );
}

function SourceRadio({
  checked,
  disabled,
  onChange,
  title,
  subtitle,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      aria-pressed={checked}
      className={`w-full text-left rounded-xl border p-3 flex items-start gap-3 transition-colors disabled:cursor-not-allowed ${
        checked
          ? "border-purple-500 bg-purple-500/10"
          : "border-white/10 hover:border-purple-500/40 hover:bg-white/3"
      } ${disabled && !checked ? "opacity-50" : ""}`}
    >
      <span
        className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
          checked ? "border-purple-400" : "border-gray-500"
        }`}
      >
        {checked && <span className="w-2 h-2 rounded-full bg-purple-400" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{title}</span>
        <span className="block text-xs text-gray-400">{subtitle}</span>
      </span>
    </button>
  );
}
