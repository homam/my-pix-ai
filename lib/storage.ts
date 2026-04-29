// Supabase Storage wrapper. Bucket `user-uploads` must exist (created via migration).
import { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const STORAGE_BUCKET = "user-uploads";

export interface SignedUpload {
  path: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
}

/**
 * Creates a signed upload URL for the client to PUT a file directly to
 * Supabase Storage — no bytes pass through our server.
 */
export async function createSignedUpload(
  supabase: SupabaseClient,
  path: string
): Promise<SignedUpload> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new Error(`createSignedUploadUrl failed: ${error?.message}`);
  }

  const { data: pub } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(path);

  return {
    path: data.path,
    token: data.token,
    signedUrl: data.signedUrl,
    publicUrl: pub.publicUrl,
  };
}

export function getPublicUrl(supabase: SupabaseClient, path: string): string {
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Downloads an image from a remote URL and uploads it to our storage bucket.
 * Path layout: {user_id}/generations/{model_id}/{uuid}.{ext}
 * Uses service-role client because it inserts via storage.objects.
 */
export async function mirrorImageToStorage(
  serviceClient: SupabaseClient,
  userId: string,
  modelId: string,
  sourceUrl: string
): Promise<{ path: string; publicUrl: string }> {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Fetch source image failed: ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());

  const ext = (() => {
    if (contentType.includes("png")) return "png";
    if (contentType.includes("webp")) return "webp";
    return "jpg";
  })();

  const id = crypto.randomUUID();
  const path = `${userId}/generations/${modelId}/${id}.${ext}`;

  const { error } = await serviceClient.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = serviceClient.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}

/**
 * Lists uploaded training images for a given model.
 * Returns public URLs (bucket is public so Astria can fetch them).
 */
export async function listModelImages(
  supabase: SupabaseClient,
  userId: string,
  modelId: string
): Promise<string[]> {
  const prefix = `${userId}/${modelId}`;
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(prefix, { limit: 100, sortBy: { column: "created_at", order: "asc" } });

  if (error || !data) return [];

  return data
    .filter((f) => f.name && !f.name.endsWith("/"))
    .map((f) => getPublicUrl(supabase, `${prefix}/${f.name}`));
}
