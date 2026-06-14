import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { deleteUserStorage } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";

// Permanently delete the signed-in user's account. Deleting the auth.users row
// cascades to every table FK'd to it (models, generated_images, credits,
// transactions, shares). Storage objects don't cascade, so we clear them first.
export async function DELETE(_req: NextRequest) {
  const log = makeLogger("api/account/delete");

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

  const svc = await createServiceClient();

  // Best-effort storage cleanup of the user's whole tree.
  try {
    const removed = await deleteUserStorage(svc, user.id);
    log.info("storage_cleaned", { userId: user.id, removed });
  } catch (err) {
    log.error("storage_cleanup_failed", { userId: user.id, ...errInfo(err) });
  }

  const { error: delErr } = await svc.auth.admin.deleteUser(user.id);
  if (delErr) {
    log.error("account_delete_failed", { userId: user.id, message: delErr.message });
    return NextResponse.json(
      { error: "Failed to delete account", reqId: log.reqId },
      { status: 500 }
    );
  }

  // Clear the local session cookies so the client is logged out. The user is
  // already gone at this point, so never let a signOut hiccup turn into a 500.
  try {
    await supabase.auth.signOut();
  } catch (err) {
    log.warn("signout_after_delete_failed", errInfo(err));
  }

  log.info("account_deleted", { userId: user.id });
  return NextResponse.json({ ok: true, reqId: log.reqId });
}
