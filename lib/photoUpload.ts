// Client-side helper for uploading a training photo directly to Supabase
// Storage via a signed URL (no bytes pass through our server). Shared by the
// new-model form and the retrain panel.

import { createClient } from "@/lib/supabase/client";
import { STORAGE_BUCKET } from "@/lib/storage";

/**
 * Requests a signed upload URL for `file` under the model's folder, PUTs the
 * file to Storage, and returns its public URL. Throws on any failure.
 */
export async function uploadTrainingPhoto(
  modelId: string,
  file: File
): Promise<string> {
  const upRes = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      purpose: "training",
      modelId,
    }),
  });
  const upJson = await upRes.json().catch(() => ({}));
  if (!upRes.ok) {
    throw new Error(upJson.error ?? `Upload URL request failed (${upRes.status})`);
  }

  const { path, token, publicUrl } = upJson;
  const supabase = createClient();
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .uploadToSignedUrl(path, token, file, { contentType: file.type });
  if (error) throw new Error(error.message);

  return publicUrl as string;
}

/**
 * Uploads many photos with a small concurrency cap. Resolves with the public
 * URLs that succeeded and a list of human-readable errors for those that
 * didn't, calling `onProgress` after each completion so callers can show a
 * count. Never rejects.
 */
export async function uploadTrainingPhotos(
  modelId: string,
  files: File[],
  {
    concurrency = 4,
    onProgress,
  }: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ urls: string[]; errors: string[] }> {
  const urls: string[] = [];
  const errors: string[] = [];
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < files.length) {
      const i = next++;
      try {
        urls.push(await uploadTrainingPhoto(modelId, files[i]));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        errors.push(`${files[i].name}: ${msg}`);
      } finally {
        done++;
        onProgress?.(done, files.length);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker)
  );
  return { urls, errors };
}
