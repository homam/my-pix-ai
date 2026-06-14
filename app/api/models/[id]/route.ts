import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { deleteModelStorage } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";

// Deleting a model cascades (via FK ON DELETE CASCADE) to model_images,
// generated_images and shares. Storage objects do NOT cascade, so we clean
// them up explicitly with the service client.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const log = makeLogger("api/models/[id]/delete");
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

  // Verify ownership before deleting anything.
  const { data: model, error: modelErr } = await supabase
    .from("models")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (modelErr || !model) {
    log.warn("model_not_found", { userId: user.id, modelId: id });
    return NextResponse.json(
      { error: "Model not found", reqId: log.reqId },
      { status: 404 }
    );
  }

  const svc = await createServiceClient();

  // Best-effort storage cleanup — never block the delete on it.
  try {
    const removed = await deleteModelStorage(svc, user.id, id);
    log.info("storage_cleaned", { userId: user.id, modelId: id, removed });
  } catch (err) {
    log.error("storage_cleanup_failed", {
      userId: user.id,
      modelId: id,
      ...errInfo(err),
    });
  }

  const { error: delErr } = await svc.from("models").delete().eq("id", id);
  if (delErr) {
    log.error("model_delete_failed", {
      userId: user.id,
      modelId: id,
      pgCode: delErr.code,
      pgMessage: delErr.message,
    });
    return NextResponse.json(
      { error: "Failed to delete model", reqId: log.reqId },
      { status: 500 }
    );
  }

  log.info("model_deleted", { userId: user.id, modelId: id });
  return NextResponse.json({ ok: true, reqId: log.reqId });
}
