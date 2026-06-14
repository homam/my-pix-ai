import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { makeLogger } from "@/lib/log";

// Revoke a public share. The shares_owner_delete RLS policy permits the owner
// to delete their own row, so the authed client is enough.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const log = makeLogger("api/shares/[slug]/delete");
  const { slug } = await params;

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

  const { data: deleted, error: delErr } = await supabase
    .from("shares")
    .delete()
    .eq("slug", slug)
    .eq("user_id", user.id)
    .select("slug");

  if (delErr) {
    log.error("share_delete_failed", {
      userId: user.id,
      slug,
      pgCode: delErr.code,
      pgMessage: delErr.message,
    });
    return NextResponse.json(
      { error: "Failed to revoke share", reqId: log.reqId },
      { status: 500 }
    );
  }
  if (!deleted || deleted.length === 0) {
    log.warn("share_not_found", { userId: user.id, slug });
    return NextResponse.json(
      { error: "Share not found", reqId: log.reqId },
      { status: 404 }
    );
  }

  log.info("share_revoked", { userId: user.id, slug });
  return NextResponse.json({ ok: true, reqId: log.reqId });
}
