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
 * Extracts the in-bucket path from a public storage URL, or null if the URL
 * doesn't point at our bucket (e.g. a fallback Astria URL when mirroring
 * failed). Public URLs look like
 * `<base>/storage/v1/object/public/user-uploads/<path>`.
 */
export function storagePathFromUrl(url: string): string | null {
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const path = url.slice(idx + marker.length);
  return path ? decodeURIComponent(path) : null;
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
 * Removes every object under a storage prefix. Recurses one level into
 * subfolders since Storage `list` is not recursive. Best-effort: returns the
 * number of objects removed; never throws (callers treat cleanup as non-fatal).
 *
 * Must be called with a service-role client — there is no DELETE policy on
 * storage.objects for the authenticated role, so RLS would block removals.
 */
export async function removePrefix(
  serviceClient: SupabaseClient,
  prefix: string
): Promise<number> {
  const bucket = serviceClient.storage.from(STORAGE_BUCKET);

  const { data: entries, error } = await bucket.list(prefix, { limit: 1000 });
  if (error || !entries) return 0;

  // Storage returns folders as entries with a null `id`; files have an id.
  const filePaths: string[] = [];
  let removed = 0;
  for (const entry of entries) {
    if (!entry.name) continue;
    const childPath = `${prefix}/${entry.name}`;
    if (entry.id === null) {
      // Subfolder — recurse.
      removed += await removePrefix(serviceClient, childPath);
    } else {
      filePaths.push(childPath);
    }
  }

  if (filePaths.length > 0) {
    const { data: deleted } = await bucket.remove(filePaths);
    removed += deleted?.length ?? 0;
  }
  return removed;
}

/**
 * Deletes all storage objects for a single model: training photos under
 * {userId}/{modelId} and mirrored generations under
 * {userId}/generations/{modelId}.
 */
export async function deleteModelStorage(
  serviceClient: SupabaseClient,
  userId: string,
  modelId: string
): Promise<number> {
  const [training, generations] = await Promise.all([
    removePrefix(serviceClient, `${userId}/${modelId}`),
    removePrefix(serviceClient, `${userId}/generations/${modelId}`),
  ]);
  return training + generations;
}

/**
 * Deletes every storage object owned by a user (their entire {userId}/ tree).
 * Used when deleting an account.
 */
export async function deleteUserStorage(
  serviceClient: SupabaseClient,
  userId: string
): Promise<number> {
  return removePrefix(serviceClient, userId);
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
