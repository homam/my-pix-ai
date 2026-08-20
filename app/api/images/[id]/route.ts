import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { storagePathFromUrl, STORAGE_BUCKET } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";

// Deletes a single generated image: removes the mirrored storage object (if
// it's one of ours), clears it as a model cover if set, then deletes the row.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const log = makeLogger("api/images/[id]/delete");
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    log.warn("unauthorized");
    return NextResponse.json(
      { error: "Unauthorized", reqId: log.reqId },
      { status: 401 }
    );
  }

  // Ownership is enforced by RLS, but select explicitly so we can 404 cleanly
  // and learn the url/model for cleanup.
  const { data: image, error: imgErr } = await supabase
    .from("generated_images")
    .select("id, url, model_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (imgErr || !image) {
    log.warn("image_not_found", { userId: user.id, imageId: id });
    return NextResponse.json(
      { error: "Image not found", reqId: log.reqId },
      { status: 404 }
    );
  }

  const svc = await createServiceClient();

  // Remove the mirrored storage object if the url points at our bucket AND at
  // this caller's own folder. `generated_images.url` is service-role-written
  // today (authenticated has SELECT only), so the prefix check is redundant —
  // but a storage path built out of a row value is exactly the shape that goes
  // wrong the day a grant widens, and re-deriving the owner from the session is
  // free. Same reasoning as lib/identity.ts.
  const path = storagePathFromUrl(image.url);
  if (path && !path.startsWith(`${user.id}/`)) {
    log.warn("image_url_outside_owner_tree", { userId: user.id, imageId: id, path });
  } else if (path) {
    try {
      await svc.storage.from(STORAGE_BUCKET).remove([path]);
    } catch (err) {
      log.error("storage_remove_failed", { userId: user.id, path, ...errInfo(err) });
    }
  }

  // If this image was the model's cover, clear it so the card doesn't 404.
  // Studio edits can have no model (model_id null) — nothing to clear then.
  if (image.model_id) {
    await svc
      .from("models")
      .update({ cover_image_url: null })
      .eq("id", image.model_id)
      .eq("cover_image_url", image.url);
  }

  const { error: delErr } = await svc
    .from("generated_images")
    .delete()
    .eq("id", id);

  if (delErr) {
    log.error("image_delete_failed", {
      userId: user.id,
      imageId: id,
      pgCode: delErr.code,
      pgMessage: delErr.message,
    });
    return NextResponse.json(
      { error: "Failed to delete image", reqId: log.reqId },
      { status: 500 }
    );
  }

  log.info("image_deleted", { userId: user.id, imageId: id });
  return NextResponse.json({ ok: true, reqId: log.reqId });
}
