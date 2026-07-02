"use client";

import { createClient } from "@/lib/supabase/client";
import { STORAGE_BUCKET } from "@/lib/storage";

/**
 * Uploads a file (or generated blob) straight to Supabase Storage via a
 * signed URL from /api/upload. Returns the public URL Astria can fetch.
 */
export async function uploadFile(
  file: File | Blob,
  filename: string,
  purpose: "edit" | "garment"
): Promise<string> {
  const contentType = file.type || "image/png";

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, contentType, purpose }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error ?? `Upload URL request failed (${res.status})`);
  }

  const supabase = createClient();
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .uploadToSignedUrl(json.path, json.token, file, { contentType });
  if (error) throw new Error(error.message);

  return json.publicUrl as string;
}
