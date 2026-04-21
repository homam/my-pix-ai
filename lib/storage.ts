// Supabase Storage wrapper. Bucket `user-uploads` must exist (created via migration).
import { SupabaseClient } from "@supabase/supabase-js";

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
