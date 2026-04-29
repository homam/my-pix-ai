"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { useRouter } from "next/navigation";
import {
  Upload,
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Clock,
} from "lucide-react";
import { CREDIT_COSTS } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { STORAGE_BUCKET } from "@/lib/storage";

const MIN_PHOTOS = 10;
const MAX_PHOTOS = 30;
const ACCEPTED_TYPES = { "image/jpeg": [], "image/png": [], "image/webp": [] };
const UPLOAD_CONCURRENCY = 4;

type FileStatus = "queued" | "uploading" | "uploaded" | "failed";

interface UploadedFile {
  file: File;
  preview: string;
  publicUrl?: string;
  status: FileStatus;
  error?: string;
}

type Phase =
  | "idle"
  | "creating-model"
  | "uploading"
  | "starting-training"
  | "done";

export function NewModelForm({ creditBalance }: { creditBalance: number }) {
  const router = useRouter();
  const [modelName, setModelName] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const submitting = phase !== "idle" && phase !== "done";

  const onDrop = useCallback((accepted: File[]) => {
    const newFiles: UploadedFile[] = accepted
      .slice(0, MAX_PHOTOS)
      .map((file) => ({
        file,
        preview: URL.createObjectURL(file),
        status: "queued",
      }));
    setFiles((prev) => [...prev, ...newFiles].slice(0, MAX_PHOTOS));
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

  function setStatus(idx: number, patch: Partial<UploadedFile>) {
    setFiles((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, ...patch } : f))
    );
  }

  // Upload a single file via signed URL. Returns its public URL on success.
  async function uploadOne(
    modelId: string,
    f: UploadedFile,
    idx: number,
    supabase: ReturnType<typeof createClient>
  ): Promise<string> {
    setStatus(idx, { status: "uploading", error: undefined });

    const upRes = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: f.file.name,
        contentType: f.file.type,
        modelId,
      }),
    });
    const upJson = await upRes.json().catch(() => ({}));
    if (!upRes.ok) {
      throw new Error(
        upJson.error ?? `Upload URL request failed (${upRes.status})`
      );
    }
    const { path, token, publicUrl } = upJson;

    const { error: upErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .uploadToSignedUrl(path, token, f.file, { contentType: f.file.type });
    if (upErr) throw new Error(upErr.message);

    setStatus(idx, { status: "uploaded", publicUrl });
    return publicUrl as string;
  }

  // Drive a queue of indices through `uploadOne` with a concurrency cap.
  // Returns the publicUrl per index (sparse array) and any errors collected.
  async function runUploads(
    modelId: string,
    indices: number[],
    snapshot: UploadedFile[]
  ): Promise<{ urls: Map<number, string>; errors: string[] }> {
    const supabase = createClient();
    const urls = new Map<number, string>();
    const errors: string[] = [];
    let next = 0;

    async function worker() {
      while (next < indices.length) {
        const i = next++;
        const fileIdx = indices[i];
        try {
          const url = await uploadOne(
            modelId,
            snapshot[fileIdx],
            fileIdx,
            supabase
          );
          urls.set(fileIdx, url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Upload failed";
          setStatus(fileIdx, { status: "failed", error: msg });
          errors.push(`${snapshot[fileIdx].file.name}: ${msg}`);
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(UPLOAD_CONCURRENCY, indices.length) },
        worker
      )
    );
    return { urls, errors };
  }

  async function retryFailed() {
    if (!draftModelId) return;
    setError(null);
    const failedIdx = files
      .map((f, i) => (f.status === "failed" ? i : -1))
      .filter((i) => i >= 0);
    if (failedIdx.length === 0) return;
    setPhase("uploading");
    const { errors } = await runUploads(draftModelId, failedIdx, files);
    setPhase("idle");
    if (errors.length > 0) {
      setError(
        `${errors.length} photo${
          errors.length === 1 ? "" : "s"
        } still failing — check the photos and try again, or remove and re-add them.`
      );
    }
  }

  const [draftModelId, setDraftModelId] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length < MIN_PHOTOS) {
      setError(`Please upload at least ${MIN_PHOTOS} photos.`);
      return;
    }
    if (!modelName.trim()) {
      setError("Please give your model a name.");
      return;
    }

    setError(null);

    try {
      // 1. Create model record (or reuse if user is retrying after a failure).
      let modelId = draftModelId;
      if (!modelId) {
        setPhase("creating-model");
        const modelRes = await fetch("/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: modelName.trim() }),
        });
        const modelJson = await modelRes.json().catch(() => ({}));
        if (!modelRes.ok) {
          throw new Error(
            `Failed to create model record (${modelRes.status}): ${
              modelJson.error ?? "unknown"
            } [reqId: ${modelJson.reqId ?? "?"}]`
          );
        }
        modelId = modelJson.model.id as string;
        setDraftModelId(modelId);
      }

      // 2. Upload all not-yet-uploaded files in parallel.
      setPhase("uploading");
      const snapshot = files;
      const queuedIdx = snapshot
        .map((f, i) => (f.status !== "uploaded" ? i : -1))
        .filter((i) => i >= 0);
      const { urls: newUrls, errors } = await runUploads(
        modelId,
        queuedIdx,
        snapshot
      );

      // Merge previously-uploaded URLs (from earlier attempts) with this run.
      const allUrls: string[] = [];
      for (let i = 0; i < snapshot.length; i++) {
        const fresh = newUrls.get(i);
        const previous = snapshot[i].publicUrl;
        if (fresh) allUrls.push(fresh);
        else if (previous && snapshot[i].status === "uploaded")
          allUrls.push(previous);
      }

      if (errors.length > 0) {
        // Drop back to idle so the retry buttons render and the user can click
        // "Resume training" once they've fixed the failures.
        setPhase("idle");
        setError(
          `${errors.length} photo${
            errors.length === 1 ? "" : "s"
          } failed to upload. Use the retry button on the failed photos, then click "Resume training".`
        );
        return;
      }

      if (allUrls.length < MIN_PHOTOS) {
        throw new Error(
          `Only ${allUrls.length} photos uploaded — need at least ${MIN_PHOTOS}.`
        );
      }

      // 3. Start training.
      setPhase("starting-training");
      const trainRes = await fetch("/api/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId,
          imageUrls: allUrls,
          modelName: modelName.trim(),
        }),
      });
      const trainJson = await trainRes.json().catch(() => ({}));
      if (!trainRes.ok) {
        throw new Error(
          `${trainJson.error ?? "Training failed to start"} [reqId: ${
            trainJson.reqId ?? "?"
          }]`
        );
      }

      setPhase("done");
      setTimeout(() => router.push(`/models/${modelId}`), 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setPhase("idle");
    }
  }

  if (phase === "done") {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle className="w-16 h-16 text-green-400 mb-4" />
        <h2 className="text-xl font-semibold mb-2">Training started!</h2>
        <p className="text-gray-400 text-sm">
          Your model is in the queue. We&apos;ll show progress on the next page —
          redirecting…
        </p>
      </div>
    );
  }

  // ---- Counts + step copy for the progress banner ----
  const total = files.length;
  const uploaded = files.filter((f) => f.status === "uploaded").length;
  const uploading = files.filter((f) => f.status === "uploading").length;
  const failed = files.filter((f) => f.status === "failed").length;

  let stepCopy = "";
  let stepNumber: 1 | 2 | 3 = 1;
  let percent = 0;

  if (phase === "creating-model") {
    stepNumber = 1;
    stepCopy = "Creating your model record…";
    percent = 5;
  } else if (phase === "uploading") {
    stepNumber = 2;
    stepCopy = `Uploading photos · ${uploaded} of ${total}${
      failed ? ` · ${failed} failed` : ""
    }${uploading ? ` · ${uploading} in flight` : ""}`;
    // Phase 1 is ~5%, phase 2 spans 5%→90%, phase 3 is the final 10%.
    percent = 5 + (uploaded / Math.max(total, 1)) * 85;
  } else if (phase === "starting-training") {
    stepNumber = 3;
    stepCopy = "Starting training on Astria…";
    percent = 95;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Phase banner */}
      {submitting && (
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-purple-200">
              Step {stepNumber} of 3
            </span>
            <span className="text-xs text-purple-300/70">{stepCopy}</span>
          </div>
          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 transition-all duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Model name */}
      <div>
        <label htmlFor="name" className="block text-sm font-medium mb-2">
          Model name
        </label>
        <input
          id="name"
          type="text"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          placeholder="e.g. My Professional Headshots"
          disabled={submitting}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors disabled:opacity-50"
        />
      </div>

      {/* Dropzone */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium">
            Photos ({total}/{MAX_PHOTOS})
          </label>
          <span
            className={`text-xs ${
              total >= MIN_PHOTOS ? "text-green-400" : "text-gray-500"
            }`}
          >
            {total >= MIN_PHOTOS
              ? `✓ ${total} photos ready`
              : `${MIN_PHOTOS - total} more needed`}
          </span>
        </div>

        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? "border-purple-500 bg-purple-500/5"
              : "border-white/10 hover:border-purple-500/50 hover:bg-white/3"
          } ${submitting ? "opacity-50 cursor-not-allowed pointer-events-none" : ""}`}
        >
          <input {...getInputProps()} />
          <Upload className="w-8 h-8 text-gray-500 mx-auto mb-3" />
          <p className="text-sm text-gray-400">
            {isDragActive
              ? "Drop photos here…"
              : "Drag & drop or click to select photos"}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            JPG, PNG, WebP · {MIN_PHOTOS}–{MAX_PHOTOS} photos · 1024×1024+
            recommended
          </p>
        </div>
      </div>

      {/* Photo grid */}
      {total > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {files.map((f, i) => (
            <PhotoTile
              key={i}
              file={f}
              onRemove={() => removeFile(i)}
              onRetry={retryFailed}
              canEdit={!submitting}
              showRetry={f.status === "failed" && !!draftModelId}
            />
          ))}
        </div>
      )}

      {/* Tips */}
      <div className="bg-white/3 border border-white/8 rounded-xl p-4 text-xs text-gray-500 space-y-1">
        <p className="font-medium text-gray-400 mb-2">Tips for best results:</p>
        <p>• Use varied angles: front, 3/4 profile, side</p>
        <p>• Include different lighting conditions and backgrounds</p>
        <p>• Avoid sunglasses or face obstructions</p>
        <p>• No other people in the frame</p>
        <p>• Sharp, well-exposed photos only</p>
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-gray-500">
          Costs {CREDIT_COSTS.TRAINING} credits · You have {creditBalance}
        </p>
        <button
          type="submit"
          disabled={submitting || total < MIN_PHOTOS || !modelName.trim()}
          className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-medium transition-colors"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting
            ? phase === "creating-model"
              ? "Setting up…"
              : phase === "uploading"
                ? `Uploading ${uploaded}/${total}…`
                : "Starting training…"
            : draftModelId
              ? "Resume training"
              : "Start training"}
        </button>
      </div>
    </form>
  );
}

function PhotoTile({
  file,
  onRemove,
  onRetry,
  canEdit,
  showRetry,
}: {
  file: UploadedFile;
  onRemove: () => void;
  onRetry: () => void;
  canEdit: boolean;
  showRetry: boolean;
}) {
  return (
    <div className="relative aspect-square rounded-lg overflow-hidden bg-gray-900 group">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={file.preview}
        alt={file.file.name}
        className={`w-full h-full object-cover transition-opacity ${
          file.status === "queued" ? "opacity-60" : ""
        }`}
      />

      {/* Status overlay */}
      {file.status === "queued" && (
        <div className="absolute top-1 left-1 bg-black/60 backdrop-blur-sm rounded px-1.5 py-0.5 flex items-center gap-1">
          <Clock className="w-3 h-3 text-gray-300" />
          <span className="text-[10px] text-gray-300">Queued</span>
        </div>
      )}
      {file.status === "uploading" && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-white animate-spin" />
        </div>
      )}
      {file.status === "uploaded" && (
        <div className="absolute top-1 left-1 bg-green-500/90 backdrop-blur-sm rounded-full w-5 h-5 flex items-center justify-center">
          <CheckCircle className="w-3.5 h-3.5 text-white" />
        </div>
      )}
      {file.status === "failed" && (
        <div className="absolute inset-0 bg-red-500/30 flex flex-col items-center justify-center gap-1.5 p-1">
          <AlertCircle className="w-5 h-5 text-red-300" />
          {showRetry && (
            <button
              type="button"
              onClick={onRetry}
              title={file.error ?? "Retry"}
              className="inline-flex items-center gap-1 bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded px-1.5 py-0.5 text-[10px] text-white"
            >
              <RotateCcw className="w-3 h-3" /> Retry
            </button>
          )}
        </div>
      )}

      {/* Remove (only when not uploading or after fail/before submit) */}
      {canEdit && file.status !== "uploading" && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3 text-white" />
        </button>
      )}
    </div>
  );
}
