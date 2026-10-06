import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { badRequest, compositeCaller, failure, readJson, unauthorized } from "@/lib/composite/http";
import { loadOwnedGroup, loadSources, syncGroupStatus } from "@/lib/composite/jobs";
import { completeSourcesSchema } from "@/lib/composite/schemas";
import { isOwnCompositePath, objectSize } from "@/lib/composite/storage";

// POST /api/composites/[id]/sources/complete — the browser says these uploads
// finished; believe storage, not the browser. A source becomes "uploaded" only
// when every object it names is really there, and its byte size is read back.

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/[id]/sources/complete");
  const { id: groupId } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const parsed = completeSourcesSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(log, "Invalid request", parsed.error.flatten());
  const { serviceClient, user } = caller;

  try {
    await loadOwnedGroup(serviceClient, user.id, groupId);
    const sources = (await loadSources(serviceClient, groupId)).filter(
      (s) => parsed.data.ids.includes(s.id) && s.status === "pending"
    );
    const missing: string[] = [];
    for (const s of sources) {
      const paths = [...new Set([s.storage_path, s.reference_path])].filter(
        (p): p is string => isOwnCompositePath(p, user.id, groupId)
      );
      const sizes = await Promise.all(paths.map((p) => objectSize(serviceClient, p)));
      if (sizes.some((size) => size === null)) {
        missing.push(s.id);
        continue;
      }
      const original = s.storage_path ? sizes[paths.indexOf(s.storage_path)] : null;
      const { error } = await serviceClient
        .from("composite_sources")
        .update({ status: "uploaded", byte_size: original ?? s.byte_size })
        .eq("id", s.id);
      if (error) throw new Error(`marking ${s.id} uploaded failed: ${error.message}`);
    }
    const status = await syncGroupStatus(serviceClient, groupId);
    log.info("composite_sources_completed", { userId: user.id, groupId, completed: sources.length - missing.length, missing: missing.length });
    return NextResponse.json({ status, missing, reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composite_sources_complete_failed", { userId: user.id, groupId });
  }
}
