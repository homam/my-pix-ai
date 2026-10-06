import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeProvider } from "@/lib/composite/config";
import { badRequest, compositeCaller, failure, readJson, unauthorized } from "@/lib/composite/http";
import { listGroupCards } from "@/lib/composite/view";
import { createGroupSchema } from "@/lib/composite/schemas";

// GET  /api/composites  — the caller's composite projects, newest first.
// POST /api/composites  — start a new (empty) project; sources come next.

export async function GET() {
  const log = makeLogger("api/composites");
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  try {
    const cards = await listGroupCards(caller.supabase, caller.serviceClient, caller.user.id);
    return NextResponse.json({ composites: cards, reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composites_list_failed", { userId: caller.user.id });
  }
}

export async function POST(req: NextRequest) {
  const log = makeLogger("api/composites");
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  if (!compositeProvider()) {
    return NextResponse.json(
      { error: "Composites are not enabled on this server", code: "composite_disabled", reqId: log.reqId },
      { status: 503 }
    );
  }
  const parsed = createGroupSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(log, "Invalid request", parsed.error.flatten());
  const p = parsed.data;

  const { data: group, error } = await caller.serviceClient
    .from("composite_groups")
    .insert({
      user_id: caller.user.id,
      name: p.name,
      scene_priority: p.scenePriority || null,
      must_preserve: p.mustPreserve ?? [],
      style: p.style ?? "faithful",
      aspect_ratio: p.aspectRatio ?? "16:9",
    })
    .select("*")
    .single();
  if (error || !group) {
    return failure(log, new Error(`creating the composite failed: ${error?.message}`), "composite_create_failed", {
      userId: caller.user.id,
    });
  }
  log.info("composite_created", { userId: caller.user.id, groupId: group.id });
  return NextResponse.json({ group, reqId: log.reqId });
}
