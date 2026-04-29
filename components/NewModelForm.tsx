"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { useRouter } from "next/navigation";
import { Upload, X, Loader2, CheckCircle } from "lucide-react";
import { CREDIT_COSTS } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { STORAGE_BUCKET } from "@/lib/storage";

const MIN_PHOTOS = 10;
const MAX_PHOTOS = 30;
const ACCEPTED_TYPES = { "image/jpeg": [], "image/png": [], "image/webp": [] };

interface UploadedFile {
  file: File;
  preview: string;
  publicUrl?: string;
  uploaded: boolean;
}

export function NewModelForm({ creditBalance }: { creditBalance: number }) {
  const router = useRouter();
  const [modelName, setModelName] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [step, setStep] = useState<"upload" | "submitting" | "done">("upload");
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback((accepted: File[]) => {
    const newFiles = accepted.slice(0, MAX_PHOTOS).map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      uploaded: false,
    }));
    setFiles((prev) => {
      const combined = [...prev, ...newFiles].slice(0, MAX_PHOTOS);
      return combined;
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxFiles: MAX_PHOTOS,
    disabled: step !== "upload",
  });

  function removeFile(idx: number) {
    setFiles((prev) => {
      URL.revokeObjectURL(prev[idx].preview);
      return prev.filter((_, i) => i !== idx);
    });
  }

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
    setStep("submitting");

    const clientReqId = Math.random().toString(36).slice(2, 10);
    console.log("[new-model]", clientReqId, "submit_started", {
      fileCount: files.length,
      modelName: modelName.trim(),
    });

    try {
      // 1. Create model record
      const modelRes = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName.trim() }),
      });
      const modelJson = await modelRes.json().catch(() => ({}));
      console.log("[new-model]", clientReqId, "create_model_response", {
        status: modelRes.status,
        body: modelJson,
      });
      if (!modelRes.ok) {
        throw new Error(
          `Failed to create model record (${modelRes.status}): ${
            modelJson.error ?? "unknown"
          } [reqId: ${modelJson.reqId ?? "?"}]`
        );
      }
      const { model } = modelJson;

      // 2. Upload each photo directly to Supabase Storage via signed upload URL
      const supabase = createClient();
      const publicUrls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const upRes = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: f.file.name,
            contentType: f.file.type,
            modelId: model.id,
          }),
        });
        const upJson = await upRes.json().catch(() => ({}));
        console.log("[new-model]", clientReqId, "upload_url_response", {
          index: i,
          filename: f.file.name,
          status: upRes.status,
          body: upJson,
        });
        if (!upRes.ok) {
          throw new Error(
            `Failed to get upload URL for ${f.file.name} (${upRes.status}): ${
              upJson.error ?? "unknown"
            } [reqId: ${upJson.reqId ?? "?"}]`
          );
        }
        const { path, token, publicUrl } = upJson;

        const { error: upErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .uploadToSignedUrl(path, token, f.file, {
            contentType: f.file.type,
          });
        if (upErr) {
          console.error("[new-model]", clientReqId, "upload_failed", {
            index: i,
            filename: f.file.name,
            path,
            error: upErr,
          });
          throw new Error(`Upload failed for ${f.file.name}: ${upErr.message}`);
        }
        console.log("[new-model]", clientReqId, "upload_success", {
          index: i,
          filename: f.file.name,
          publicUrl,
        });

        publicUrls.push(publicUrl);
      }

      // 3. Start training
      console.log("[new-model]", clientReqId, "train_request_start", {
        modelId: model.id,
        imageCount: publicUrls.length,
      });
      const trainRes = await fetch("/api/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          imageUrls: publicUrls,
          modelName: modelName.trim(),
        }),
      });

      const trainJson = await trainRes.json().catch(() => ({}));
      console.log("[new-model]", clientReqId, "train_response", {
        status: trainRes.status,
        body: trainJson,
      });

      if (!trainRes.ok) {
        throw new Error(
          `${trainJson.error ?? "Training failed to start"} [reqId: ${
            trainJson.reqId ?? "?"
          }]`
        );
      }

      setStep("done");
      setTimeout(() => router.push(`/models/${model.id}`), 1500);
    } catch (err) {
      console.error("[new-model]", clientReqId, "flow_failed", err);
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(`${msg} (clientReqId: ${clientReqId})`);
      setStep("upload");
    }
  }

  if (step === "done") {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle className="w-16 h-16 text-green-400 mb-4" />
        <h2 className="text-xl font-semibold mb-2">Training started!</h2>
        <p className="text-gray-400 text-sm">
          Your model is in the queue. You&apos;ll get an email when it&apos;s
          ready (~10 minutes). Redirecting…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
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
          disabled={step !== "upload"}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-colors disabled:opacity-50"
        />
      </div>

      {/* Dropzone */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium">
            Photos ({files.length}/{MAX_PHOTOS})
          </label>
          <span
            className={`text-xs ${files.length >= MIN_PHOTOS ? "text-green-400" : "text-gray-500"}`}
          >
            {files.length >= MIN_PHOTOS
              ? `✓ ${files.length} photos ready`
              : `${MIN_PHOTOS - files.length} more needed`}
          </span>
        </div>

        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? "border-purple-500 bg-purple-500/5"
              : "border-white/10 hover:border-purple-500/50 hover:bg-white/3"
          } ${step !== "upload" ? "opacity-50 cursor-not-allowed pointer-events-none" : ""}`}
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
      {files.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {files.map((f, i) => (
            <div
              key={i}
              className="relative aspect-square rounded-lg overflow-hidden bg-gray-900 group"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.preview}
                alt={`Photo ${i + 1}`}
                className="w-full h-full object-cover"
              />
              {step === "upload" && (
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
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-gray-500">
          Costs {CREDIT_COSTS.TRAINING} credits · You have {creditBalance}
        </p>
        <button
          type="submit"
          disabled={
            step !== "upload" ||
            files.length < MIN_PHOTOS ||
            !modelName.trim()
          }
          className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-medium transition-colors"
        >
          {step === "submitting" && (
            <Loader2 className="w-4 h-4 animate-spin" />
          )}
          {step === "submitting" ? "Uploading & training…" : "Start training"}
        </button>
      </div>
    </form>
  );
}
