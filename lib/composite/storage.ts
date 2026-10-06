// Private storage for composite media. Server-only.
//
// Unlike the public `mypix` bucket (Astria must fetch training photos without
// credentials), this bucket has NO storage.objects policies for anon or
// authenticated — platform migration 0028. Nothing reads or writes it except:
//   - the browser, through a signed UPLOAD url this module mints after the route
//     has proved the caller owns the group (the path is built here, never taken
//     from the request);
//   - the browser and the image provider, through short-lived signed READ urls;
//   - the service role, for renders, exports and cleanup.
// So the owner check lives in the routes, and every path is re-derived from the
// session user id — a stored path is never trusted to name its owner.

import type { SupabaseClient } from "@supabase/supabase-js";

export const COMPOSITE_BUCKET = "mypix-composites";

export type CompositeFolder = "originals" | "refs" | "frames" | "renders" | "exports" | "work";

export function compositePrefix(userId: string, groupId: string): string {
  return `${userId}/composites/${groupId}`;
}

export function compositePath(
  userId: string,
  groupId: string,
  folder: CompositeFolder,
  file: string
): string {
  return `${compositePrefix(userId, groupId)}/${folder}/${file}`;
}

/** True when `path` sits inside this user's tree for this group. */
export function isOwnCompositePath(path: string | null, userId: string, groupId: string): boolean {
  return !!path && path.startsWith(`${compositePrefix(userId, groupId)}/`) && !path.includes("..");
}

export function extFor(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/quicktime":
      return "mov";
    case "video/mp4":
      return "mp4";
    default:
      return "jpg";
  }
}

export interface UploadSlot {
  path: string;
  token: string;
}

export async function signUpload(
  serviceClient: SupabaseClient<any, any, any>,
  path: string
): Promise<UploadSlot> {
  const { data, error } = await serviceClient.storage
    .from(COMPOSITE_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) throw new Error(`createSignedUploadUrl(${path}) failed: ${error?.message}`);
  return { path: data.path, token: data.token };
}

/** Short-lived read URL. `download` names the saved file and forces attachment. */
export async function signRead(
  serviceClient: SupabaseClient<any, any, any>,
  path: string,
  expiresIn: number,
  download?: string
): Promise<string> {
  const { data, error } = await serviceClient.storage
    .from(COMPOSITE_BUCKET)
    .createSignedUrl(path, expiresIn, download ? { download } : undefined);
  if (error || !data) throw new Error(`createSignedUrl(${path}) failed: ${error?.message}`);
  return data.signedUrl;
}

/** Batch form; missing objects come back as null rather than failing the batch. */
export async function signReads(
  serviceClient: SupabaseClient<any, any, any>,
  paths: string[],
  expiresIn: number
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data, error } = await serviceClient.storage
    .from(COMPOSITE_BUCKET)
    .createSignedUrls(unique, expiresIn);
  if (error || !data) throw new Error(`createSignedUrls failed: ${error?.message}`);
  for (const row of data) if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  return out;
}

/** Size of a stored object, or null when it is not there. */
export async function objectSize(
  serviceClient: SupabaseClient<any, any, any>,
  path: string
): Promise<number | null> {
  const { data, error } = await serviceClient.storage.from(COMPOSITE_BUCKET).info(path);
  if (error || !data) return null;
  return typeof data.size === "number" ? data.size : 0;
}

export async function downloadObject(
  serviceClient: SupabaseClient<any, any, any>,
  path: string
): Promise<Buffer> {
  const { data, error } = await serviceClient.storage.from(COMPOSITE_BUCKET).download(path);
  if (error || !data) throw new Error(`download(${path}) failed: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadObject(
  serviceClient: SupabaseClient<any, any, any>,
  path: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const { error } = await serviceClient.storage
    .from(COMPOSITE_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`upload(${path}) failed: ${error.message}`);
}

/**
 * Deletes everything under a group's prefix. Storage `list` is one level deep,
 * so it walks the folders. Returns the number of objects removed.
 */
export async function removeCompositeMedia(
  serviceClient: SupabaseClient<any, any, any>,
  prefix: string
): Promise<number> {
  const bucket = serviceClient.storage.from(COMPOSITE_BUCKET);
  const { data: entries, error } = await bucket.list(prefix, { limit: 1000 });
  if (error || !entries) return 0;
  let removed = 0;
  const files: string[] = [];
  for (const e of entries) {
    if (!e.name) continue;
    const child = `${prefix}/${e.name}`;
    if (e.id === null) removed += await removeCompositeMedia(serviceClient, child);
    else files.push(child);
  }
  for (let i = 0; i < files.length; i += 100) {
    const { data } = await bucket.remove(files.slice(i, i + 100));
    removed += data?.length ?? 0;
  }
  return removed;
}
